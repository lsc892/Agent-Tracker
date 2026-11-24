// 메모리에서 확정한 토큰·모델 값을 일별 집계 SQL의 입력으로 전달한다.
import type { TurnSummaryInput } from './types';
import { modelValues, validateSummary } from './memoryStore/values';

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
    validateSummary(row);
    const models = modelValues(row);
    const prefix = [row.provider, row.project_key, row.session_id, row.started_at_ms ?? null, row.status,
      row.duration_ms ?? null, row.duration_quality];
    const totals = [row.input_tokens, row.output_tokens, row.total_tokens,
      row.cache_write_input_tokens === undefined ? 0 : row.cache_write_input_tokens,
      row.cache_read_input_tokens === undefined ? 0 : row.cache_read_input_tokens];
    const billing = row.billing ?? 'unknown';
    let apiCost: number | null = null;
    let pricedModels = 0;
    for (const [name, input, output, write, read, price] of models) {
      const total = Number(input) + Number(output);
      if (typeof price === 'number') {
        apiCost = (apiCost ?? 0) + price;
        pricedModels++;
      }
      model.push([...prefix, input, output, total, write, read, name || (total ? '' : null), name ? 1 : 0,
        price, Number(price === null), 1, billing]);
    }
    if (!models.length) model.push([...prefix, ...totals, row.total_tokens ? '' : null, 0, null, 1, 1, billing]);
    provider.push([...prefix, ...totals, null, Number(models.some(([name]) => name !== '')),
      apiCost, Math.max(1, models.length) - pricedModels, Math.max(1, models.length), billing]);
  }
  return { provider: JSON.stringify(provider), model: JSON.stringify(model) };
}
