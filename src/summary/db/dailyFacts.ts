// 메모리에서 확정한 토큰·모델 값을 일별 집계 SQL의 입력으로 전달한다.
import type { TurnSummaryInput } from './types';
import { modelValues, validateSummary } from './memoryStore/values';

// [DTO 정책] 제공자·모델 배열의 필드 순서를 한 곳에서 정의해 SQL의 위치 기반 역직렬화에 사용한다.
const columns = [
  'provider', 'project_key', 'session_id', 'started_at_ms', 'status', 'duration_ms', 'duration_quality',
  'input_tokens', 'output_tokens', 'total_tokens', 'cache_write_input_tokens', 'cache_read_input_tokens',
  'model', 'has_model', 'api_cost_usd', 'api_unknown_costs', 'cost_components', 'default_billing_mode',
];

export const DAILY_FACTS_SOURCE = `(SELECT ${columns.map((column, index) =>
  `json_extract(value, '$[${index}]') AS ${column}`).join(', ')} FROM json_each(?))`;

export function dailyFacts(summaries: readonly TurnSummaryInput[]): { provider: string; model: string } {
  const provider: unknown[][] = [];
  const model: unknown[][] = [];
  for (const row of summaries) {
    // [DTO 정책] 요약을 검증하고 제공자·모델 행에 공통으로 들어갈 식별자와 시간 필드를 만든다.
    validateSummary(row);
    const models = modelValues(row);
    const prefix = [row.provider, row.project_key, row.session_id, row.started_at_ms ?? null, row.status,
      row.duration_ms ?? null, row.duration_quality];
    const { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens,
      cache_write_input_tokens: cacheWrite = 0, cache_read_input_tokens: cacheRead = 0 } = row;
    const billing = row.billing ?? 'unknown';

    // [DTO 정책] 모델별 토큰·가격을 펼치고 모델 행이 없으면 스레드 전체 사용량을 대체 행으로 넣는다.
    let hasModel = false;
    let apiCost: number | null = null;
    let pricedModels = 0;
    for (const [name, input, output, write, read, price] of models) {
      const total = input + output;
      hasModel ||= name !== '';
      if (typeof price === 'number') {
        apiCost = (apiCost ?? 0) + price;
        pricedModels++;
      }
      model.push([...prefix, input, output, total, write, read, name || (total ? '' : null), name ? 1 : 0,
        price, Number(price === null), 1, billing]);
    }
    if (!models.length) model.push([...prefix, inputTokens, outputTokens, totalTokens, cacheWrite, cacheRead,
      totalTokens ? '' : null, 0, null, 1, 1, billing]);

    // [DTO 정책] 제공자 행에 전체 토큰과 확인된 비용 합계, 가격을 알 수 없는 항목 수를 담는다.
    const costComponents = Math.max(1, models.length);
    provider.push([...prefix, inputTokens, outputTokens, totalTokens, cacheWrite, cacheRead, null, Number(hasModel),
      apiCost, costComponents - pricedModels, costComponents, billing]);
  }
  // [DTO 정책] 제공자와 모델의 행 배열을 각각 JSON으로 변환해 집계 SQL에 전달한다.
  return { provider: JSON.stringify(provider), model: JSON.stringify(model) };
}
