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

/** Messages are controlled by us, never copied from credential, HTTP, or RPC bodies. */
export class QuotaError extends Error {
  constructor(
    public readonly code: QuotaErrorCode,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
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
  error: { code: QuotaErrorCode; message: string } | null;
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
