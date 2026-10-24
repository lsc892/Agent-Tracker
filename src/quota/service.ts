import type { QuotaProvider, QuotaProviderId, QuotaSnapshot, QuotaState } from './types';
import { settingDefinitions, type RefreshPolicy } from '../configuration/schema';
import { ProviderQuotaState } from './providerState';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface QuotaClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

const systemClock: QuotaClock = {
  now: Date.now,
  setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref?.(); return timer; },
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
export interface QuotaServiceOptions {
  clock?: QuotaClock;
  pollingSeconds?: number;
  refreshPolicy?: RefreshPolicy;
}
interface Entry {
  provider: QuotaProvider;
  state: ProviderQuotaState;
  nextPollAt: number;
  running: Promise<void> | null;
  rerunRequested: boolean;
  abort: AbortController | null;
}

/**
 * 책임: 제공자 조회·수동 재실행·구독 알림과 갱신 일정을 조율한다.
 * 알고리즘: 제공자별 진행 중 조회를 합치고 가장 이른 폴링 또는 상태 만료 시각에 단일 타이머를 예약한다.
 */
export class QuotaService {
  private readonly entries = new Map<QuotaProviderId, Entry>();
  private readonly listeners = new Set<(states: QuotaState[]) => void>();
  private readonly clock: QuotaClock;
  private focused = false;
  private started = false;
  private disposed = false;
  private timer: unknown;
  private refreshPolicy: RefreshPolicy;
  private pollingIntervalMs: number;

  constructor(providers: readonly QuotaProvider[], options: QuotaServiceOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.refreshPolicy = options.refreshPolicy ?? settingDefinitions.quota.refreshPolicy.default;
    this.pollingIntervalMs = intervalMs(options.pollingSeconds ?? settingDefinitions.quota.pollingIntervalSeconds.default);
    for (const provider of providers) {
      if (this.entries.has(provider.id)) throw new Error(`Duplicate quota provider: ${provider.id}`);
      this.entries.set(provider.id, { provider, state: new ProviderQuotaState(() => this.clock.now()), nextPollAt: 0,
        running: null, rerunRequested: false, abort: null });
    }
  }

