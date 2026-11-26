// 저장된 파일의 진단 목록과 처리 상태 개수를 조회하는 SQL을 만든다.
import type { Provider, SummaryFilter } from '../../types';
import { buildQueryFilter } from '../common/filters';
import type { QuerySql } from '../common/types';

/**
 * 책임: 원본을 다시 스캔하지 않고 저장된 진단과 처리 범위를 조회한다.
 * 알고리즘: 같은 필터로 파일 목록과 상태별 개수를 만들고 ID 기반 페이지 조건을 붙인다.
 */
export function buildDiagnosticQueries(filter: Pick<SummaryFilter, 'providers'>): { files: QuerySql; counts: QuerySql } {
  // [페이지 정책] 동일 제공자 범위에서 커서보다 큰 파일 ID를 읽고 개수는 범위 전체에서 센다.
  const where = buildQueryFilter(filter);
  return {
    files: {
      sql: `SELECT *
        FROM source_file
        WHERE ${where.sql} AND id > ?
        ORDER BY id
        LIMIT ?
        OFFSET ?`,
      values: where.values,
    },
    counts: diagnosticCounts(where),
  };
}

export function buildDiagnosticCountsQuery(providers?: Provider[]): QuerySql {
  return diagnosticCounts(buildQueryFilter({ providers }));
}

function diagnosticCounts(where: QuerySql): QuerySql {
  // [진단 정책] 상태별 파일을 세고 실패·중단 세션의 기존 요약은 세션 중복을 제거한 뒤 합산한다.
  return {
    sql: `SELECT
        COUNT(*) AS files,
        COALESCE(SUM(processing_status = 'processing'), 0) AS processing,
        COALESCE(SUM(processing_status = 'done'), 0) AS done,
        COALESCE(SUM(processing_status = 'error'), 0) AS error,
        COALESCE(SUM(processing_status = 'interrupted'), 0) AS interrupted,
        (SELECT COALESCE(SUM(d.turn_count), 0)
          FROM (SELECT DISTINCT provider, session_id FROM source_file
            WHERE ${where.sql} AND processing_status IN ('error', 'interrupted')) f
          CROSS JOIN usage_request_daily d ON d.provider=f.provider AND d.session_id=f.session_id) AS stale_summaries
      FROM source_file
      WHERE ${where.sql}`,
    values: [...where.values, ...where.values],
  };
}
