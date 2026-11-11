// 요청·모델·Skill을 검증하고 비교·저장에 사용하는 SQL 값 배열로 변환한다.
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import type { ModelUsageInput, TurnSummaryInput } from '../types';
import { nonnegative } from '../validation';
import { estimateCost, PRICING_VERSION } from '../../models/pricing';

export const SUMMARY_COLUMNS = [
  'provider', 'project_key', 'session_id', 'root_turn_id', 'request_title', 'started_at_ms', 'completed_at_ms',
  'duration_ms', 'duration_quality', 'input_tokens', 'output_tokens', 'cache_write_input_tokens', 'cache_read_input_tokens',
  'total_tokens', 'status', 'quality_flags', 'diagnostic_file_id', 'diagnostic_offset', 'last_error', 'updated_at',
];
const MAX_CAPABILITY_NAME_LENGTH = 512;

/** 정렬된 SQL 값 배열을 같은 JSON 표현으로 비교한다. */
export const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** 모델명의 문자열 순서를 비교해 기존 SQL 행과 같은 순서로 맞춘다. */
export function compareModels(left: SQLInputValue[], right: SQLInputValue[]): number {
  if (String(left[0]) < String(right[0])) return -1;
  if (String(left[0]) > String(right[0])) return 1;
  return 0;
}

/** 분류·이름의 JSON 키를 localeCompare로 비교해 기존 Skill 정렬을 유지한다. */
export function compareCapabilities(left: SQLInputValue[], right: SQLInputValue[]): number {
  return JSON.stringify(left.slice(0, 2)).localeCompare(JSON.stringify(right.slice(0, 2)));
}

/** 요청의 수치 범위와 토큰 합계·캐시 포함 관계를 기존 순서대로 검사한다. */
function validateSummary(row: TurnSummaryInput): void {
  for (const name of ['input_tokens', 'output_tokens', 'total_tokens'] as const) {
    nonnegative(row[name], name);
  }
  if (row.total_tokens !== row.input_tokens + row.output_tokens) throw new RangeError('Invalid total tokens');
  if (row.duration_ms != null) nonnegative(row.duration_ms, 'duration_ms');
  for (const name of ['cache_write_input_tokens', 'cache_read_input_tokens'] as const) {
    if (row[name] != null) nonnegative(row[name], name);
  }
  if ((row.cache_write_input_tokens ?? 0) + (row.cache_read_input_tokens ?? 0) > row.input_tokens) {
    throw new RangeError('Cache components cannot exceed input tokens');
  }
}

/** 검증한 요청을 고정 열 순서로 변환하며 undefined와 null의 기존 기본값을 유지한다. */
export function summaryValues(row: TurnSummaryInput, now: string): SQLInputValue[] {
  validateSummary(row);
  return [
    row.provider, row.project_key, row.session_id, row.root_turn_id, row.request_title ?? null,
    row.started_at_ms ?? null, row.completed_at_ms ?? null, row.duration_ms ?? null, row.duration_quality,
    row.input_tokens, row.output_tokens,
    row.cache_write_input_tokens === undefined ? 0 : row.cache_write_input_tokens,
    row.cache_read_input_tokens === undefined ? 0 : row.cache_read_input_tokens,
    row.total_tokens, row.status, row.quality_flags ?? null, row.diagnostic_file_id ?? null,
    row.diagnostic_offset ?? null, row.last_error ?? null, row.updated_at ?? now,
  ];
}

/** 요청 열을 바인딩 값과 비교하되 updated_at은 입력이 명시한 경우에만 비교한다. */
export function hasFactsChanged(
  previous: Record<string, SQLOutputValue> | undefined, incoming: SQLInputValue[], summary: TurnSummaryInput,
): boolean {
  if (!previous) return true;
  return SUMMARY_COLUMNS.some((name, index) => {
    if (name === 'updated_at') return summary.updated_at !== undefined && previous.updated_at !== summary.updated_at;
    return previous[name] !== incoming[index];
  });
}

/** 모델별 수치를 검증·누적하고 단가를 붙인 행을 모델명순으로 만들어 요청 합계와 대조한다. */
export function modelValues(summary: TurnSummaryInput): SQLInputValue[][] {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  const models = [...summary.model_usage ?? []].map(model => {
    validateModel(model);
    input += model.input_tokens;
    output += model.output_tokens;
    cacheRead += model.cache_read_input_tokens ?? 0;
    cacheWrite += model.cache_write_input_tokens ?? 0;
    return [
      model.model, model.input_tokens, model.output_tokens, model.cache_write_input_tokens, model.cache_read_input_tokens,
      estimateCost(summary.provider, model), PRICING_VERSION,
    ] as SQLInputValue[];
  }).sort(compareModels);
  if (!summary.model_usage) return models;
  const totalsMatch = input === summary.input_tokens && output === summary.output_tokens
    && cacheRead === (summary.cache_read_input_tokens ?? 0) && cacheWrite === (summary.cache_write_input_tokens ?? 0);
  if (!totalsMatch) throw new RangeError('Model totals must match the request summary');
  return models;
}

/** 모델의 비음수 토큰과 캐시 포함 관계를 원래 검증 순서대로 확인한다. */
function validateModel(model: ModelUsageInput): void {
  nonnegative(model.input_tokens, 'model input tokens');
  nonnegative(model.output_tokens, 'model output tokens');
  if (model.cache_write_input_tokens != null) nonnegative(model.cache_write_input_tokens, 'model cache write tokens');
  if (model.cache_read_input_tokens != null) nonnegative(model.cache_read_input_tokens, 'model cache read tokens');
  if ((model.cache_write_input_tokens ?? 0) + (model.cache_read_input_tokens ?? 0) > model.input_tokens) {
    throw new RangeError('Invalid model cache components');
  }
}

/** Skill 횟수·이름 길이를 검증하고 미수집 상태를 보존한 채 분류·이름순 바인딩 행을 만든다. */
export function capabilityValues(summary: TurnSummaryInput): SQLInputValue[][] | undefined {
  if (summary.capability_usage === undefined) return undefined;
  return [...summary.capability_usage].map(usage => {
    nonnegative(usage.usage_count, 'capability count');
    if (usage.name.length > MAX_CAPABILITY_NAME_LENGTH) throw new RangeError('Capability name is too long');
    return [usage.category, usage.name, usage.usage_count] as SQLInputValue[];
  }).sort(compareCapabilities);
}
