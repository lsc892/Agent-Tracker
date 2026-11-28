// 도구 분류별 사용 순위와 전체 비율의 분모를 조회하는 SQL을 만든다.
import type { CapabilityCategory, SummaryFilter } from '../../types';
import type { QuerySql } from '../common/types';
import { buildDailyUsageFilter } from './source';

export const CAPABILITY_CATEGORIES = ['skill', 'subagent', 'plugin', 'model'] as const;
const CAPABILITY_ORDER = "name = '', usage_count DESC, provider, name";

/**
 * 책임: 도구 분류별 순위와 전체 비율 계산용 SQL을 만든다.
 * 알고리즘: 제공자·이름별 횟수를 합산하고 선택적으로 같은 그룹 결과에 전체 개수·합계·최댓값의 window 지표를 붙인다.
 */
export function buildCapabilityQueries(filter: SummaryFilter, category: string, withTotals = false, timezone = 'UTC'): { counts: QuerySql; ranking: QuerySql } {
  // [SQL 필터 정책] 분류를 검증하고 통계 시간대의 일별 범위에 분류 조건을 결합한다.
  if (!CAPABILITY_CATEGORIES.some(value => value === category)) throw new RangeError('Unknown capability category');
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
        ORDER BY ${CAPABILITY_ORDER}
        LIMIT ?
        OFFSET ?`,
      values,
    },
  };
}

/** 공통 일별 범위를 한 번 읽고 각 분류의 페이지와 전체 비율의 분모를 반환한다. */
export function buildCapabilityPagesQuery(filter: SummaryFilter,
  pages: readonly (readonly [category: CapabilityCategory, offset: number, limit: number])[], timezone: string): QuerySql {
  const where = buildDailyUsageFilter(filter, timezone);
  const pageValues = pages.map(() => '(?,?,?)').join(', ');
  return {
    sql: `WITH page_config(category, offset_rows, page_rows) AS (VALUES ${pageValues}),
      grouped AS (
        SELECT category, provider, name, SUM(usage_count) AS usage_count
        FROM usage_capability_daily AS usage
        WHERE ${where.sql} AND category IN (SELECT category FROM page_config)
        GROUP BY category, provider, name
      ), ranked AS (
        SELECT category, provider, name, usage_count,
          ROW_NUMBER() OVER category_rank AS position,
          COUNT(*) OVER category_rank AS _total,
          SUM(usage_count) OVER category_rank AS _totalUses,
          MAX(usage_count) OVER category_rank AS _maxUses
        FROM grouped
        WINDOW category_rank AS (PARTITION BY category ORDER BY ${CAPABILITY_ORDER}
          ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
      )
      SELECT category, provider, name, usage_count, _total, _totalUses, _maxUses,
        position > offset_rows AS in_page
      FROM ranked JOIN page_config USING (category)
      WHERE (position > offset_rows AND position <= offset_rows + page_rows)
        OR (position = 1 AND _total <= offset_rows)
      ORDER BY category, position`,
    values: [...pages.flat(), ...where.values],
  };
}
