import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { TrackerConfiguration } from '../configuration';
import type { SummaryClient } from '../summary/client';
import type { UsageQuery } from '../summary/types';
import { dashboardHtml } from './html';
import { periodBounds } from '../summary/db/timezone';
import { parseDashboardMessage, type DashboardTab } from './presentation';

export interface DashboardDependencies {
  extensionUri: vscode.Uri;
  summary: SummaryClient;
  settings(): TrackerConfiguration;
}

export class Dashboard implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private tab: DashboardTab = 'usage';
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

  open(tab: DashboardTab = 'usage'): void {
    if (!this.dependencies.settings().usageEnabled) {
      void vscode.window.showInformationMessage('사용량 통계가 꺼져 있습니다. Agent Tracker 설정에서 켤 수 있습니다.');
      void vscode.commands.executeCommand('agentTracker.openSettings');
      return;
    }
    this.tab = tab;
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
      if (this.panel?.webview !== webview) return;
      const message = parseDashboardMessage(raw);
      if (!message) return;
      void this.handle(message).catch(error => this.error(error));
    });
  }

  update(): void {
    const settings = this.dependencies.settings();
    this.post({ type: 'state', timezone: settings.timezone, timezoneWarning: settings.timezoneWarning, providers: this.providers() });
  }

  configurationChanged(): void {
    this.update();
    if (this.ready && this.tab === 'usage') void this.loadUsage().catch(error => this.error(error));
  }

  close(): void { this.panel?.dispose(); }
  dispose(): void { this.unsubscribe(); this.close(); }

  private async handle(message: NonNullable<ReturnType<typeof parseDashboardMessage>>): Promise<void> {
    if (!this.dependencies.settings().usageEnabled) return;
    switch (message.type) {
      case 'ready': if (!this.ready) { this.ready = true; this.navigate(); } break;
      case 'tab': this.tab = message.tab; if (this.tab === 'usage') await this.loadUsage(); else if (this.tab === 'diagnostics') await this.loadDiagnostics(0); break;
      case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:agent-tracker.agent-tracker agentTracker.usage'); break;
      case 'cancelUsage': this.dependencies.summary.cancel(); break;
      case 'queryUsage': this.query = message.query; this.fromDay = message.fromDay; this.toDay = message.toDay; if (this.ready) await this.loadUsage(); break;
      case 'diagnostics': await this.loadDiagnostics(message.offset); break;
    }
  }

  private navigate(): void {
    if (!this.ready) return;
    this.update();
    this.post({ type: 'navigate', tab: this.tab });
    if (this.tab === 'usage') void this.refreshUsage().catch(error => this.error(error));
    if (this.tab === 'diagnostics') void this.loadDiagnostics(0).catch(error => this.error(error));
  }

  private async refreshUsage(): Promise<void> {
    if (!this.dependencies.settings().usageEnabled) return;
    this.post({ type: 'busy', busy: true });
    if (this.refreshPromise) return this.refreshPromise;
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
    if (!this.dependencies.settings().usageEnabled) return;
    const version = ++this.queryVersion;
    const timezone = this.dependencies.settings().timezone;
    const query = { ...this.query, timezone, providers: this.providers() };
    if (this.fromDay) query.fromMs = periodBounds(this.fromDay, timezone).fromMs;
    if (this.toDay) query.toMs = periodBounds(this.toDay, timezone).toMs;
    if (query.fromMs !== undefined && query.toMs !== undefined && query.fromMs >= query.toMs) throw new Error('조회 시작일은 종료일보다 늦을 수 없습니다.');
    const result = await this.dependencies.summary.query(query);
    if (version === this.queryVersion) this.post({ type: 'usage', result: { ...result, groupBy: this.query.groupBy } });
  }

  private async loadDiagnostics(offset: number): Promise<void> {
    if (!this.dependencies.settings().usageEnabled) return;
    const version = ++this.diagnosticsVersion;
    this.update();
    const result = await this.dependencies.summary.diagnostics({ limit: 100, offset, providers: this.providers() });
    if (version === this.diagnosticsVersion) this.post({ type: 'diagnostics', result, offset });
  }

  private post(message: unknown): void {
    if (this.ready && this.panel) void this.panel.webview.postMessage(message);
  }
  private providers(): ('claude' | 'codex')[] {
    const settings = this.dependencies.settings();
    return (['claude', 'codex'] as const).filter(provider => settings[provider].enabled);
  }
  private error(error: unknown): void {
    const message = error instanceof Error ? error.message : '작업에 실패했습니다. Diagnostics에서 처리 상태를 확인해 주세요.';
    this.post({ type: 'error', message });
  }
}
