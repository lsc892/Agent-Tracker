// 도구 분류별 사용 순위와 전체 비율의 분모를 조회하는 SQL을 만든다.
import type { SummaryFilter } from '../../types';
import { buildQueryFilter } from '../common/filters';
import type { QuerySql } from '../common/types';

/**
 * 책임: 도구 분류별 순위와 전체 비율 계산용 SQL을 만든다.
 * 알고리즘: 제공자·이름별 횟수를 합산하고 선택적으로 같은 그룹 결과에 전체 개수·합계·최댓값의 window 지표를 붙인다.
 */
export function buildCapabilityQueries(filter: SummaryFilter, category: string, withTotals = false): { counts: QuerySql; ranking: QuerySql } {
  if (!['skill', 'subagent', 'plugin', 'model'].includes(category)) throw new RangeError('Unknown capability category');
  const where = buildQueryFilter(filter);
  const source = `(
    SELECT
      t.provider,
      t.project_key,
      t.session_id,
      t.started_at_ms,
      u.category,
      u.name,
      u.usage_count
    FROM turn_summary t
    JOIN turn_capability_usage u ON u.turn_id = t.id
  ) AS turn_summary`;
  const scope = `${where.sql} AND category = ?`;
  const values = [...where.values, category];
  return {
    counts: {
      sql: `SELECT
          count(*) AS total,
          coalesce(sum(uses), 0) AS totalUses,
          coalesce(max(uses), 0) AS maxUses
        FROM (
          SELECT sum(usage_count) AS uses
          FROM ${source}
          WHERE ${scope}
          GROUP BY provider, name
        )`,
      values,
    },
    ranking: {
      sql: `SELECT
          provider,
          category,
          name,
          sum(usage_count) AS usage_count${withTotals ? `,
          count(*) OVER() AS _total,
          sum(sum(usage_count)) OVER() AS _totalUses,
          max(sum(usage_count)) OVER() AS _maxUses` : ''}
        FROM ${source}
        WHERE ${scope}
        GROUP BY provider, name
        ORDER BY name = '', usage_count DESC, provider, name
        LIMIT ?
        OFFSET ?`,
      values,
    },
  };
}
