// 도구 분류별 사용 순위와 전체 비율의 분모를 조회하는 SQL을 만든다.
import type { SummaryFilter } from '../../types';
import type { QuerySql } from '../common/types';
import { buildDailyUsageFilter } from './source';

/**
 * 책임: 도구 분류별 순위와 전체 비율 계산용 SQL을 만든다.
 * 알고리즘: 제공자·이름별 횟수를 합산하고 선택적으로 같은 그룹 결과에 전체 개수·합계·최댓값의 window 지표를 붙인다.
 */
export function buildCapabilityQueries(filter: SummaryFilter, category: string, withTotals = false, timezone = 'UTC'): { counts: QuerySql; ranking: QuerySql } {
  // [SQL 필터 정책] 분류를 검증하고 통계 시간대의 일별 범위에 분류 조건을 결합한다.
  if (!['skill', 'subagent', 'plugin', 'model'].includes(category)) throw new RangeError('Unknown capability category');
  const where = buildDailyUsageFilter(filter, timezone);
  const scope = `${where.sql} AND category = ?`;
  const values = [...where.values, category];

  // [집계 정책] 제공자·이름별 횟수를 합산해 전체 지표를 구하고 순위에서 이름 미상을 뒤에 둔다.
  return {
    counts: {
      sql: `SELECT
          count(*) AS total,
          coalesce(sum(uses), 0) AS totalUses,
          coalesce(max(uses), 0) AS maxUses
        FROM (
          SELECT sum(usage_count) AS uses
          FROM usage_capability_daily AS usage
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
        FROM usage_capability_daily AS usage
        WHERE ${scope}
        GROUP BY provider, name
        ORDER BY name = '', usage_count DESC, provider, name
        LIMIT ?
        OFFSET ?`,
      values,
    },
  };
}
