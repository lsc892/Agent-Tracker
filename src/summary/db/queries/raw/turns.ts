// 요청 상세 목록과 전체 개수를 동일한 조건으로 조회하는 SQL을 만든다.
import type { SummaryFilter, UsageSort } from '../../types';
import { buildQueryFilter } from '../common/filters';
import { unknownOrder, usageTableOrder } from '../common/sorting';
import type { QuerySql, UsageBasis } from '../common/types';
import { namedTurns, RECORDED_USAGE, usageTurns } from './source';

export function buildTurnsQuery(where: QuerySql, includeCosts: boolean | undefined, by: UsageBasis, unknownLast = false, tableSort?: UsageSort): QuerySql {
  const unknownPriority = unknownLast ? unknownOrder(by, 'started_at_ms IS NULL') : '';
  const source = namedTurns(includeCosts, by);
  const order = tableSort
    ? usageTableOrder(tableSort, 'turn', by === 'model', includeCosts)
    : `${unknownPriority}id${by === 'model' ? ', model' : ''}`;
  return {
    sql: `SELECT
        *,
        ${RECORDED_USAGE} AS has_recorded_usage
      FROM ${source} AS turn_summary
      WHERE ${where.sql} AND id > ?
      ORDER BY ${order}
      LIMIT ?
      OFFSET ?`,
    values: where.values,
  };
}

export function buildTurnsCountQuery(filter: SummaryFilter, by: UsageBasis): QuerySql {
  const where = buildQueryFilter(filter);
  return {
    sql: `SELECT COUNT(*) AS count
      FROM ${usageTurns(false, by)} AS turn_summary
      WHERE ${where.sql}`,
    values: where.values,
  };
}
