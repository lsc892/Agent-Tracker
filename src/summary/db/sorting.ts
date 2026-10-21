import { USAGE_SORT_KEYS, type UsageGrouping, type UsageSort } from './types';

/** Expressions run on projected rows, so Input matches the cache-exclusive value on screen. */
export function usageTableOrder(sort: UsageSort, grouping: UsageGrouping | 'turn', model: boolean, includeCosts = false): string {
  if (!USAGE_SORT_KEYS.includes(sort.key) || !['asc', 'desc'].includes(sort.direction)) throw new RangeError('Unknown table sort');
  const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
  const turn = grouping === 'turn';
  const calendar = grouping === 'day' || grouping === 'month';
  const scope = turn ? 'started_at_ms' : calendar ? 'period' : grouping === 'session' ? 'session_started_at_ms'
    : grouping === 'project' ? 'project_name' : 'provider';
  const expressions = {
    model: model ? 'agent_tracker_model_release(model)' : 'provider', period: scope,
    input: 'MAX(0, input_tokens - cache_write_input_tokens - cache_read_input_tokens)', output: 'output_tokens',
    cacheWrite: 'cache_write_input_tokens', cacheRead: 'cache_read_input_tokens', tokens: 'total_tokens',
    requests: turn ? 'CAST(1 AS INTEGER)' : 'turn_count', averageTokens: turn ? 'total_tokens' : 'avg_tokens_per_turn',
    averageDuration: turn ? 'duration_ms' : 'avg_duration_ms', cost: includeCosts ? 'cost_usd' : 'NULL',
  };
  const expression = expressions[sort.key];
  const unknown = [
    ...(turn ? ['started_at_ms IS NULL'] : calendar ? ['period IS NULL'] : []),
    ...(model ? ["coalesce(model, '') = ''"] : []),
  ];
  const order = [
    ...(unknown.length > 1 ? [`(${unknown.join(' OR ')})`] : []), ...unknown,
    `${expression} IS NULL`, `${expression} ${direction}`,
    ...(sort.key === 'model' && model ? [`agent_tracker_model_key(model) ${direction}`] : []),
    ...(sort.key !== 'period' ? [`${scope} IS NULL`, `${scope} DESC`] : []),
    'provider', ...(model ? ['model'] : []),
    ...(turn ? ['id'] : ['project_key', 'session_id']),
  ];
  return order.join(', ');
}
