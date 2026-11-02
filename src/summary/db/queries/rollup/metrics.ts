// 일별 집계 상태를 병합해 통계 합계·평균·품질 지표 SQL을 만든다.

const CACHE_COLUMNS = ['cache_write_input_tokens', 'cache_read_input_tokens'];

/**
 * 책임: 일별 상태를 병합해 원본 조회와 같은 합계·평균을 복원한다.
 * 알고리즘: 완료 표본의 합계와 분모로 평균을 구하고, 전체 표본에서 알려진 캐시만 확정한다.
 */
export function mergeRollupMetrics(excludeEmptyUsage = false): string {
  const prefix = excludeEmptyUsage ? 'r' : 'c';
  const completedTurns = excludeEmptyUsage ? 'recorded_completed_turns' : 'completed_turns';

  // #region 전체 상태의 토큰·요청 합계
  const tokenTotals = ['input_tokens', 'output_tokens'].map(field => `${sum(field)} AS ${field}`);
  const cacheTotals = CACHE_COLUMNS.map(field => `CASE
        WHEN ${sum(`${field}_known`)} = ${sum('turn_count')}
        THEN ${sum(field)}
      END AS ${field}`);
  const requestTotals = [
    'total_tokens', 'turn_count', 'completed_turns', 'recorded_turns', 'recorded_completed_turns',
  ].map(field => `${sum(field)} AS ${field}`);
  // #endregion

  // #region 완료 표본의 토큰·캐시 평균
  const tokenAverages = [
    ['total_tokens', 'avg_tokens_per_turn'],
    ['input_tokens', 'avg_input_tokens'],
    ['output_tokens', 'avg_output_tokens'],
  ].map(([field, alias]) => `${average(`${prefix}_${field}`, completedTurns)} AS ${alias}`);
  const cacheAverages = CACHE_COLUMNS.map(field => `CASE
        WHEN ${sum(`${prefix}_${field}_known`)} = ${sum(completedTurns)}
        THEN ${average(`${prefix}_${field}`, completedTurns)}
      END AS avg_${field}`);
  // #endregion

  // #region 알려진 소요 시간의 평균·품질과 진단 지표
  const durationMetrics = [
    `${average(`${prefix}_duration_ms`, `${prefix}_duration_ms_known`)} AS avg_duration_ms`,
    `${sum(`${prefix}_duration_ms_known`)} AS turns_with_duration`,
    ...['exact', 'derived', 'approximate'].map(quality => `${sum(`${prefix}_${quality}`)} AS ${quality}_duration_turns`),
    `${sum(`${prefix}_duration_missing`)} AS missing_duration_turns`,
  ];
  const diagnostics = [
    ...['unknown_time_turns', 'stale_turns'].map(field => `${sum(field)} AS ${field}`),
    'MAX(last_successful_update) AS last_successful_update',
  ];
  // #endregion

  return [
    ...tokenTotals, ...cacheTotals, ...requestTotals,
    ...tokenAverages, ...cacheAverages,
    ...durationMetrics, ...diagnostics,
  ].join(',\n      ');
}

function sum(field: string): string {
  return `SUM(${field})`;
}

function average(field: string, denominator: string): string {
  return `1.0 * SUM(${field}) / NULLIF(SUM(${denominator}), 0)`;
}
