// 통계 표의 표시 기준과 안정적인 페이지 순서에 맞는 SQL 정렬식을 만든다.
import { USAGE_SORT_KEYS, type UsageGrouping, type UsageSort } from './types';

function scopeColumn(grouping: UsageGrouping | 'turn'): string {
  switch (grouping) {
    case 'turn': return 'started_at_ms';
    case 'day':
    case 'month': return 'period';
    case 'session': return 'session_started_at_ms';
    case 'project': return 'project_name';
    default: return 'provider';
  }
}

/**
 * 책임: 표시 값과 일치하는 정렬 및 안정적인 페이지 순서를 만든다.
 * 알고리즘: 허용된 열·방향을 SQL 식으로 매핑하고 미상 값을 뒤로 보낸 뒤 모델 출시일·숫자 버전·고정 식별자를 보조 정렬로 붙인다.
 */
export function usageTableOrder(sort: UsageSort, grouping: UsageGrouping | 'turn', model: boolean, includeCosts = false): string {
  if (!USAGE_SORT_KEYS.includes(sort.key) || !['asc', 'desc'].includes(sort.direction)) throw new RangeError('Unknown table sort');
  const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
  const turn = grouping === 'turn';
  const calendar = grouping === 'day' || grouping === 'month';
  const scope = scopeColumn(grouping);
  const expressions = {
    model: model ? 'agent_tracker_model_release(model)' : 'provider', period: scope,
    input: 'MAX(0, input_tokens - cache_write_input_tokens - cache_read_input_tokens)', output: 'output_tokens',
    cacheWrite: 'cache_write_input_tokens', cacheRead: 'cache_read_input_tokens', tokens: 'total_tokens',
    requests: turn ? 'CAST(1 AS INTEGER)' : 'turn_count', averageTokens: turn ? 'total_tokens' : 'avg_tokens_per_turn',
    averageDuration: turn ? 'duration_ms' : 'avg_duration_ms', cost: includeCosts ? 'cost_usd' : 'NULL',
  };
  const expression = expressions[sort.key];
  const unknown: string[] = [];
  if (turn) unknown.push('started_at_ms IS NULL');
  else if (calendar) unknown.push('period IS NULL');
  if (model) unknown.push("coalesce(model, '') = ''");
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
