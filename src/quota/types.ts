// 제공자 간 공통 quota 데이터·상태·오류 계약과 정규화 도우미를 정의한다.
import { t, type LocalizedMessage } from '../localization';

export type QuotaProviderId = 'claude' | 'codex';

/** All timestamps crossing the provider boundary are Unix milliseconds. */
export interface QuotaWindow {
  id: string;
  label: string;
  usedPercent: number;
  current: number;
  maximum: number;
  resetsAt: number | null;
  windowDurationMins: number | null;
  limitId?: string;
  limitName?: string;
  rateLimitReachedType?: string;
}

export interface QuotaSnapshot {
  provider: QuotaProviderId;
  fetchedAt: number;
  windows: QuotaWindow[];
  rateLimitResetCredits?: { availableCount: number; nextExpiresAt: number | null };
}

export type QuotaErrorCode = 'authentication' | 'unsupported-account' | 'rate-limit' |
  'network' | 'timeout' | 'cancelled' | 'protocol' | 'process' | 'unavailable';

/** 외부 응답 본문을 노출하지 않는 quota 오류 코드·메시지·재시도 지연을 전달한다. */
export class QuotaError extends Error {
  readonly translation?: LocalizedMessage;
  constructor(
    public readonly code: QuotaErrorCode,
    message: string | LocalizedMessage,
    public readonly retryAfterMs?: number,
  ) {
    super(typeof message === 'string' ? message : t(message.key, message.values));
    if (typeof message !== 'string') this.translation = message;
    this.name = 'QuotaError';
  }
}

export interface QuotaReadContext {
  signal: AbortSignal;
  onSnapshot?: (snapshot: QuotaSnapshot) => void;
}

export interface QuotaProvider {
  readonly id: QuotaProviderId;
  read(context: QuotaReadContext): Promise<QuotaSnapshot>;
  dispose?(): void | Promise<void>;
}

export interface QuotaState {
  provider: QuotaProviderId;
  snapshot: QuotaSnapshot | null;
  status: 'loading' | 'ready' | 'stale' | 'unavailable';
  refreshing: boolean;
  lastSuccessAt: number | null;
  error: { code: QuotaErrorCode; message: string; translation?: LocalizedMessage } | null;
  nextAllowedAt: number;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function durationLabel(minutes: number | null, fallback: string): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
