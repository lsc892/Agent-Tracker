// 통계·진단 Webview의 요청과 통계 서비스의 조회·갱신을 연결한다.
import { localizationBundle, t } from '../localization';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { TrackerConfiguration } from '../configuration';
import type { SummaryClient } from '../summary/client';
import type { UsageQuery, UsageResult } from '../summary/types';
import { dashboardHtml, diagnosticsHtml } from './html';
import { calendarPeriod, periodBounds } from '../summary/db/timezone';
import { parseDashboardMessage, type DashboardMessage } from './presentation';

const DEFAULT_RECENT_DAYS = 30;

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
  private recentDays: 7 | 30 | 90 | undefined = DEFAULT_RECENT_DAYS;
  private refreshPromise: Promise<void> | undefined;
  private recentPreview: UsageResult | undefined;
  private filtersReady = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly dependencies: DashboardDependencies) {
    this.unsubscribe = dependencies.summary.subscribe(({ recentUsage, ...progress }) => {
      // [미리보기 정책] 모든 진행률은 전달하고 최근 사용량은 갱신이 진행 중일 때만 게시한다.
      this.post({ type: 'progress', progress });
      if (recentUsage && this.refreshPromise) {
        this.recentPreview = recentUsage;
        this.postPreview();
      }
    });
  }

  /**
   * 책임: 통계가 활성화된 경우에 통계 패널을 생성하거나 재사용한다.
   * 알고리즘: 비활성 상태는 설정으로 안내하고 기존 패널은 다시 진입하며 새 패널은 제한된 자원·메시지 검증·해제 콜백을 연결한다.
   */
  open(): void {
    // [패널 정책] 통계가 꺼져 있으면 설정으로 안내하고 열린 패널은 다시 사용한다.
    if (!this.dependencies.settings().usage.enabled) {
      void vscode.window.showInformationMessage(t('dashboard.disabled'));
      void vscode.commands.executeCommand('agentTracker.openSettings');
      return;
    }
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      void this.enter().catch(error => this.error(error));
      return;
    }
    // [패널 정책] Webview 리소스는 media 폴더로 제한하고 해제된 패널의 메시지는 무시한다.
    const media = vscode.Uri.joinPath(this.dependencies.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('agentTracker.dashboard', 'Agent Tracker', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media],
    });
    const webview = this.panel.webview;
    webview.html = dashboardHtml(webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.js')).toString(),
      webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.css')).toString(), webview.cspSource, randomBytes(18).toString('base64'));
    this.panel.onDidDispose(() => { this.panel = undefined; this.ready = false; this.filtersReady = false; this.queryVersion++; });
    webview.onDidReceiveMessage((raw: unknown) => {
      if (this.panel?.webview !== webview) return;
      const message = parseDashboardMessage(raw);
      if (!message) return;
      void this.handle(message).catch(error => this.error(error));
    });
  }

  update(): void {
    const settings = this.dependencies.settings();
    const message = {
      type: 'state', localization: localizationBundle(), timezone: settings.usage.timezone,
      timezoneWarning: settings.usage.timezoneWarning, providers: this.providers(),
      capabilitiesEnabled: false, showApiCosts: settings.usage.showApiCosts,
    };
    if (this.diagnosticsPanel) this.diagnosticsPanel.title = t('diagnostics.title');
    this.post(message);
    this.postDiagnostics(message);
  }

  configurationChanged(): void {
    this.queryVersion++;
    this.update();
    if (this.ready || this.diagnosticsReady) void this.loadDashboard().catch(error => this.error(error));
  }

  close(): void { this.panel?.dispose(); this.diagnosticsPanel?.dispose(); }
  dispose(): void { this.unsubscribe(); this.close(); }

  /**
   * 책임: 검증된 화면 요청을 통계·설정 동작에 연결한다.
   * 알고리즘: 활성 상태와 ready를 확인해 명령을 분배하고 결제 변경은 현재 선택 세션에만 허용하며 이름 응답은 같은 패널에만 전달한다.
   */
  private async handle(message: DashboardMessage): Promise<void> {
    if (!this.dependencies.settings().usage.enabled) return;
    // [메시지 정책] 초기화는 한 번만 수행하고 새 필터를 보관한 뒤 준비된 패널에서 조회한다.
    switch (message.type) {
      case 'ready':
        if (this.ready) break;
        this.ready = true;
        await this.enter(true);
        break;
      case 'openDiagnostics': this.openDiagnostics(); break;
      case 'settings': await vscode.commands.executeCommand('agentTracker.openSettings'); break;
      case 'cancelUsage': this.dependencies.summary.cancel(); break;
      case 'retryUsage':
        if (!this.filtersReady && !this.refreshPromise) await this.refreshUsage();
        break;
      case 'setSessionBilling': await this.setSelectedSessionBilling(message); break;
      case 'queryUsage':
        this.query = message.query;
        this.fromDay = message.fromDay;
        this.toDay = message.toDay;
        this.recentDays = message.recentDays;
        if (this.ready) await this.loadUsage();
        break;
      case 'queryNames': await this.loadNames(message); break;
    }
  }

  /** 화면에서 선택한 활성 제공자의 세션만 결제 방식을 변경할 수 있다. */
  private async setSelectedSessionBilling(message: Extract<DashboardMessage, { type: 'setSessionBilling' }>): Promise<void> {
    // [결제 정책] 활성 제공자와 현재 선택한 세션이 모두 일치할 때만 결제 방식을 저장한다.
    if (!this.filtersReady || !this.providers().includes(message.provider)
      || this.query.provider !== message.provider || this.query.sessionId !== message.sessionId) return;
    await this.dependencies.summary.setSessionBilling(message.provider, message.sessionId, message.mode);
    if (this.ready) await this.loadUsage();
  }

  /** 이름 검색의 성공·실패 응답은 요청을 보낸 패널에만 전달한다. */
  private async loadNames(message: Extract<DashboardMessage, { type: 'queryNames' }>): Promise<void> {
    if (!this.filtersReady) return;
    // [응답 정책] 활성 제공자로 이름 조회를 제한하고 요청을 보낸 패널이 유지될 때만 응답한다.
    const panel = this.panel;
    try {
      const result = await this.dependencies.summary.queryNames({ ...message.query, providers: this.providers() });
      if (this.panel === panel && this.filtersReady)
        this.post({ type: 'names', kind: message.query.kind, requestId: message.requestId, offset: message.query.offset, result });
    } catch {
      if (this.panel === panel) this.post({ type: 'names', kind: message.query.kind, requestId: message.requestId, error: t('dashboard.namesFailed') });
    }
  }

  /**
   * 책임: 통계 스캔과 독립적으로 진단 패널과 페이지 조회를 관리한다.
   * 알고리즘: 기존 패널은 전면화하고 새 패널에 검증된 메시지 핸들러를 연결해 ready·페이지 이동 시 저장된 진단만 조회한다.
   */
  private openDiagnostics(): void {
    if (!this.dependencies.settings().usage.enabled) return;
    // [패널 정책] 열린 진단 패널은 첫 페이지를 다시 읽고 새 패널은 준비 메시지를 기다린다.
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

  private handleDiagnostics(message: DashboardMessage): void {
    // [메시지 정책] 준비 신호에서 첫 페이지를 불러오고 이후에만 페이지 이동을 처리한다.
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

  private async enter(newWebview = false): Promise<void> {
    if (!this.ready) return;
    this.update();
    await this.refreshUsage(newWebview);
  }

  /**
   * 책임: 통계 화면 진입 시 스캔을 합치고 완료 후 조회 결과를 갱신한다.
   * 알고리즘: 진행 중 Promise를 공유하고 영속 갱신 성공 뒤에만 필터를 열고 현재 조회를 실행한다.
   */
  private async refreshUsage(newWebview = false): Promise<void> {
    if (!this.ready || !this.dependencies.settings().usage.enabled) return;

    // [갱신 정책] 새 패널에서도 진행 중인 스캔과 미리보기를 공유한다.
    if (this.refreshPromise) {
      if (newWebview) {
        this.post({ type: 'busy', busy: true });
        this.postPreview();
      }
      return this.refreshPromise;
    }

    // [갱신 정책] 기존 조회를 무효화하고 최근 사용량 미리보기와 전체 스캔을 요청한다.
    this.filtersReady = false;
    this.queryVersion++;
    this.post({ type: 'busy', busy: true });
    this.refreshPromise = (async () => {
      const settings = this.dependencies.settings();
      const timezone = settings.usage.timezone;
      const { fromDay, toDay } = recentCalendarDays(DEFAULT_RECENT_DAYS, timezone);
      const result = await this.dependencies.summary.refresh({
        roots: settings.roots, timezone, recentUsage: {
          fromMs: periodBounds(fromDay, timezone).fromMs, toMs: periodBounds(toDay, timezone).toMs,
          providers: this.providers(), includeCosts: settings.usage.showApiCosts,
          excludeEmptyUsage: settings.usage.excludeEmptyUsage,
        },
      });

      // [갱신 정책] 스캔 결과를 알리고 실패나 중단이 없을 때만 필터를 활성화한다.
      if (!this.ready || !this.dependencies.settings().usage.enabled) return;
      this.post({ type: 'refreshResult', result });
      if (!result.interrupted && !result.failed) {
        this.filtersReady = true;
        this.post({ type: 'filtersReady' });
      }
      void this.loadDashboard().catch(error => this.error(error));
    })().finally(() => {
      // [갱신 정책] 갱신 종료 시 진행 상태와 임시 미리보기를 정리한다.
      this.refreshPromise = undefined;
      this.recentPreview = undefined;
      this.post({ type: 'busy', busy: false });
    });
    return this.refreshPromise;
  }

  private postPreview(): void {
    if (this.recentPreview) this.post({ type: 'previewUsage', result: { ...this.recentPreview, groupBy: 'day' } });
  }

  private async loadDashboard(): Promise<void> {
    await Promise.all([this.loadUsage(), this.loadDiagnostics(0).catch(error => this.error(error, true))]);
  }

  /**
   * 책임: 현재 설정과 화면 필터에 맞는 최신 통계 페이지만 표시한다.
   * 알고리즘: 날짜를 현지 기간의 UTC 경계로 바꾸고 호스트 설정을 덧씌워 조회한 뒤 요청 버전이 최신일 때만 응답을 보낸다.
   */
  private async loadUsage(): Promise<void> {
    if (!this.filtersReady || !this.dependencies.settings().usage.enabled) return;
    // [조회 정책] 현재 UI 필터에 호스트의 시간대·제공자·비용·빈 사용량 설정을 적용한다.
    const version = ++this.queryVersion;
    const settings = this.dependencies.settings();
    const timezone = settings.usage.timezone;
    const query: UsageQuery = { ...this.query, timezone, providers: this.providers(), includeCosts: settings.usage.showApiCosts,
      excludeEmptyUsage: settings.usage.excludeEmptyUsage };
    // [기간 정책] 최근 기간은 현지 달력 날짜로 계산하고 일자 경계를 밀리초로 변환한다.
    let fromDay = this.fromDay;
    let toDay = this.toDay;
    if (this.recentDays !== undefined) {
      ({ fromDay, toDay } = recentCalendarDays(this.recentDays, timezone));
      if (this.recentDays === DEFAULT_RECENT_DAYS) query.unknownTime = 'exclude';
    }
    if (fromDay) query.fromMs = periodBounds(fromDay, timezone).fromMs;
    if (toDay) query.toMs = periodBounds(toDay, timezone).toMs;
    if (query.fromMs !== undefined && query.toMs !== undefined && query.fromMs >= query.toMs) throw new Error(t('dashboard.invalidDateRange'));

    // [응답 정책] 조회 시작 때의 버전이 최신일 때만 결과를 반영한다.
    const result = await this.dependencies.summary.query(query);
    if (version === this.queryVersion) this.post({ type: 'usage', result: { ...result, groupBy: query.groupBy } });
  }

  private async loadDiagnostics(offset: number): Promise<void> {
    if (!this.diagnosticsReady || !this.dependencies.settings().usage.enabled) return;
    // [응답 정책] 활성 제공자의 진단을 페이지 단위로 읽고 최신 진단 요청의 결과만 보낸다.
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

function recentCalendarDays(days: number, timezone: string): { fromDay: string; toDay: string } {
  // [기간 정책] 통계 시간대의 오늘을 포함하고 달력 날짜를 기준으로 시작일을 거슬러 계산한다.
  const toDay = calendarPeriod(Date.now(), timezone, 'day');
  const start = new Date(`${toDay}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { fromDay: start.toISOString().slice(0, 10), toDay };
}
