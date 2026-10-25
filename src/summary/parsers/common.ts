// 제공자 파서가 공유하는 값·경로·제목·토큰·결제 분류 정규화를 제공한다.
import { basename, normalize, win32 } from 'node:path';
import type { TokenVector } from '../types';
import { SummaryError } from '../jsonl';
import type { BillingMode } from '../db/types';

/** Only explicit historical metadata identifies how usage was billed. */
export function billingMode(value: unknown): BillingMode {
  if (['subscription','chatgpt','chatgptAuthTokens','claudeAi'].includes(String(value))) return 'subscription';
  if (['api','apiKey','api_key','apikey'].includes(String(value))) return 'api';
  return 'unknown';
}

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }
export function displayName(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 512) || undefined : undefined;
}
export function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0; }
export function timestamp(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isSafeInteger(parsed) && Math.abs(parsed) <= 8.64e15 ? parsed : null;
}
/**
 * 책임: 동일 프로젝트의 경로 표기 차이를 집계 키에서 통합한다.
 * 알고리즘: Windows 경로는 구분자·끝 구분자·대소문자를 정규화하고 POSIX 대소문자는 보존하며 별도 표시 이름을 만든다.
 */
export function project(path: string): { projectKey: string; projectName: string } {
  const windows = /^[a-z]:[/\\]|^\\\\/i.test(path);
  let normalized = windows ? win32.normalize(path) : normalize(path);
  if (windows && normalized.length > win32.parse(normalized).root.length) normalized = normalized.replace(/[/\\]+$/, '');
  const key = windows ? normalized.toLowerCase() : normalized;
  return { projectKey: key, projectName: basename(normalized.replace(/\\/g, '/')) || normalized };
}

/**
 * 책임: 본문·첨부 대신 짧은 사용자 요청 제목만 파서 밖으로 전달한다.
 * 알고리즘: 텍스트 블록에서 명시 요청 구간을 우선해 첫 유효 줄을 고르고 제어 문자·공백을 정리한 뒤 최대 80자로 줄인다.
 */
export function requestTitle(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : Array.isArray(value)
    ? value.filter(item => object(item).type === 'text' || object(item).type === 'input_text')
      .map(item => string(object(item).text) ?? '').join('\n') : '';
  // Codex prepends editor context; prefer the explicit request when available.
  const request = text.split(/(?:^|\n)## My request:\s*/).at(-1) ?? text;
  const first = request.split(/[\r\n]/).map(line => line.trim())
    .find(line => line && !line.startsWith('<') && !/^#(?:\s|$)/.test(line));
  if (!first) return undefined;
  const cleaned = first.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned || undefined;
}
/**
 * 책임: Claude 토큰을 캐시 포함 입력이라는 공통 기준으로 맞춘다.
 * 알고리즘: 토큰 스키마를 검증한 뒤 일반 입력에 캐시 읽기·쓰기를 더하고 출력과 캐시 성분을 별도로 보존한다.
 */
export function claudeTokens(raw: Record<string, unknown>): TokenVector {
  validateTokens(raw);
  const cacheRead = number(raw.cache_read_input_tokens);
  const cacheWrite = number(raw.cache_creation_input_tokens);
  return { input: number(raw.input_tokens) + cacheRead + cacheWrite, output: number(raw.output_tokens), cacheRead, cacheWrite, reasoning: 0 };
}
/**
 * 책임: Codex의 평면·세부 토큰 필드를 공통 벡터로 정규화한다.
 * 알고리즘: 기존 입력·출력 총량은 유지하고 평면 필드를 우선해 캐시·reasoning 성분을 읽어 이중 가산을 막는다.
 */
export function codexTokens(raw: Record<string, unknown>): TokenVector {
  validateTokens(raw);
  const details = object(raw.input_tokens_details);
  return { input: number(raw.input_tokens), output: number(raw.output_tokens),
    cacheRead: number(raw.cached_input_tokens ?? details.cached_tokens), cacheWrite: number(raw.cache_write_input_tokens ?? details.cache_write_tokens),
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
