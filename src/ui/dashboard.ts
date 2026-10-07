import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { TrackerConfiguration } from '../configuration';
import type { SummaryClient } from '../summary/client';
import type { UsageQuery } from '../summary/types';
import { dashboardHtml, diagnosticsHtml } from './html';
import { periodBounds } from '../summary/db/timezone';
import { parseDashboardMessage } from './presentation';

export interface DashboardDependencies {
  extensionUri: vscode.Uri;
  summary: SummaryClient;
  settings(): TrackerConfiguration;
}

export class Dashboard implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private diagnosticsPanel: vscode.WebviewPanel | undefined;
  private ready = false;
  private diagnosticsReady = false;
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

  open(): void {
    if (!this.dependencies.settings().usageEnabled) {
      void vscode.window.showInformationMessage('사용량 통계가 꺼져 있습니다. Agent Tracker 설정에서 켤 수 있습니다.');
      void vscode.commands.executeCommand('agentTracker.openSettings');
      return;
    }
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.enter();
      return;
    }
    const media = vscode.Uri.joinPath(this.dependencies.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('agentTracker.dashboard', 'Agent Tracker', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media],
    });
    const webview = this.panel.webview;
    webview.html = dashboardHtml(webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.js')).toString(),
      webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.css')).toString(), webview.cspSource, randomBytes(18).toString('base64'));
    this.panel.onDidDispose(() => { this.panel = undefined; this.ready = false; this.queryVersion++; });
    webview.onDidReceiveMessage((raw: unknown) => {
      if (this.panel?.webview !== webview) return;
      const message = parseDashboardMessage(raw);
      if (!message) return;
      void this.handle(message).catch(error => this.error(error));
    });
  }

  update(): void {
    const settings = this.dependencies.settings();
    const message = { type: 'state', timezone: settings.timezone, timezoneWarning: settings.timezoneWarning, providers: this.providers(),capabilitiesEnabled:settings.skillsEnabled,showApiCosts:settings.showApiCosts };
    this.post(message);
    this.postDiagnostics(message);
  }

  configurationChanged(rebuildCapabilities=false): void {
    this.queryVersion++;
    this.update();
    if (rebuildCapabilities && this.ready) {
      void (this.refreshPromise ?? Promise.resolve()).then(()=>{
        if (this.ready && this.dependencies.settings().usageEnabled && this.dependencies.settings().skillsEnabled) return this.refreshUsage();
      }).catch(error=>this.error(error));
      return;
    }
    if (this.ready || this.diagnosticsReady) void this.loadDashboard().catch(error => this.error(error));
  }

  close(): void { this.panel?.dispose(); this.diagnosticsPanel?.dispose(); }
  dispose(): void { this.unsubscribe(); this.close(); }

  private async handle(message: NonNullable<ReturnType<typeof parseDashboardMessage>>): Promise<void> {
    if (!this.dependencies.settings().usageEnabled) return;
    switch (message.type) {
      case 'ready': if (!this.ready) { this.ready = true; this.enter(); } break;
      case 'openDiagnostics': this.openDiagnostics(); break;
      case 'settings': await vscode.commands.executeCommand('agentTracker.openSettings'); break;
      case 'cancelUsage': this.dependencies.summary.cancel(); break;
      case 'setSessionBilling': {
        if (!this.ready || !this.providers().includes(message.provider) || this.query.provider !== message.provider || this.query.sessionId !== message.sessionId) break;
        await this.dependencies.summary.setSessionBilling(message.provider,message.sessionId,message.mode);
        if (this.ready) await this.loadUsage();
        break;
      }
      case 'queryUsage': this.query = message.query; this.fromDay = message.fromDay; this.toDay = message.toDay; if (this.ready) await this.loadUsage(); break;
      case 'queryNames': {
        if (!this.ready) break;
        const panel = this.panel;
        try {
          const result = await this.dependencies.summary.queryNames({ ...message.query, providers: this.providers() });
          if (this.panel === panel) this.post({ type: 'names', kind: message.query.kind, requestId: message.requestId, offset: message.query.offset, result });
        } catch {
          if (this.panel === panel) this.post({ type: 'names', kind: message.query.kind, requestId: message.requestId, error: '이름 목록을 불러오지 못했습니다. 다시 열어 주세요.' });
        }
        break;
      }
    }
  }

  private openDiagnostics(): void {
    if (!this.dependencies.settings().usageEnabled) return;
    if (this.diagnosticsPanel) {
      this.diagnosticsPanel.reveal(vscode.ViewColumn.Active);
      void this.loadDiagnostics(0).catch(error => this.error(error, true));
      return;
    }
    const media = vscode.Uri.joinPath(this.dependencies.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('agentTracker.diagnostics', 'Agent Tracker 데이터 확인', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media],
    });
    this.diagnosticsPanel = panel;
    const webview = panel.webview;
    webview.html = diagnosticsHtml(webview.asWebviewUri(vscode.Uri.joinPath(media, 'diagnostics.js')).toString(),
      webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.css')).toString(), webview.cspSource, randomBytes(18).toString('base64'));
    panel.onDidDispose(() => { this.diagnosticsPanel = undefined; this.diagnosticsReady = false; this.diagnosticsVersion++; });
    webview.onDidReceiveMessage((raw: unknown) => {
      if (this.diagnosticsPanel !== panel) return;
      const message = parseDashboardMessage(raw);
      if (!message || !this.dependencies.settings().usageEnabled) return;
      if (message.type === 'ready') {
        if (this.diagnosticsReady) return;
        this.diagnosticsReady = true;
        void this.loadDiagnostics(0).catch(error => this.error(error, true));
      } else if (message.type === 'diagnostics' && this.diagnosticsReady) {
        void this.loadDiagnostics(message.offset).catch(error => this.error(error, true));
      } else if (message.type === 'settings') {
        void vscode.commands.executeCommand('agentTracker.openSettings');
      }
    });
  }

  private enter(): void {
    if (!this.ready) return;
    this.update();
    void this.refreshUsage().catch(error => this.error(error));
  }

  private async refreshUsage(): Promise<void> {
    if (!this.dependencies.settings().usageEnabled) return;
    this.post({ type: 'busy', busy: true });
    const panel = this.panel;
    if (this.refreshPromise) {
      try {
        await this.refreshPromise;
        if (this.panel === panel && this.ready) await this.loadDashboard();
      } finally {
        if (this.panel === panel) this.post({ type: 'busy', busy: false });
      }
      return;
    }
    this.refreshPromise = (async () => {
      const settings = this.dependencies.settings();
      // The cached page remains visible during this operation.
      const result = await this.dependencies.summary.refresh({ roots: settings.roots, timezone: settings.timezone });
      if (this.panel !== panel || !this.ready || !this.dependencies.settings().usageEnabled) return;
      this.post({ type: 'refreshResult', result });
      await this.loadDashboard();
    })().finally(() => {
      this.refreshPromise = undefined;
      if (this.panel === panel) this.post({ type: 'busy', busy: false });
    });
    return this.refreshPromise;
  }

  private async loadDashboard(): Promise<void> {
    await Promise.all([this.loadUsage(), this.loadDiagnostics(0).catch(error => this.error(error, true))]);
  }

  private async loadUsage(): Promise<void> {
    if (!this.ready || !this.dependencies.settings().usageEnabled) return;
    const version = ++this.queryVersion;
    const settings = this.dependencies.settings();
    const timezone = settings.timezone;
    const query = { ...this.query, timezone, providers: this.providers(), includeCosts: settings.showApiCosts };
    if (this.fromDay) query.fromMs = periodBounds(this.fromDay, timezone).fromMs;
    if (this.toDay) query.toMs = periodBounds(this.toDay, timezone).toMs;
    if (query.fromMs !== undefined && query.toMs !== undefined && query.fromMs >= query.toMs) throw new Error('조회 시작일은 종료일보다 늦을 수 없습니다.');
    const result = await this.dependencies.summary.query(query);
    if (version === this.queryVersion) this.post({ type: 'usage', result: { ...result, groupBy: this.query.groupBy } });
  }

  private async loadDiagnostics(offset: number): Promise<void> {
    if (!this.diagnosticsReady || !this.dependencies.settings().usageEnabled) return;
    const version = ++this.diagnosticsVersion;
    const settings = this.dependencies.settings();
    this.postDiagnostics({ type: 'state', timezone: settings.timezone, timezoneWarning: settings.timezoneWarning });
    const result = await this.dependencies.summary.diagnostics({ limit: 100, offset, providers: this.providers() });
    if (version === this.diagnosticsVersion) this.postDiagnostics({ type: 'diagnostics', result, offset });
  }

  private post(message: unknown): void {
    if (this.ready && this.panel) void this.panel.webview.postMessage(message);
  }
  private postDiagnostics(message: unknown): void {
    if (this.diagnosticsReady && this.diagnosticsPanel) void this.diagnosticsPanel.webview.postMessage(message);
  }
  private providers(): ('claude' | 'codex')[] {
    const settings = this.dependencies.settings();
    return (['claude', 'codex'] as const).filter(provider => settings[provider].enabled);
  }
  private error(error: unknown, diagnostics = false): void {
    const message = error instanceof Error ? error.message : '작업에 실패했습니다. 데이터 확인 화면에서 처리 상태를 확인해 주세요.';
    if (diagnostics) this.postDiagnostics({ type: 'error', message });
    else this.post({ type: 'error', message });
  }
}
