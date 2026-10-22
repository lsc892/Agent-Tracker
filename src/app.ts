import * as vscode from 'vscode';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setClaudeCleanupPeriod } from './claudeSettings';
import { readConfiguration, type TrackerConfiguration } from './configuration';
import { setLocale, t } from './localization';
import { ClaudeQuotaProvider, CodexQuotaProvider, QuotaService } from './quota';
import { SummaryClient } from './summary/client';
import { ColorSettings } from './ui/colorSettings';
import { Dashboard } from './ui/dashboard';
import { QuotaStatusBar } from './ui/statusBar';

interface ConfigurationChanges {
  cleanup: boolean;
  capabilities: boolean;
  retention: boolean;
  usageSources: boolean;
  providers: boolean;
  pollingInterval: boolean;
}

/** Owns extension services, commands, events and their shutdown order. */
export class AgentTrackerApp {
  private settings: TrackerConfiguration;
  private quota: QuotaService | undefined;
  private summary: SummaryClient | undefined;
  private dashboard: Dashboard | undefined;
  private colorSettings: ColorSettings | undefined;
  private statusBar: QuotaStatusBar | undefined;
  private quotaSubscription: { dispose(): void } | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private configurationQueue = Promise.resolve();
  private clearingData: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.settings = this.readSettings();
  }

  async start(): Promise<void> {
    await this.initializeServices();
    if (this.disposed) return;
    this.context.subscriptions.push({ dispose: () => { void this.dispose(); } });
    this.registerCommands();
    this.registerListeners();
    this.startMonitoring();
  }

  private async initializeServices(): Promise<void> {
    setLocale(this.settings.locale);
    await this.applyClaudeCleanup();
    if (this.disposed) return;
    await mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
    if (this.disposed) return;

    this.quota = this.createQuota();
    this.summary = new SummaryClient({
      dbPath: join(this.context.globalStorageUri.fsPath, 'agent-tracker.sqlite'),
      roots: this.settings.roots,
      timezone: this.settings.timezone,
      collectCapabilities: this.settings.skillsEnabled,
      retainDeletedSourceUsage: this.settings.retainDeletedSourceUsage,
    });
    this.dashboard = this.track(new Dashboard({
      extensionUri: this.context.extensionUri,
      summary: this.summary,
      settings: () => this.settings,
    }));
    this.colorSettings = this.track(new ColorSettings(this.context.extensionUri));
    this.statusBar = this.track(new QuotaStatusBar());
    this.quotaSubscription = this.quota.subscribe(() => this.render());
  }

  private registerCommands(): void {
    // Patched VS Code maps this command to its native ToggleTooltipCommand.
    // The ordinary command remains a click-to-open fallback.
    this.registerCommand('agentTracker.toggleQuotaTooltip', () => vscode.commands.executeCommand('workbench.action.showHover'));
    this.registerCommand('agentTracker.setStatusBarDetail', detail => this.setStatusBarDetail(detail));
    this.registerCommand('agentTracker.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:AgentTracker.agent-tracker'));
    this.registerCommand('agentTracker.configureStatusColor', () => this.colorSettings?.open());
    this.registerCommand('agentTracker.clearUsageData', () => this.clearUsageData());
    this.registerCommand('agentTracker.refreshQuota', () => this.refreshQuota());
    this.registerCommand('agentTracker.openDashboard', argument => this.openDashboard(argument));
    this.registerCommand('agentTracker.openUsage', () => this.openDashboard());
  }

  private registerListeners(): void {
    this.track(vscode.window.onDidChangeWindowState(state => this.quota?.setFocused(state.focused)));
    this.track(vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('agentTracker')) return;
      this.configurationQueue = this.configurationQueue
        .then(() => this.applyConfiguration())
        .catch(() => { void vscode.window.showErrorMessage(t('extension.configurationFailed')); });
    }));
  }

  private startMonitoring(): void {
    this.render();
    this.quota?.start(vscode.window.state.focused);
    // Initialize only the schema. Usage alone requests transcript scans.
    if (this.settings.usageEnabled) {
      void this.summary?.initialize().catch(() => { /* Usage/Diagnostics reports initialization failures when opened. */ });
    }
  }

  private async refreshQuota(): Promise<void> {
    await this.configurationQueue;
    const quota = this.quota;
    if (this.disposed || !quota) return;
    await Promise.all(quota.getStates().map(state => quota.refresh(state.provider, true)));
  }

  private async openDashboard(argument?: unknown): Promise<void> {
    await this.configurationQueue;
    await this.clearingData;
    if (this.disposed) return;
    const value = argument && typeof argument === 'object' ? argument as Record<string, unknown> : {};
    // Legacy quota navigation must not accidentally start a transcript scan.
    if (value.tab === 'quota') return;
    this.dashboard?.open();
  }

  private async setStatusBarDetail(detail: unknown): Promise<void> {
    if (detail !== 'compact' && detail !== 'detailed') return;
    await vscode.workspace.getConfiguration('agentTracker').update('display.detail', detail, vscode.ConfigurationTarget.Global);
  }

  private clearUsageData(): Promise<void> {
    this.clearingData ??= this.clearSummaryData().finally(() => { this.clearingData = undefined; });
    return this.clearingData;
  }

  private async clearSummaryData(): Promise<void> {
    await this.configurationQueue;
    if (this.disposed) return;
    this.dashboard?.close();
    try {
      await this.summary?.clearData();
      void vscode.window.showInformationMessage(t('extension.dataCleared'));
    } catch {
      void vscode.window.showErrorMessage(t('extension.clearFailed'));
    }
  }

  private async applyConfiguration(): Promise<void> {
    if (this.disposed) return;
    const previous = this.settings;
    this.settings = this.readSettings();
    const changes = this.configurationChanges(previous, this.settings);
    setLocale(this.settings.locale);

    if (changes.cleanup) await this.applyClaudeCleanup();
    if (this.disposed) return;
    if (changes.capabilities) await this.summary?.setCapabilityCollectionEnabled(this.settings.skillsEnabled);
    if (this.disposed) return;
    if (changes.retention) await this.summary?.setDeletedSourceRetentionEnabled(this.settings.retainDeletedSourceUsage);
    if (this.disposed) return;
    if (changes.usageSources) {
      this.dashboard?.close();
      await this.summary?.cancelRefresh();
      if (this.disposed) return;
    }
    await this.updateQuota(changes);
    if (this.disposed) return;
    this.render();
    this.colorSettings?.update();
    this.dashboard?.configurationChanged(changes.capabilities && this.settings.skillsEnabled);
  }

  private configurationChanges(previous: TrackerConfiguration, next: TrackerConfiguration): ConfigurationChanges {
    const tracking = previous.claude.enabled !== next.claude.enabled || previous.codex.enabled !== next.codex.enabled;
    return {
      cleanup: previous.claude.cleanupPeriodDays !== next.claude.cleanupPeriodDays || previous.claude.dataHome !== next.claude.dataHome,
      capabilities: previous.skillsEnabled !== next.skillsEnabled,
      retention: previous.retainDeletedSourceUsage !== next.retainDeletedSourceUsage,
      usageSources: previous.usageEnabled !== next.usageEnabled || JSON.stringify(previous.roots) !== JSON.stringify(next.roots),
      providers: tracking || previous.claude.dataHome !== next.claude.dataHome || previous.codex.dataHome !== next.codex.dataHome || previous.codex.executable !== next.codex.executable,
      pollingInterval: previous.pollingSeconds !== next.pollingSeconds,
    };
  }

  private async updateQuota(changes: ConfigurationChanges): Promise<void> {
    if (changes.providers) {
      this.quotaSubscription?.dispose();
      await this.quota?.dispose();
      if (this.disposed) return;
      this.quota = this.createQuota();
      this.quotaSubscription = this.quota.subscribe(() => this.render());
      this.quota.start(vscode.window.state.focused);
    } else {
      if (changes.pollingInterval) this.quota?.setPollingInterval(this.settings.pollingSeconds);
      this.quota?.setRefreshPolicy(this.settings.refreshPolicy);
    }
  }

  private createQuota(): QuotaService {
    const config = this.settings;
    return new QuotaService([
      ...(config.claude.enabled ? [new ClaudeQuotaProvider({ dataHome: config.claude.dataHome })] : []),
      ...(config.codex.enabled ? [new CodexQuotaProvider({ dataHome: config.codex.dataHome, executable: config.codex.executable })] : []),
    ], { pollingSeconds: config.pollingSeconds, refreshPolicy: config.refreshPolicy });
  }

  private readSettings(): TrackerConfiguration {
    return readConfiguration(vscode.workspace.getConfiguration('agentTracker'), vscode.env?.language ?? 'ko');
  }

  private async applyClaudeCleanup(): Promise<void> {
    try {
      await setClaudeCleanupPeriod(this.settings.claude.dataHome, this.settings.claude.cleanupPeriodDays);
    } catch {
      void vscode.window.showErrorMessage(t('extension.cleanupFailed'));
    }
  }

  private render(): void {
    if (this.quota) this.statusBar?.update(this.quota.getStates(), this.settings);
  }

  private registerCommand(name: string, handler: (argument?: unknown) => unknown): void {
    this.track(vscode.commands.registerCommand(name, handler));
  }

  private track<T extends vscode.Disposable>(disposable: T): T {
    this.disposables.push(disposable);
    return disposable;
  }

  dispose(): Promise<void> {
    this.closing ??= this.close();
    return this.closing;
  }

  private async close(): Promise<void> {
    this.disposed = true;
    this.quotaSubscription?.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    await Promise.allSettled([
      this.quota?.dispose(),
      this.summary?.dispose(),
      this.configurationQueue,
      this.clearingData,
    ]);
  }
}
