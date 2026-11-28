// 메모리에서 확정한 토큰·모델 값을 일별 집계 SQL의 입력으로 전달한다.
import type { TurnSummaryInput } from './types';
import { modelValues, validateSummary } from './memoryStore/values';
import { calendarPeriod } from './timezone';

// [DTO 정책] 제공자·모델 배열의 필드 순서를 한 곳에서 정의해 SQL의 위치 기반 역직렬화에 사용한다.
const columns = [
  'provider', 'project_key', 'session_id', 'started_at_ms', 'status', 'duration_ms', 'duration_quality',
  'input_tokens', 'output_tokens', 'total_tokens', 'cache_write_input_tokens', 'cache_read_input_tokens',
  'model', 'has_model', 'api_cost_usd', 'api_unknown_costs', 'cost_components', 'default_billing_mode', 'local_day',
];

export const DAILY_FACTS_SOURCE = `(SELECT ${columns.map((column, index) =>
  `json_extract(value, '$[${index}]') AS ${column}`).join(', ')} FROM json_each(?))`;

type RequestKey = [provider: string, session: string, project: string, day: string];

export function dailyFacts(summaries: readonly TurnSummaryInput[], timezone: string):
{ provider: string; model: string; requestKeys: string; modelKeys: string } {
  const provider: unknown[][] = [];
  const model: unknown[][] = [];
  const byRequestKey = new Map<string, { key: RequestKey; models: Set<string | null> }>();
  for (const row of summaries) {
    // [DTO 정책] 요약을 검증하고 제공자·모델 행에 공통으로 들어갈 식별자와 시간 필드를 만든다.
    validateSummary(row);
    const models = modelValues(row);
    const started = row.started_at_ms ?? null;
    const day = started !== null && Number.isFinite(started) ? calendarPeriod(started, timezone, 'day') : '';
    const requestKey: RequestKey = [row.provider, row.session_id, row.project_key, day];
    const encodedKey = JSON.stringify(requestKey);
    let keys = byRequestKey.get(encodedKey);
    if (!keys) byRequestKey.set(encodedKey, keys = { key: requestKey, models: new Set() });
    const prefix = [row.provider, row.project_key, row.session_id, started, row.status,
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
      const modelName = name || (total ? '' : null);
      hasModel ||= name !== '';
      if (typeof price === 'number') {
        apiCost = (apiCost ?? 0) + price;
        pricedModels++;
      }
      model.push([...prefix, input, output, total, write, read, modelName, name ? 1 : 0,
        price, Number(price === null), 1, billing, day]);
      keys.models.add(modelName);
    }
    if (!models.length) {
      const modelName = totalTokens ? '' : null;
      model.push([...prefix, inputTokens, outputTokens, totalTokens, cacheWrite, cacheRead,
        modelName, 0, null, 1, 1, billing, day]);
      keys.models.add(modelName);
    }

    // [DTO 정책] 제공자 행에 전체 토큰과 확인된 비용 합계, 가격을 알 수 없는 항목 수를 담는다.
    const costComponents = Math.max(1, models.length);
    provider.push([...prefix, inputTokens, outputTokens, totalTokens, cacheWrite, cacheRead, null, Number(hasModel),
      apiCost, costComponents - pricedModels, costComponents, billing, day]);
  }
  // [DTO 정책] 삭제에는 일별 그룹 키만 전달한다. NULL과 빈 모델명을 구분한다.
  const modelKeys = [];
  for (const { key, models } of byRequestKey.values()) {
    for (const name of models) modelKeys.push([...key, name]);
  }
  return { provider: JSON.stringify(provider), model: JSON.stringify(model),
    requestKeys: `[${[...byRequestKey.keys()].join(',')}]`, modelKeys: JSON.stringify(modelKeys) };
}
