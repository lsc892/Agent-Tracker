import { setLocale, t } from './localization';
import * as vscode from 'vscode';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readConfiguration, type TrackerConfiguration } from './configuration';
import { ClaudeQuotaProvider, CodexQuotaProvider, QuotaService } from './quota';
import { SummaryClient } from './summary/client';
import { Dashboard } from './ui/dashboard';
import { QuotaStatusBar } from './ui/statusBar';
import { ColorSettings } from './ui/colorSettings';
import { setClaudeCleanupPeriod } from './claudeSettings';

let shutdown: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let settings = readConfiguration(vscode.workspace.getConfiguration('agentTracker'), vscode.env?.language ?? 'ko');
  setLocale(settings.locale);
  const applyClaudeCleanup = async (): Promise<void> => {
    try { await setClaudeCleanupPeriod(settings.claude.dataHome, settings.claude.cleanupPeriodDays); }
    catch { void vscode.window.showErrorMessage(t('extension.cleanupFailed')); }
  };
  await applyClaudeCleanup();
  let disposed = false;
  let configurationQueue = Promise.resolve();
  let clearingData: Promise<void> | undefined;
  const createQuota = (config: TrackerConfiguration): QuotaService => new QuotaService([
    ...(config.claude.enabled ? [new ClaudeQuotaProvider({ dataHome: config.claude.dataHome })] : []),
    ...(config.codex.enabled ? [new CodexQuotaProvider({ dataHome: config.codex.dataHome, executable: config.codex.executable })] : []),
  ], { pollingSeconds: config.pollingSeconds, refreshPolicy: config.refreshPolicy });
  let quota = createQuota(settings);
  await mkdir(context.globalStorageUri.fsPath, { recursive: true });
  const summary = new SummaryClient({ dbPath: join(context.globalStorageUri.fsPath, 'agent-tracker.sqlite'), roots: settings.roots, timezone: settings.timezone, collectCapabilities:settings.skillsEnabled });
  const dashboard = new Dashboard({ extensionUri: context.extensionUri, summary, settings: () => settings });
  const colorSettings = new ColorSettings(context.extensionUri);
  const refreshQuota = async (): Promise<void> => {
    await configurationQueue;
    if (!disposed) await Promise.all(quota.getStates().map(state => quota.refresh(state.provider, true)));
  };
  const statusBar = new QuotaStatusBar();
  const render = (): void => statusBar.update(quota.getStates(), settings);
  let subscription = quota.subscribe(render);
  const open = async (argument?: unknown): Promise<void> => {
    await configurationQueue;
    await clearingData;
    if (disposed) return;
    const value = argument && typeof argument === 'object' ? argument as Record<string, unknown> : {};
    // Legacy quota navigation must not accidentally start a transcript scan.
    if (value.tab === 'quota') return;
    dashboard.open();
  };
  context.subscriptions.push(statusBar, dashboard, colorSettings,
    // Patched VS Code maps this command to its native ToggleTooltipCommand before
    // command dispatch. The ordinary command remains a click-to-open fallback.
    vscode.commands.registerCommand('agentTracker.toggleQuotaTooltip', () => vscode.commands.executeCommand('workbench.action.showHover')),
    vscode.commands.registerCommand('agentTracker.setStatusBarDetail', async (detail: unknown) => {
      if (detail !== 'compact' && detail !== 'detailed') return;
      await vscode.workspace.getConfiguration('agentTracker').update('display.detail', detail, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('agentTracker.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:AgentTracker.agent-tracker')),
    vscode.commands.registerCommand('agentTracker.configureStatusColor', () => colorSettings.open()),
    vscode.commands.registerCommand('agentTracker.clearUsageData', () => {
      clearingData ??= (async () => {
        await configurationQueue;
        if (disposed) return;
        dashboard.close();
        try {
          await summary.clearData();
          void vscode.window.showInformationMessage(t('extension.dataCleared'));
        } catch {
          void vscode.window.showErrorMessage(t('extension.clearFailed'));
        }
      })().finally(() => { clearingData = undefined; });
      return clearingData;
    }),
    vscode.commands.registerCommand('agentTracker.refreshQuota', refreshQuota),
    vscode.commands.registerCommand('agentTracker.openDashboard', open),
    vscode.commands.registerCommand('agentTracker.openUsage', () => open()),
    vscode.window.onDidChangeWindowState(state => quota.setFocused(state.focused)),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('agentTracker')) return;
      configurationQueue = configurationQueue.then(async () => {
        if (disposed) return;
        const previous = settings;
        settings = readConfiguration(vscode.workspace.getConfiguration('agentTracker'), vscode.env?.language ?? 'ko');
        setLocale(settings.locale);
        if (previous.claude.cleanupPeriodDays !== settings.claude.cleanupPeriodDays || previous.claude.dataHome !== settings.claude.dataHome) await applyClaudeCleanup();
        const changedSkills=previous.skillsEnabled!==settings.skillsEnabled;
        if (changedSkills) {
          await summary.setCapabilityCollectionEnabled(settings.skillsEnabled);
          if (disposed) return;
        }
        const changedTracking = previous.claude.enabled !== settings.claude.enabled || previous.codex.enabled !== settings.codex.enabled;
        if (previous.usageEnabled !== settings.usageEnabled || JSON.stringify(previous.roots) !== JSON.stringify(settings.roots)) {
          dashboard.close();
          await summary.cancelRefresh();
          if (disposed) return;
        }
        const changedProvider = changedTracking || previous.claude.dataHome !== settings.claude.dataHome || previous.codex.dataHome !== settings.codex.dataHome || previous.codex.executable !== settings.codex.executable;
        if (changedProvider) {
          subscription.dispose();
          await quota.dispose();
          if (disposed) return;
          quota = createQuota(settings);
          subscription = quota.subscribe(render);
          quota.start(vscode.window.state.focused);
        } else {
          if (previous.pollingSeconds !== settings.pollingSeconds) quota.setPollingInterval(settings.pollingSeconds);
          quota.setRefreshPolicy(settings.refreshPolicy);
        }
        render();
        colorSettings.update();
        dashboard.configurationChanged(changedSkills && settings.skillsEnabled);
      }).catch(() => { void vscode.window.showErrorMessage(t('extension.configurationFailed')); });
    }),
  );
  shutdown = async () => {
    if (disposed) return;
    disposed = true;
    subscription.dispose();
    statusBar.dispose();
    dashboard.dispose();
    colorSettings.dispose();
    await Promise.allSettled([quota.dispose(), summary.dispose(), configurationQueue, clearingData]);
  };
  render();
  quota.start(vscode.window.state.focused);
  // Initializes only the schema. Transcript scans are exclusively requested by Usage.
  if (settings.usageEnabled) void summary.initialize().catch(() => { /* Usage/Diagnostics reports the initialization failure when opened. */ });
}

export async function deactivate(): Promise<void> {
  await shutdown?.();
  shutdown = undefined;
}
