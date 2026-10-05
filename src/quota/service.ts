import { QuotaError, type QuotaProvider, type QuotaProviderId, type QuotaSnapshot, type QuotaState } from './types';

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
  refreshPolicy?: 'automatic' | 'manual';
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

/** Only quota providers run here. No transcript discovery or database work is performed. */
export class QuotaService {
  private readonly entries = new Map<QuotaProviderId, Entry>();
  private readonly listeners = new Set<(states: QuotaState[]) => void>();
  private readonly clock: QuotaClock;
  private focused = false;
  private started = false;
  private disposed = false;
  private timer: unknown;
  private refreshPolicy: 'automatic' | 'manual';
  private pollingIntervalMs: number;

  constructor(providers: readonly QuotaProvider[], options: QuotaServiceOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.refreshPolicy = options.refreshPolicy ?? 'automatic';
    this.pollingIntervalMs = intervalMs(options.pollingSeconds ?? 900);
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

  setRefreshPolicy(policy: 'automatic' | 'manual'): void {
    if (this.refreshPolicy === policy || this.disposed) return;
    this.refreshPolicy = policy;
    if (policy === 'automatic' && this.started && this.focused) {
      for (const id of this.entries.keys()) void this.refresh(id);
    }
    this.schedule();
  }

  /** force=true bypasses focus/backoff, and coalesces active manual requests into one rerun. */
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
      error: entry.error ? { code: entry.error.code, message: entry.error.message } : null,
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

  private async read(entry: Entry): Promise<void> {
    if (this.disposed) return;
    entry.abort = new AbortController();
    try {
      const snapshot = await entry.provider.read({ signal: entry.abort.signal,
        onSnapshot: value => { if (!this.disposed) { this.accept(entry, value); this.emit(); } } });
      if (!this.disposed) this.accept(entry, snapshot);
    } catch (error) {
      if (this.disposed) return;
      entry.error = error instanceof QuotaError ? error : new QuotaError('unavailable', 'Quota 조회에 실패했습니다. 다시 시도해 주세요.');
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

  private expire(entry: Entry): boolean {
    if (!entry.snapshot || !entry.error || entry.lastSuccessAt === null) return false;
    const ttl = entry.error.code === 'rate-limit' ? 86_400_000 : 1_800_000;
    if (this.clock.now() - entry.lastSuccessAt < ttl) return false;
    entry.snapshot = null;
    return true;
  }

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
  return Math.max(30, Number.isFinite(seconds) ? seconds : 900) * 1000;
}
