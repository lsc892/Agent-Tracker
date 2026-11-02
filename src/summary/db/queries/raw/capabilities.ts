// 도구 분류별 사용 순위와 전체 비율의 분모를 조회하는 SQL을 만든다.
import type { SummaryFilter } from '../../types';
import { buildQueryFilter } from '../common/filters';
import type { QuerySql } from '../common/types';

/**
 * 책임: 도구 분류별 순위와 전체 비율 계산용 SQL을 만든다.
 * 알고리즘: 동일한 필터·category 조건으로 제공자·이름별 횟수를 합산하고 전체 합계·최댓값과 페이지 순위를 각각 조회한다.
 */
export function buildCapabilityQueries(filter: SummaryFilter, category: string): { counts: QuerySql; ranking: QuerySql } {
  if (!['skill', 'subagent', 'plugin', 'model'].includes(category)) throw new RangeError('Unknown capability category');
  const where = buildQueryFilter(filter);
  const source = `(
    SELECT
      t.*,
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
          sum(usage_count) AS usage_count
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
