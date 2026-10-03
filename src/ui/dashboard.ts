import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { TrackerConfiguration } from '../configuration';
import type { QuotaProviderId, QuotaState } from '../quota/types';
import type { SummaryClient } from '../summary/client';
import type { UsageQuery } from '../summary/types';
import { dashboardHtml } from './html';
import { periodBounds } from '../summary/db/timezone';
import { parseDashboardMessage, type DashboardTab } from './presentation';

export interface DashboardDependencies {
  extensionUri: vscode.Uri;
  summary: SummaryClient;
  settings(): TrackerConfiguration;
  quota(): QuotaState[];
  refreshQuota(provider: QuotaProviderId): Promise<void>;
}

export class Dashboard implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private tab: DashboardTab = 'quota';
  private provider: QuotaProviderId | undefined;
  private query: UsageQuery = { groupBy: 'day', limit: 100, offset: 0 };
  private queryVersion = 0;
  private diagnosticsVersion = 0;
  private fromDay: string | undefined;
  private toDay: string | undefined;
  private refreshPromise: Promise<void> | undefined;
  private readonly unsubscribe: () => void;

  constructor(private readonly dependencies: DashboardDependencies) {
    this.unsubscribe = dependencies.summary.subscribe(progress => this.post({ type: 'progress', progress }));
  }

  open(tab: DashboardTab = 'quota', provider?: QuotaProviderId): void {
    this.tab = tab;
    this.provider = provider;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.navigate();
      return;
    }
    const media = vscode.Uri.joinPath(this.dependencies.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('agentTracker.dashboard', 'Agent Tracker', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media],
    });
    const webview = this.panel.webview;
    webview.html = dashboardHtml(webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.js')).toString(),
      webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.css')).toString(), webview.cspSource, randomBytes(18).toString('base64'));
    this.panel.onDidDispose(() => { this.panel = undefined; this.ready = false; this.queryVersion++; this.diagnosticsVersion++; });
    webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseDashboardMessage(raw);
      if (!message) return;
      void this.handle(message).catch(error => this.error(error));
    });
  }

  update(): void {
    const settings = this.dependencies.settings();
    this.post({ type: 'state', quota: this.dependencies.quota(), percentage: settings.percentage, timezone: settings.timezone, timezoneWarning: settings.timezoneWarning });
  }

  configurationChanged(): void {
    this.update();
    if (this.ready && this.tab === 'usage') void this.loadUsage().catch(error => this.error(error));
  }

  dispose(): void { this.unsubscribe(); this.panel?.dispose(); }

  private async handle(message: NonNullable<ReturnType<typeof parseDashboardMessage>>): Promise<void> {
    switch (message.type) {
      case 'ready': this.ready = true; this.update(); this.navigate(); break;
      case 'tab': this.tab = message.tab; if (this.tab === 'usage') await this.refreshUsage(); else if (this.tab === 'diagnostics') await this.loadDiagnostics(0); break;
      case 'refreshQuota': await this.dependencies.refreshQuota(message.provider); break;
      case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', message.provider ? `@ext:agent-tracker.agent-tracker agentTracker.${message.provider}` : 'agentTracker.display'); break;
      case 'refreshUsage': await this.refreshUsage(); break;
      case 'cancelUsage': this.dependencies.summary.cancel(); break;
      case 'queryUsage': this.query = message.query; this.fromDay = message.fromDay; this.toDay = message.toDay; await this.loadUsage(); break;
      case 'diagnostics': await this.loadDiagnostics(message.offset); break;
    }
  }

  private navigate(): void {
    this.update();
    this.post({ type: 'navigate', tab: this.tab, provider: this.provider });
    if (this.tab === 'usage') void this.refreshUsage().catch(error => this.error(error));
    if (this.tab === 'diagnostics') void this.loadDiagnostics(0).catch(error => this.error(error));
  }

  private async refreshUsage(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.post({ type: 'busy', busy: true });
    this.refreshPromise = (async () => {
      const settings = this.dependencies.settings();
      // The cached page remains visible during this operation.
      const result = await this.dependencies.summary.refresh({ roots: settings.roots, timezone: settings.timezone });
      this.post({ type: 'refreshResult', result });
      await this.loadUsage();
    })().finally(() => {
      this.refreshPromise = undefined;
      this.post({ type: 'busy', busy: false });
    });
    return this.refreshPromise;
  }

  private async loadUsage(): Promise<void> {
    const version = ++this.queryVersion;
    const timezone = this.dependencies.settings().timezone;
    const query = { ...this.query, timezone };
    if (this.fromDay) query.fromMs = periodBounds(this.fromDay, timezone).fromMs;
    if (this.toDay) query.toMs = periodBounds(this.toDay, timezone).toMs;
    if (query.fromMs !== undefined && query.toMs !== undefined && query.fromMs >= query.toMs) throw new Error('조회 시작일은 종료일보다 늦을 수 없습니다.');
    const result = await this.dependencies.summary.query(query);
    if (version === this.queryVersion) this.post({ type: 'usage', result: { ...result, groupBy: this.query.groupBy } });
  }

  private async loadDiagnostics(offset: number): Promise<void> {
    const version = ++this.diagnosticsVersion;
    this.update();
    const result = await this.dependencies.summary.diagnostics({ limit: 100, offset });
    if (version === this.diagnosticsVersion) this.post({ type: 'diagnostics', result, offset });
  }

  private post(message: unknown): void {
    if (this.ready && this.panel) void this.panel.webview.postMessage(message);
  }
  private error(error: unknown): void {
    const message = error instanceof Error ? error.message : '작업에 실패했습니다. Diagnostics에서 처리 상태를 확인해 주세요.';
    this.post({ type: 'error', message });
  }
}
