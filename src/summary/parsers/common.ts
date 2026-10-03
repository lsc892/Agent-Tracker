import { basename, normalize } from 'node:path';
import type { TokenVector } from '../types';
import { SummaryError } from '../jsonl';

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }
export function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0; }
export function timestamp(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isSafeInteger(parsed) && Math.abs(parsed) <= 8.64e15 ? parsed : null;
}
export function project(path: string): { projectKey: string; projectName: string } {
  const key = normalize(path);
  return { projectKey: key, projectName: basename(key.replace(/\\/g, '/')) || key };
}
export function claudeTokens(raw: Record<string, unknown>): TokenVector {
  validateTokens(raw);
  const cacheRead = number(raw.cache_read_input_tokens);
  const cacheWrite = number(raw.cache_creation_input_tokens);
  return { input: number(raw.input_tokens) + cacheRead + cacheWrite, output: number(raw.output_tokens), cacheRead, cacheWrite, reasoning: 0 };
}
export function codexTokens(raw: Record<string, unknown>): TokenVector {
  validateTokens(raw);
  const details = object(raw.input_tokens_details);
  return { input: number(raw.input_tokens), output: number(raw.output_tokens),
    cacheRead: number(raw.cached_input_tokens ?? details.cached_tokens), cacheWrite: number(raw.cache_write_input_tokens),
    reasoning: number(raw.reasoning_output_tokens ?? object(raw.output_tokens_details).reasoning_tokens) };
}

function validateTokens(raw: Record<string, unknown>): void {
  if (Object.keys(raw).length === 0) throw new SummaryError('unsupported-token-schema');
  for (const key of ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0)) throw new SummaryError('unsupported-token-schema');
  }
  if (raw.input_tokens === undefined && raw.output_tokens === undefined) throw new SummaryError('unsupported-token-schema');
}
export function tokenFlags(tokens: TokenVector): string[] {
  return tokens.cacheRead + tokens.cacheWrite > tokens.input || tokens.reasoning > tokens.output ? ['component-clamped'] : [];
}
