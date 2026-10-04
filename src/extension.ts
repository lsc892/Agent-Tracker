import * as vscode from 'vscode';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readConfiguration, type TrackerConfiguration } from './configuration';
import { ClaudeQuotaProvider, CodexQuotaProvider, QuotaService } from './quota';
import { SummaryClient } from './summary/client';
import { Dashboard } from './ui/dashboard';
import { QuotaStatusBar } from './ui/statusBar';
import { QuotaView } from './ui/quotaView';

let shutdown: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let settings = readConfiguration(vscode.workspace.getConfiguration('agentTracker'));
  let disposed = false;
  let configurationQueue = Promise.resolve();
  const createQuota = (config: TrackerConfiguration): QuotaService => new QuotaService([
    new ClaudeQuotaProvider({ dataHome: config.claude.dataHome }),
    new CodexQuotaProvider({ dataHome: config.codex.dataHome, executable: config.codex.executable }),
  ], { pollingSeconds: { claude: config.claude.pollingSeconds, codex: config.codex.pollingSeconds } });
  let quota = createQuota(settings);
  await mkdir(context.globalStorageUri.fsPath, { recursive: true });
  const summary = new SummaryClient({ dbPath: join(context.globalStorageUri.fsPath, 'agent-tracker.sqlite'), roots: settings.roots, timezone: settings.timezone });
  const dashboard = new Dashboard({ extensionUri: context.extensionUri, summary, settings: () => settings });
  const refreshQuota = async (): Promise<void> => {
    await Promise.all([quota.refresh('claude', true), quota.refresh('codex', true)]);
  };
  const quotaView = new QuotaView({ extensionUri: context.extensionUri, settings: () => settings,
    quota: () => quota.getStates(), refresh: refreshQuota, openUsage: () => dashboard.open('usage') });
  const statusBar = new QuotaStatusBar();
  const render = (): void => {
    statusBar.update(quota.getStates(), settings);
    quotaView.update();
  };
  let subscription = quota.subscribe(render);
  const open = (argument?: unknown): void | Promise<void> => {
    const value = argument && typeof argument === 'object' ? argument as Record<string, unknown> : {};
    if (value.tab === 'quota') return quotaView.toggle();
    dashboard.open(value.tab === 'diagnostics' ? 'diagnostics' : 'usage');
  };
  context.subscriptions.push(statusBar, quotaView, dashboard,
    vscode.window.registerWebviewViewProvider('agentTracker.quotaView', quotaView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('agentTracker.toggleQuota', () => quotaView.toggle()),
    vscode.commands.registerCommand('agentTracker.refreshQuota', refreshQuota),
    vscode.commands.registerCommand('agentTracker.openDashboard', open),
    vscode.commands.registerCommand('agentTracker.openUsage', () => dashboard.open('usage')),
    vscode.commands.registerCommand('agentTracker.refreshClaude', () => quota.refresh('claude', true)),
    vscode.commands.registerCommand('agentTracker.refreshCodex', () => quota.refresh('codex', true)),
    vscode.window.onDidChangeWindowState(state => quota.setFocused(state.focused)),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('agentTracker')) return;
      configurationQueue = configurationQueue.then(async () => {
        if (disposed) return;
        const previous = settings;
        settings = readConfiguration(vscode.workspace.getConfiguration('agentTracker'));
        const changedProvider = previous.claude.dataHome !== settings.claude.dataHome || previous.codex.dataHome !== settings.codex.dataHome || previous.codex.executable !== settings.codex.executable;
        if (changedProvider) {
          subscription.dispose();
          await quota.dispose();
          if (disposed) return;
          quota = createQuota(settings);
          subscription = quota.subscribe(render);
          quota.start(vscode.window.state.focused);
        } else {
          if (previous.claude.pollingSeconds !== settings.claude.pollingSeconds) quota.setPollingInterval('claude', settings.claude.pollingSeconds);
          if (previous.codex.pollingSeconds !== settings.codex.pollingSeconds) quota.setPollingInterval('codex', settings.codex.pollingSeconds);
        }
        render();
        dashboard.configurationChanged();
      }).catch(() => { void vscode.window.showErrorMessage('Agent Tracker 설정을 적용하지 못했습니다. 설정 값을 확인해 주세요.'); });
    }),
  );
  shutdown = async () => {
    if (disposed) return;
    disposed = true;
    subscription.dispose();
    statusBar.dispose();
    quotaView.dispose();
    dashboard.dispose();
    await Promise.allSettled([quota.dispose(), summary.dispose(), configurationQueue]);
  };
  render();
  quota.start(vscode.window.state.focused);
  // Initializes only the two-table schema. Transcript scans are exclusively requested by Usage.
  void summary.initialize().catch(() => { /* Usage/Diagnostics reports the initialization failure when opened. */ });
}

export async function deactivate(): Promise<void> {
  await shutdown?.();
  shutdown = undefined;
}
