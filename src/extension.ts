import * as vscode from 'vscode';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readConfiguration, type TrackerConfiguration } from './configuration';
import { ClaudeQuotaProvider, CodexQuotaProvider, QuotaService } from './quota';
import type { QuotaProviderId } from './quota/types';
import { SummaryClient } from './summary/client';
import { Dashboard } from './ui/dashboard';
import { statusPresentation, type DashboardTab } from './ui/presentation';

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
  const dashboard = new Dashboard({ extensionUri: context.extensionUri, summary, settings: () => settings,
    quota: () => quota.getStates(), refreshQuota: provider => quota.refresh(provider, true) });
  const claude = vscode.window.createStatusBarItem('agentTracker.claudeQuota', vscode.StatusBarAlignment.Right, 100);
  const codex = vscode.window.createStatusBarItem('agentTracker.codexQuota', vscode.StatusBarAlignment.Right, 99);
  const statusItems = { claude, codex };
  for (const provider of ['claude', 'codex'] as const) {
    const name = provider === 'claude' ? 'Claude' : 'Codex';
    const item = statusItems[provider];
    item.name = `Agent Tracker: ${name}`;
    item.tooltip = `클릭하여 ${name} 사용량 보기`;
    item.command = { command: 'agentTracker.openDashboard', title: `${name} 사용량 보기`, arguments: [{ tab: 'quota', provider }] };
  }
  const render = (): void => {
    for (const provider of ['claude', 'codex'] as const) {
      const item = statusItems[provider];
      const view = statusPresentation(quota.getState(provider), settings.percentage, settings.detail);
      item.text = view.text;
      item.backgroundColor = view.warning ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
      if (settings[provider].showStatusBar) item.show(); else item.hide();
    }
    dashboard.update();
  };
  let subscription = quota.subscribe(render);
  const open = (argument?: unknown): void => {
    const value = argument && typeof argument === 'object' ? argument as Record<string, unknown> : {};
    const tab: DashboardTab = value.tab === 'usage' || value.tab === 'diagnostics' ? value.tab : 'quota';
    const provider: QuotaProviderId | undefined = value.provider === 'claude' || value.provider === 'codex' ? value.provider : undefined;
    dashboard.open(tab, provider);
  };
  context.subscriptions.push(claude, codex, dashboard,
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
