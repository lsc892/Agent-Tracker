// 일별 집계에 전달할 토큰과 모델 추정 비용을 검증한다.
import type { ModelUsageInput, TurnSummaryInput } from '../types';
import { nonnegative } from '../validation';
import { estimateCost } from '../../models/pricing';

type PricedModel = [name: string, input: number, output: number, cacheWrite: number | null, cacheRead: number | null, price: number | null];

/** 요청의 수치 범위와 토큰 합계·캐시 포함 관계를 기존 순서대로 검사한다. */
export function validateSummary(row: TurnSummaryInput): void {
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

/** 모델별 사용량을 검증하고 스레드 합계와 같은지 확인한 뒤 추정 비용을 붙인다. */
export function modelValues(summary: TurnSummaryInput): PricedModel[] {
  if (!summary.model_usage) return [];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  const models: PricedModel[] = [];
  for (const model of summary.model_usage) {
    validateModel(model);
    input += model.input_tokens;
    output += model.output_tokens;
    cacheRead += model.cache_read_input_tokens ?? 0;
    cacheWrite += model.cache_write_input_tokens ?? 0;
    models.push([
      model.model, model.input_tokens, model.output_tokens, model.cache_write_input_tokens, model.cache_read_input_tokens,
      estimateCost(summary.provider, model),
    ]);
  }
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
