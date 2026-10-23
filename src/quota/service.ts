import { QuotaError, type QuotaProvider, type QuotaProviderId, type QuotaSnapshot, type QuotaState } from './types';
import { settingDefinitions, type RefreshPolicy } from '../configuration/schema';

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
  snapshot: QuotaSnapshot | null;
  lastSuccessAt: number | null;
  error: QuotaError | null;
  failures: number;
  nextAllowedAt: number;
  nextPollAt: number;
  running: Promise<void> | null;
  rerunRequested: boolean;
  abort: AbortController | null;
}

/**
 * 책임: 대화 로그·DB 작업과 독립적으로 quota 상태와 갱신 일정을 관리한다.
 * 알고리즘: 제공자별 조회·재시도·마지막 성공 값을 보관하고 가장 이른 폴링 또는 만료 시각에 단일 타이머를 예약한다.
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
      this.entries.set(provider.id, { provider, snapshot: null, lastSuccessAt: null, error: null,
        failures: 0, nextAllowedAt: 0, nextPollAt: 0,
        running: null, rerunRequested: false, abort: null });
    }
  }

  start(focused = true): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.focused = focused;
    if (focused && this.refreshPolicy === 'automatic') for (const id of this.entries.keys()) void this.refresh(id);
    this.schedule();
  }

  setFocused(focused: boolean): void {
    if (this.disposed || this.focused === focused) return;
    this.focused = focused;
    if (focused && this.started && this.refreshPolicy === 'automatic') {
      const now = this.clock.now();
      for (const [id, entry] of this.entries) {
        if (entry.lastSuccessAt === null || entry.error || now - entry.lastSuccessAt >= 300_000) {
          void this.refresh(id);
        }
      }
    }
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
    if (policy === 'automatic' && this.started && this.focused) {
      for (const id of this.entries.keys()) void this.refresh(id);
    }
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
    if (!force && (this.refreshPolicy === 'manual' || !this.focused || this.clock.now() < entry.nextAllowedAt)) return Promise.resolve();
    // Defer execution until running has been installed, including synchronous observers/providers.
    entry.running = Promise.resolve().then(async () => {
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
    });
    this.emit();
    this.schedule();
    return entry.running;
  }

  getState(provider: QuotaProviderId): QuotaState {
    const entry = this.entry(provider);
    this.expire(entry);
    const snapshot = entry.snapshot ? structuredClone(entry.snapshot) : null;
    return { provider, snapshot, refreshing: entry.running !== null,
      status: snapshot ? (entry.error ? 'stale' : 'ready') : (entry.running ? 'loading' : 'unavailable'),
      lastSuccessAt: entry.lastSuccessAt,
      error: entry.error ? { code: entry.error.code, message: entry.error.message, translation: entry.error.translation } : null,
      nextAllowedAt: entry.nextAllowedAt };
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
   * 책임: 조회 결과와 실패에 따른 재시도 상태를 갱신한다.
   * 알고리즘: 응답·알림은 성공 값으로 반영하고 실패는 30초부터 최대 15분의 지수 지연과 Retry-After 중 큰 값을 적용한다.
   */
  private async read(entry: Entry): Promise<void> {
    if (this.disposed) return;
    entry.abort = new AbortController();
    try {
      const snapshot = await entry.provider.read({ signal: entry.abort.signal,
        onSnapshot: value => { if (!this.disposed) { this.accept(entry, value); this.emit(); } } });
      if (!this.disposed) this.accept(entry, snapshot);
    } catch (error) {
      if (this.disposed) return;
      entry.error = error instanceof QuotaError ? error : new QuotaError('unavailable', { key: 'quota.lookupFailed' });
      entry.failures += 1;
      const backoff = Math.min(900_000, 30_000 * 2 ** Math.min(10, entry.failures - 1));
      entry.nextAllowedAt = this.clock.now() + Math.max(backoff, entry.error.retryAfterMs ?? 0);
      if (entry.error.code === 'unsupported-account') {
        entry.snapshot = null;
        entry.lastSuccessAt = null;
      }
      this.expire(entry);
    } finally {
      entry.nextPollAt = this.clock.now() + this.pollingIntervalMs;
    }
  }

  private accept(entry: Entry, snapshot: QuotaSnapshot): void {
    entry.snapshot = structuredClone(snapshot);
    entry.lastSuccessAt = snapshot.fetchedAt;
    entry.error = null;
    entry.failures = 0;
    entry.nextAllowedAt = 0;
  }

  /**
   * 책임: 실패 후 오래된 quota가 계속 표시되지 않도록 만료시킨다.
   * 알고리즘: 마지막 성공 시각부터 일반 오류는 30분, 요청 제한 오류는 24시간이 지나면 스냅샷을 비운다.
   */
  private expire(entry: Entry): boolean {
    if (!entry.snapshot || !entry.error || entry.lastSuccessAt === null) return false;
    const ttl = entry.error.code === 'rate-limit' ? 86_400_000 : 1_800_000;
    if (this.clock.now() - entry.lastSuccessAt < ttl) return false;
    entry.snapshot = null;
    return true;
  }

  /**
   * 책임: 폴링과 오래된 값 만료를 하나의 타이머로 구동한다.
   * 알고리즘: 각 제공자의 폴링·재시도·만료 시각 중 최솟값을 구하고 Node 타이머 상한 안에서 예약한 뒤 다시 계산한다.
   */
  private schedule(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed || !this.started) return;
    const now = this.clock.now();
    let due = Infinity;
    for (const entry of this.entries.values()) {
      if (this.refreshPolicy === 'automatic' && this.focused && !entry.running) due = Math.min(due, Math.max(entry.nextPollAt, entry.nextAllowedAt));
      if (entry.snapshot && entry.error && entry.lastSuccessAt !== null) {
        due = Math.min(due, entry.lastSuccessAt + (entry.error.code === 'rate-limit' ? 86_400_000 : 1_800_000));
      }
    }
    if (!Number.isFinite(due)) return;
    this.timer = this.clock.setTimeout(() => {
      let expired = false;
      for (const [id, entry] of this.entries) {
        expired = this.expire(entry) || expired;
        if (this.refreshPolicy === 'automatic' && this.focused && this.clock.now() >= Math.max(entry.nextPollAt, entry.nextAllowedAt)) void this.refresh(id);
      }
      if (expired) this.emit();
      this.schedule();
    }, Math.min(2_147_483_647, Math.max(1, due - now)));
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