  start(focused = true): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.focused = focused;
    if (this.isAutomaticRefreshActive()) this.refreshAll();
    this.schedule();
  }

  setFocused(focused: boolean): void {
    if (this.disposed || this.focused === focused) return;
    this.focused = focused;
    if (this.started && this.isAutomaticRefreshActive()) this.refreshOnFocus();
    this.schedule();
  }

  setPollingInterval(seconds: number): void {
    if (this.disposed) return;
    this.pollingIntervalMs = intervalMs(seconds);
    const nextPollAt = this.clock.now() + this.pollingIntervalMs;
    for (const entry of this.entries.values()) entry.nextPollAt = nextPollAt;
    this.schedule();
  }

  setRefreshPolicy(policy: RefreshPolicy): void {
    if (this.refreshPolicy === policy || this.disposed) return;
    this.refreshPolicy = policy;
    if (this.started && this.isAutomaticRefreshActive()) this.refreshAll();
    this.schedule();
  }

  /**
   * 책임: 같은 제공자의 중복 조회를 합치고 수동 새로고침을 반영한다.
   * 알고리즘: 진행 중 Promise를 공유하고 강제 요청은 재실행 표시로 합치며, 자동 요청만 포커스·정책·재시도 시각을 검사한다.
   */
  refresh(provider: QuotaProviderId, force = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const entry = this.entry(provider);
    if (entry.running) {
      if (force) entry.rerunRequested = true;
      return entry.running;
    }
    if (!force && this.shouldSkipAutomaticRefresh(entry)) return Promise.resolve();
    // Defer execution until running has been installed, including synchronous observers/providers.
    entry.running = Promise.resolve().then(() => this.runRefreshCycle(entry));
    this.emit();
    this.schedule();
    return entry.running;
  }

  getState(provider: QuotaProviderId): QuotaState {
    const entry = this.entry(provider);
    entry.state.expire();
    return entry.state.getState(provider, entry.running !== null);
  }

  getStates(): QuotaState[] { return [...this.entries.keys()].map(id => this.getState(id)); }

  subscribe(listener: (states: QuotaState[]) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    for (const entry of this.entries.values()) {
      entry.rerunRequested = false;
      entry.abort?.abort();
    }
    await Promise.allSettled([...this.entries.values()].map(async entry => {
      await entry.provider.dispose?.();
      await entry.running;
    }));
    this.listeners.clear();
  }

  /**
   * 책임: 한 제공자의 조회·수동 재실행·완료 처리를 같은 실행 흐름에서 수행한다.
   * 알고리즘: 첫 조회 후 모인 재실행 요청을 소진하고 마지막 요청 확인과 진행 중 상태 해제를 같은 continuation에서 처리한다.
   */
  private async runRefreshCycle(entry: Entry): Promise<void> {
    try {
      await this.read(entry);
      while (!this.disposed && entry.rerunRequested) {
        entry.rerunRequested = false;
        await this.read(entry);
      }
    } finally {
      // Clear flight ownership in the same continuation that checks the rerun flag.
      // A separate Promise.finally leaves a microtask gap where a forced rerun is lost.
      entry.running = null;
      entry.abort = null;
      this.emit();
      this.schedule();
    }
  }

  /**
   * 책임: 제공자 조회 한 번의 성공·알림·실패 처리와 다음 폴링 시각을 연결한다.
   * 알고리즘: 취소 신호로 조회하고 결과 종류별 처리에 위임하며 완료 시 다음 폴링 시각을 갱신한다.
   */
  private async read(entry: Entry): Promise<void> {
    if (this.disposed) return;
    entry.abort = new AbortController();
    try {
      const snapshot = await entry.provider.read({ signal: entry.abort.signal,
        onSnapshot: value => this.handleSnapshotUpdate(entry, value) });
      if (!this.disposed) entry.state.acceptSnapshot(snapshot);
    } catch (error) {
      if (!this.disposed) entry.state.recordFailure(error);
    } finally {
      entry.nextPollAt = this.clock.now() + this.pollingIntervalMs;
    }
  }

  /** 가장 이른 폴링·만료 시각에 타이머 하나를 예약한다. */
  private schedule(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed || !this.started) return;
    const now = this.clock.now();
    const due = this.getNextWakeAt();
    if (!Number.isFinite(due)) return;
    this.timer = this.clock.setTimeout(() => this.handleTimer(),
      Math.min(MAX_TIMER_DELAY_MS, Math.max(1, due - now)));
  }

  private refreshAll(): void {
    for (const id of this.entries.keys()) void this.refresh(id);
  }

  /** 포커스 복귀 시 성공 이력이 없거나 실패·5분 경과 상태인 제공자만 갱신한다. */
  private refreshOnFocus(): void {
    const now = this.clock.now();
    for (const [id, entry] of this.entries) {
      if (entry.state.shouldRefreshOnFocus(now)) {
        void this.refresh(id);
      }
    }
  }

  private shouldSkipAutomaticRefresh(entry: Entry): boolean {
    return this.refreshPolicy === 'manual' || !this.focused || this.clock.now() < entry.state.nextAllowedAt;
  }

  private handleSnapshotUpdate(entry: Entry, snapshot: QuotaSnapshot): void {
    if (this.disposed) return;
    entry.state.acceptSnapshot(snapshot);
    this.emit();
  }

  /**
   * 책임: 다음으로 처리할 폴링 또는 오래된 값 만료 시각을 구한다.
   * 알고리즘: 자동 갱신이 가능한 제공자의 폴링·재시도 시각과 모든 실패 스냅샷의 만료 시각 중 최솟값을 반환한다.
   */
  private getNextWakeAt(): number {
    let due = Infinity;
    for (const entry of this.entries.values()) {
      if (this.isAutomaticRefreshActive() && !entry.running) due = Math.min(due, Math.max(entry.nextPollAt, entry.state.nextAllowedAt));
      due = Math.min(due, entry.state.expiresAt);
    }
    return due;
  }

  /** 만료·폴링을 처리하고 변경 알림과 다음 예약을 연결한다. */
  private handleTimer(): void {
    let expired = false;
    for (const [id, entry] of this.entries) {
      expired = entry.state.expire() || expired;
      if (this.isAutomaticRefreshActive() && this.clock.now() >= Math.max(entry.nextPollAt, entry.state.nextAllowedAt)) void this.refresh(id);
    }
    if (expired) this.emit();
    this.schedule();
  }

  private isAutomaticRefreshActive(): boolean {
    return this.refreshPolicy === 'automatic' && this.focused;
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try { listener(this.getStates()); } catch { /* A UI observer cannot interrupt provider cleanup. */ }
    }
  }
  private entry(id: QuotaProviderId): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown quota provider: ${id}`);
    return entry;
  }
}

function intervalMs(seconds: number): number {
  const { minimum, default: fallback } = settingDefinitions.quota.pollingIntervalSeconds;
  return Math.max(minimum, Number.isFinite(seconds) ? seconds : fallback) * 1000;
}
