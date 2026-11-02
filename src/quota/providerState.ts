// quota 제공자 하나의 성공 스냅샷·오류·재시도·만료 상태를 관리한다.
import { QuotaError, type QuotaProviderId, type QuotaSnapshot, type QuotaState } from './types';

const FOCUS_REFRESH_AGE_MS = 300_000;
const INITIAL_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 900_000;
const MAX_RETRY_EXPONENT = 10;
const ERROR_SNAPSHOT_RETENTION_MS = 1_800_000;
const RATE_LIMIT_SNAPSHOT_RETENTION_MS = 86_400_000;

/** 제공자 하나의 마지막 성공 값·오류·재시도·만료 수명을 소유한다. */
export class ProviderQuotaState {
  private snapshot: QuotaSnapshot | null = null;
  private lastSuccessAt: number | null = null;
  private error: QuotaError | null = null;
  private failures = 0;
  private retryAllowedAt = 0;

  // Read lazily so guards and failure updates retain their existing clock-read order.
  constructor(private readonly now: () => number) {}

  get nextAllowedAt(): number { return this.retryAllowedAt; }

  get expiresAt(): number {
    if (!this.snapshot || !this.error || this.lastSuccessAt === null) return Infinity;
    return this.lastSuccessAt + snapshotRetentionMs(this.error.code);
  }

  acceptSnapshot(snapshot: QuotaSnapshot): void {
    this.snapshot = structuredClone(snapshot);
    this.lastSuccessAt = snapshot.fetchedAt;
    this.error = null;
    this.failures = 0;
    this.retryAllowedAt = 0;
  }

  /** 지수 지연과 Retry-After를 적용하고 계정 변경·보존 기한에 따라 이전 값을 비운다. */
  recordFailure(error: unknown): void {
    this.error = error instanceof QuotaError ? error : new QuotaError('unavailable', { key: 'quota.lookupFailed' });
    this.failures += 1;
    const retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** Math.min(MAX_RETRY_EXPONENT, this.failures - 1));
    this.retryAllowedAt = this.now() + Math.max(retryDelayMs, this.error.retryAfterMs ?? 0);
    if (this.error.code === 'unsupported-account') {
      this.snapshot = null;
      this.lastSuccessAt = null;
    }
    this.expire();
  }

  /** 일반 오류는 30분, 요청 제한 오류는 24시간 뒤 성공 시각을 남기고 스냅샷만 만료시킨다. */
  expire(): boolean {
    if (!this.snapshot || !this.error || this.lastSuccessAt === null) return false;
    const retentionMs = snapshotRetentionMs(this.error.code);
    if (this.now() - this.lastSuccessAt < retentionMs) return false;
    this.snapshot = null;
    return true;
  }

  shouldRefreshOnFocus(now: number): boolean {
    return this.lastSuccessAt === null || this.error !== null || now - this.lastSuccessAt >= FOCUS_REFRESH_AGE_MS;
  }

  getState(provider: QuotaProviderId, refreshing: boolean): QuotaState {
    const snapshot = this.snapshot ? structuredClone(this.snapshot) : null;
    return { provider, snapshot, refreshing,
      status: snapshot ? (this.error ? 'stale' : 'ready') : (refreshing ? 'loading' : 'unavailable'),
      lastSuccessAt: this.lastSuccessAt,
      error: this.error ? { code: this.error.code, message: this.error.message, translation: this.error.translation } : null,
      nextAllowedAt: this.retryAllowedAt };
  }
}

function snapshotRetentionMs(errorCode: QuotaError['code']): number {
  return errorCode === 'rate-limit' ? RATE_LIMIT_SNAPSHOT_RETENTION_MS : ERROR_SNAPSHOT_RETENTION_MS;
}
