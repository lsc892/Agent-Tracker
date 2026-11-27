// 확장 서비스와 화면을 구성하고 명령·설정 변경·종료를 연결한다.
import * as vscode from 'vscode';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setClaudeCleanupPeriod } from './claudeSettings';
import { readConfiguration, type TrackerConfiguration } from './configuration';
import { settingDefinitions, settingKeys } from './configuration/schema';
import { setLocale, t } from './localization';
import { ClaudeQuotaProvider, CodexQuotaProvider, QuotaService } from './quota';
import { SummaryClient } from './summary/client';
import { ColorSettings } from './ui/colorSettings';
import { Dashboard } from './ui/dashboard';
import { QuotaStatusBar } from './ui/statusBar';
import { scheduleStatusBarTogglePatch } from './ui/statusBarTogglePatch';

interface ConfigurationChanges {
  cleanup: boolean;
  retention: boolean;
  usageSources: boolean;
  providers: boolean;
  pollingInterval: boolean;
}

/** 서비스·명령·설정 변경을 조율하고 확장의 시작과 종료를 관리한다. */
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
    // [실행 정책] 서비스 준비가 끝난 뒤 명령·리스너를 등록하고 모니터링을 시작한다.
    await this.initializeServices();
    if (this.disposed) return;
    this.context.subscriptions.push({ dispose: () => { void this.dispose(); } });
    this.registerCommands();
    this.registerListeners();
    this.startMonitoring();
    scheduleStatusBarTogglePatch(this.context);
  }

  /**
   * 책임: 설정에 맞는 서비스와 화면을 연결한다.
   * 알고리즘: 언어·Claude 보존 정책·저장 경로를 준비한 뒤 quota·통계·화면을 생성하고, 비동기 단계마다 종료 여부를 확인한다.
   */
  private async initializeServices(): Promise<void> {
    // [설정 정책] 언어와 로그 보존을 먼저 적용하고 통계 저장 경로를 준비한다.
    setLocale(this.settings.locale);
    await this.applyClaudeCleanup();
    if (this.disposed) return;
    await mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
    if (this.disposed) return;

    // [실행 정책] quota와 통계는 별도 서비스로 구성하고 화면은 상태 변경을 구독한다.
    this.quota = this.createQuota();
    this.summary = new SummaryClient({
      dbPath: join(this.context.globalStorageUri.fsPath, 'agent-tracker.sqlite'),
      roots: this.settings.roots,
      timezone: this.settings.usage.timezone,
      collectCapabilities: false,
      retainDeletedSourceUsage: this.settings.usage.retainDeletedSourceUsage,
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
    // [명령 정책] 패치된 편집기는 네이티브 토글을 쓰고 기본 명령은 호버를 여는 대체 동작으로 남긴다.
    this.registerCommand('agentTracker.toggleQuotaTooltip', () => vscode.commands.executeCommand('workbench.action.showHover'));
    this.registerCommand('agentTracker.setStatusBarDetail', detail => this.setStatusBarDetail(detail));
    this.registerCommand('agentTracker.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:AgentTracker.agent-tracker'));
    this.registerCommand('agentTracker.configureStatusColor', () => this.colorSettings?.open());
    this.registerCommand('agentTracker.clearUsageData', () => this.clearUsageData());
    this.registerCommand('agentTracker.refreshQuota', () => this.refreshQuota());
    this.registerCommand('agentTracker.openDashboard', argument => this.openDashboard(argument));
    this.registerCommand('agentTracker.openUsage', () => this.openDashboard());
  }

  /**
   * 책임: 포커스와 설정 변경 이벤트를 서비스에 전달한다.
   * 알고리즘: 포커스는 즉시 반영하고 설정 변경은 기존 큐 뒤에 이어 실행해 비동기 적용의 순서 역전을 막는다.
   */
  private registerListeners(): void {
    // [설정 정책] 포커스는 즉시 반영하고 환경설정 변경은 이전 설정 적용 뒤에 이어서 실행한다.
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
    // [수집 정책] 시작 시 통계 DB 스키마만 준비하고 로그 스캔은 사용량 화면 요청에 맡긴다.
    if (this.settings.usage.enabled) {
      void this.summary?.initialize().catch(() => { /* Usage/Diagnostics reports initialization failures when opened. */ });
    }
  }

  private async refreshQuota(): Promise<void> {
    // [갱신 정책] 설정이 적용된 뒤 현재 활성화된 제공자만 병렬로 강제 갱신한다.
    await this.configurationQueue;
    const quota = this.quota;
    if (this.disposed || !quota) return;
    await Promise.all(quota.getStates().map(state => quota.refresh(state.provider, true)));
  }

  private async openDashboard(argument?: unknown): Promise<void> {
    // [화면 정책] 설정 적용과 데이터 삭제가 끝난 뒤 새 화면을 연다.
    await this.configurationQueue;
    await this.clearingData;
    if (this.disposed) return;
    const value = argument && typeof argument === 'object' ? argument as Record<string, unknown> : {};
    // [화면 정책] 이전 quota 탭 형식의 요청은 무시해 로그 스캔을 시작하지 않도록 한다.
    if (value.tab === 'quota') return;
    this.dashboard?.open();
  }

  private async setStatusBarDetail(detail: unknown): Promise<void> {
    // [설정 정책] 설정 스키마가 허용하는 보기만 사용자 전역 설정에 저장한다.
    if (!settingDefinitions.display.detail.enum.some(value => value === detail)) return;
    await vscode.workspace.getConfiguration('agentTracker').update(settingKeys.display.detail, detail, vscode.ConfigurationTarget.Global);
  }

  private clearUsageData(): Promise<void> {
    // [삭제 정책] 삭제가 진행되면 연속 호출도 같은 삭제 작업을 기다린다.
    this.clearingData ??= this.clearSummaryData().finally(() => { this.clearingData = undefined; });
    return this.clearingData;
  }

  private async clearSummaryData(): Promise<void> {
    // [삭제 정책] 최신 설정 적용을 기다리고 대시보드를 닫은 뒤 통계 데이터를 삭제한다.
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

  /**
   * 책임: 변경된 설정을 실행 중 서비스와 화면에 반영한다.
   * 알고리즘: 이전 스냅샷과 비교해 보존·수집 정책을 적용하고, 경로 변경 시 스캔을 취소한 뒤 quota와 화면을 갱신한다.
   */
  private async applyConfiguration(): Promise<void> {
    if (this.disposed) return;
    // [설정 정책] 이전 스냅샷과 비교해 실행 중인 서비스에 영향을 주는 변경을 고른다.
    const previous = this.settings;
    this.settings = this.readSettings();
    const changes = this.configurationChanges(previous, this.settings);
    setLocale(this.settings.locale);

    // [수집 정책] 보존 설정을 먼저 반영하고 수집 루트나 활성화 상태가 달라지면 갱신을 취소한다.
    if (changes.cleanup) await this.applyClaudeCleanup();
    if (this.disposed) return;
    if (changes.retention) await this.summary?.setDeletedSourceRetentionEnabled(this.settings.usage.retainDeletedSourceUsage);
    if (this.disposed) return;
    if (changes.usageSources) {
      this.dashboard?.close();
      await this.summary?.cancelRefresh();
      if (this.disposed) return;
    }

    // [화면 정책] quota에 적용이 끝난 새 설정으로 상태 표시줄과 대시보드를 갱신한다.
    await this.updateQuota(changes);
    if (this.disposed) return;
    this.render();
    this.colorSettings?.update();
    this.dashboard?.configurationChanged();
  }

  private configurationChanges(previous: TrackerConfiguration, next: TrackerConfiguration): ConfigurationChanges {
    // [설정 정책] 제공자 교체, 원본 재수집, 폴링 재예약에 영향을 주는 변경을 따로 판단한다.
    const tracking = previous.claude.enabled !== next.claude.enabled || previous.codex.enabled !== next.codex.enabled;
    return {
      cleanup: previous.claude.cleanupPeriodDays !== next.claude.cleanupPeriodDays || previous.claude.dataHome !== next.claude.dataHome,
      retention: previous.usage.retainDeletedSourceUsage !== next.usage.retainDeletedSourceUsage,
      usageSources: previous.usage.enabled !== next.usage.enabled || JSON.stringify(previous.roots) !== JSON.stringify(next.roots),
      providers: tracking || previous.claude.dataHome !== next.claude.dataHome || previous.codex.dataHome !== next.codex.dataHome || previous.codex.executable !== next.codex.executable,
      pollingInterval: previous.quota.pollingIntervalSeconds !== next.quota.pollingIntervalSeconds,
    };
  }

  /**
   * 책임: 설정 변경에 따른 quota 제공자 수명을 관리한다.
   * 알고리즘: 제공자 구성이 바뀌면 기존 구독·서비스 종료 후 재생성하고, 그 외에는 폴링 간격과 갱신 정책만 갱신한다.
   */
  private async updateQuota(changes: ConfigurationChanges): Promise<void> {
    // [갱신 정책] 제공자 구성 변경 시 기존 구독과 서비스를 정리한 뒤 다시 만든다.
    if (changes.providers) {
      this.quotaSubscription?.dispose();
      await this.quota?.dispose();
      if (this.disposed) return;
      this.quota = this.createQuota();
      this.quotaSubscription = this.quota.subscribe(() => this.render());
      this.quota.start(vscode.window.state.focused);
      return;
    }
    // [예약 정책] 제공자가 같으면 서비스의 폴링 주기와 자동 갱신 여부만 갱신한다.
    if (changes.pollingInterval) this.quota?.setPollingInterval(this.settings.quota.pollingIntervalSeconds);
    this.quota?.setRefreshPolicy(this.settings.quota.refreshPolicy);
  }

  private createQuota(): QuotaService {
    // [설정 정책] 추적이 켜진 제공자만 생성하고 공통 폴링 정책을 적용한다.
    const config = this.settings;
    return new QuotaService([
      ...(config.claude.enabled ? [new ClaudeQuotaProvider({ dataHome: config.claude.dataHome })] : []),
      ...(config.codex.enabled ? [new CodexQuotaProvider({ dataHome: config.codex.dataHome, executable: config.codex.executable })] : []),
    ], { pollingSeconds: config.quota.pollingIntervalSeconds, refreshPolicy: config.quota.refreshPolicy });
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

  /**
   * 책임: 확장 종료 시 작업과 리소스가 남지 않도록 정리한다.
   * 알고리즘: 종료 표시와 이벤트 해제를 먼저 수행하고 quota·Worker·설정 큐·데이터 삭제 작업을 allSettled로 기다린다.
   */
  private async close(): Promise<void> {
    // [종료 정책] 종료 표시와 이벤트 구독 해제를 먼저 수행해 새 작업이 시작될 여지를 줄인다.
    this.disposed = true;
    this.quotaSubscription?.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    // [종료 정책] 서비스 종료와 설정·삭제 작업은 한 작업이 실패해도 모두 끝날 때까지 기다린다.
    await Promise.allSettled([
      this.quota?.dispose(),
      this.summary?.dispose(),
      this.configurationQueue,
      this.clearingData,
    ]);
  }
}
