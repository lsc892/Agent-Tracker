// 저장된 파일·요청의 진단 목록과 처리 상태 개수를 조회하는 SQL을 만든다.
import type { SummaryFilter } from '../../types';
import { buildQueryFilter } from '../common/filters';
import type { QuerySql } from '../common/types';
import { namedTurns } from './source';

/**
 * 책임: 원본을 다시 스캔하지 않고 저장된 진단과 처리 범위를 조회한다.
 * 알고리즘: 같은 필터로 manifest 페이지·오류 또는 품질 플래그가 있는 요청 페이지·상태별 개수를 각각 만들고 ID 기반 페이지 조건을 붙인다.
 */
export function buildDiagnosticQueries(filter: SummaryFilter): { files: QuerySql; summaries: QuerySql; counts: QuerySql } {
  const where = buildQueryFilter(filter);
  return {
    files: {
      sql: `SELECT *
        FROM manifest
        WHERE ${where.sql} AND id > ?
        ORDER BY id
        LIMIT ?
        OFFSET ?`,
      values: where.values,
    },
    summaries: {
      sql: `SELECT *
        FROM ${namedTurns()} AS turn_summary
        WHERE ${where.sql} AND id > ? AND (
          last_error IS NOT NULL
          OR (quality_flags IS NOT NULL AND quality_flags <> '[]' AND quality_flags <> '')
        )
        ORDER BY id
        LIMIT ?
        OFFSET ?`,
      values: where.values,
    },
    counts: {
      sql: `SELECT
        COUNT(*) AS files,
        COALESCE(SUM(processing_status = 'processing'), 0) AS processing,
        COALESCE(SUM(processing_status = 'done'), 0) AS done,
        COALESCE(SUM(processing_status = 'error'), 0) AS error,
        COALESCE(SUM(processing_status = 'interrupted'), 0) AS interrupted,
        (
          SELECT COUNT(*)
          FROM turn_summary
          WHERE ${where.sql} AND last_error IS NOT NULL
        ) AS stale_summaries
      FROM manifest
      WHERE ${where.sql}`,
      values: [...where.values, ...where.values],
    },
  };
}
