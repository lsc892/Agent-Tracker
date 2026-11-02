// 통계 표의 표시 기준과 안정적인 페이지 순서에 맞는 SQL 정렬식을 만든다.
import { USAGE_SORT_KEYS, type UsageGrouping, type UsageSort } from '../../types';
import type { UsageBasis } from './types';

// #region 그룹별 표시 기준 열

function scopeColumn(grouping: UsageGrouping | 'turn'): string {
  switch (grouping) {
    case 'turn':
      return 'started_at_ms';
    case 'day':
    case 'month':
      return 'period';
    case 'session':
      return 'session_started_at_ms';
    case 'project':
      return 'project_name';
    default:
      return 'provider';
  }
}

// #endregion

// #region 표 전체 정렬과 안정적인 페이지 순서

/**
 * 책임: 표시 값과 일치하는 정렬 및 안정적인 페이지 순서를 만든다.
 * 알고리즘: 허용된 열·방향을 SQL 식으로 매핑하고 미상 값을 뒤로 보낸 뒤 모델 출시일·숫자 버전·고정 식별자를 보조 정렬로 붙인다.
 */
export function usageTableOrder(sort: UsageSort, grouping: UsageGrouping | 'turn', model: boolean, includeCosts = false): string {
  if (!USAGE_SORT_KEYS.includes(sort.key) || !['asc', 'desc'].includes(sort.direction)) {
    throw new RangeError('Unknown table sort');
  }
  const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
  const isTurn = grouping === 'turn';
  const isCalendar = grouping === 'day' || grouping === 'month';
  const scope = scopeColumn(grouping);

  const expressions = {
    model: model ? 'agent_tracker_model_release(model)' : 'provider',
    period: scope,
    input: 'MAX(0, input_tokens - cache_write_input_tokens - cache_read_input_tokens)',
    output: 'output_tokens',
    cacheWrite: 'cache_write_input_tokens',
    cacheRead: 'cache_read_input_tokens',
    tokens: 'total_tokens',
    requests: isTurn ? 'CAST(1 AS INTEGER)' : 'turn_count',
    averageTokens: isTurn ? 'total_tokens' : 'avg_tokens_per_turn',
    averageDuration: isTurn ? 'duration_ms' : 'avg_duration_ms',
    cost: includeCosts ? 'cost_usd' : 'NULL',
  };
  const expression = expressions[sort.key];

  // 시간·모델 미상 값은 선택 열의 오름차순·내림차순과 관계없이 뒤로 보낸다.
  const unknown: string[] = [];
  if (isTurn) unknown.push('started_at_ms IS NULL');
  else if (isCalendar) unknown.push('period IS NULL');
  if (model) unknown.push("coalesce(model, '') = ''");

  const order = [
    ...(unknown.length > 1 ? [`(${unknown.join(' OR ')})`] : []),
    ...unknown,
    `${expression} IS NULL`,
    `${expression} ${direction}`,
  ];
  if (sort.key === 'model' && model) {
    order.push(`agent_tracker_model_key(model) ${direction}`);
  }
  if (sort.key !== 'period') {
    order.push(`${scope} IS NULL`, `${scope} DESC`);
  }

  // 표시 값이 같아도 페이지 순서가 바뀌지 않도록 고정 식별자를 붙인다.
  order.push('provider');
  if (model) order.push('model');
  order.push(...(isTurn ? ['id'] : ['project_key', 'session_id']));

  return order.join(', ');
}

// #endregion

// #region 시간·모델 미상 우선순위

export function unknownOrder(by: UsageBasis, time?: string): string {
  const flags: string[] = [];
  if (time) flags.push(time);
  if (by === 'model') flags.push("coalesce(model, '') = ''");
  if (!flags.length) return '';

  const combined = flags.length > 1 ? `(${flags.join(' OR ')}), ` : '';
  return `${combined}${flags.join(', ')}, `;
}

// #endregion
