// 통계·진단 Webview의 요청과 통계 서비스의 조회·갱신을 연결한다.
import { localizationBundle, t } from '../localization';
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

/** 통계·진단 패널의 수명과 조회·갱신 상태를 관리한다. */
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

  /**
   * 책임: 통계가 활성화된 경우에 통계 패널을 생성하거나 재사용한다.
   * 알고리즘: 비활성 상태는 설정으로 안내하고 기존 패널은 다시 진입하며 새 패널은 제한된 자원·메시지 검증·해제 콜백을 연결한다.
   */
  open(): void {
    if (!this.dependencies.settings().usage.enabled) {
      void vscode.window.showInformationMessage(t('dashboard.disabled'));
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
    const message = { type: 'state', localization: localizationBundle(), timezone: settings.usage.timezone, timezoneWarning: settings.usage.timezoneWarning, providers: this.providers(),capabilitiesEnabled:settings.usage.skillsEnabled,showApiCosts:settings.usage.showApiCosts };
    if (this.diagnosticsPanel) this.diagnosticsPanel.title = t('diagnostics.title');
    this.post(message);
    this.postDiagnostics(message);
  }

  configurationChanged(rebuildCapabilities=false): void {
    this.queryVersion++;
    this.update();
    if (rebuildCapabilities && this.ready) {
      void (this.refreshPromise ?? Promise.resolve()).then(()=>{
        if (this.ready && this.dependencies.settings().usage.enabled && this.dependencies.settings().usage.skillsEnabled) return this.refreshUsage();
      }).catch(error=>this.error(error));
      return;
    }
    if (this.ready || this.diagnosticsReady) void this.loadDashboard().catch(error => this.error(error));
  }

  close(): void { this.panel?.dispose(); this.diagnosticsPanel?.dispose(); }
  dispose(): void { this.unsubscribe(); this.close(); }

  /**
   * 책임: 검증된 화면 요청을 통계·설정 동작에 연결한다.
   * 알고리즘: 활성 상태와 ready를 확인해 명령을 분배하고 결제 변경은 현재 선택 세션에만 허용하며 이름 응답은 같은 패널에만 전달한다.
   */
  private async handle(message: NonNullable<ReturnType<typeof parseDashboardMessage>>): Promise<void> {
    if (!this.dependencies.settings().usage.enabled) return;
    switch (message.type) {
      case 'ready':
        if (this.ready) break;
        this.ready = true;
        this.enter();
        break;
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
          if (this.panel === panel) this.post({ type: 'names', kind: message.query.kind, requestId: message.requestId, error: t('dashboard.namesFailed') });
        }
        break;
      }
    }
  }

  /**
   * 책임: 통계 스캔과 독립적으로 진단 패널과 페이지 조회를 관리한다.
   * 알고리즘: 기존 패널은 전면화하고 새 패널에 검증된 메시지 핸들러를 연결해 ready·페이지 이동 시 저장된 진단만 조회한다.
   */
  private openDiagnostics(): void {
    if (!this.dependencies.settings().usage.enabled) return;
    if (this.diagnosticsPanel) {
      this.diagnosticsPanel.reveal(vscode.ViewColumn.Active);
      void this.loadDiagnostics(0).catch(error => this.error(error, true));
      return;
    }
    const media = vscode.Uri.joinPath(this.dependencies.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('agentTracker.diagnostics', t('diagnostics.title'), vscode.ViewColumn.Active, {
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
      if (!message || !this.dependencies.settings().usage.enabled) return;
      this.handleDiagnostics(message);
    });
  }

  private handleDiagnostics(message: NonNullable<ReturnType<typeof parseDashboardMessage>>): void {
    switch (message.type) {
      case 'ready':
        if (this.diagnosticsReady) return;
        this.diagnosticsReady = true;
        void this.loadDiagnostics(0).catch(error => this.error(error, true));
        break;
      case 'diagnostics':
        if (!this.diagnosticsReady) return;
        void this.loadDiagnostics(message.offset).catch(error => this.error(error, true));
        break;
      case 'settings':
        void vscode.commands.executeCommand('agentTracker.openSettings');
        break;
    }
  }

  private enter(): void {
    if (!this.ready) return;
    this.update();
    void this.refreshUsage().catch(error => this.error(error));
  }

  /**
   * 책임: 통계 화면 진입 시 스캔을 합치고 완료 후 조회 결과를 갱신한다.
   * 알고리즘: 진행 중 Promise가 있으면 공유하고 최초 요청만 refresh를 실행하며, 같은 패널이 살아 있을 때만 결과·busy 상태를 전달한다.
   */
  private async refreshUsage(): Promise<void> {
    if (!this.dependencies.settings().usage.enabled) return;
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
      const result = await this.dependencies.summary.refresh({ roots: settings.roots, timezone: settings.usage.timezone });
      if (this.panel !== panel || !this.ready || !this.dependencies.settings().usage.enabled) return;
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

  /**
   * 책임: 현재 설정과 화면 필터에 맞는 최신 통계 페이지만 표시한다.
   * 알고리즘: 날짜를 현지 기간의 UTC 경계로 바꾸고 호스트 설정을 덧씌워 조회한 뒤 요청 버전이 최신일 때만 응답을 보낸다.
   */
  private async loadUsage(): Promise<void> {
    if (!this.ready || !this.dependencies.settings().usage.enabled) return;
    const version = ++this.queryVersion;
    const settings = this.dependencies.settings();
    const timezone = settings.usage.timezone;
    const query = { ...this.query, timezone, providers: this.providers(), includeCosts: settings.usage.showApiCosts,
      excludeEmptyUsage: settings.usage.excludeEmptyUsage };
    if (this.fromDay) query.fromMs = periodBounds(this.fromDay, timezone).fromMs;
    if (this.toDay) query.toMs = periodBounds(this.toDay, timezone).toMs;
    if (query.fromMs !== undefined && query.toMs !== undefined && query.fromMs >= query.toMs) throw new Error(t('dashboard.invalidDateRange'));
    const result = await this.dependencies.summary.query(query);
    if (version === this.queryVersion) this.post({ type: 'usage', result: { ...result, groupBy: this.query.groupBy } });
  }

  private async loadDiagnostics(offset: number): Promise<void> {
    if (!this.diagnosticsReady || !this.dependencies.settings().usage.enabled) return;
    const version = ++this.diagnosticsVersion;
    const settings = this.dependencies.settings();
    this.postDiagnostics({ type: 'state', localization: localizationBundle(), timezone: settings.usage.timezone, timezoneWarning: settings.usage.timezoneWarning });
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
    const message = error instanceof Error ? error.message : t('dashboard.operationFailed');
    if (diagnostics) this.postDiagnostics({ type: 'error', message });
    else this.post({ type: 'error', message });
  }
}
