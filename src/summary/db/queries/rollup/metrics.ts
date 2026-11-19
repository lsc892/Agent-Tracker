// 일별 집계 상태를 병합해 통계 합계·평균·품질 지표 SQL을 만든다.

const CACHE_COLUMNS = ['cache_write_input_tokens', 'cache_read_input_tokens'];

/**
 * 책임: 일별 상태를 병합해 원본 조회와 같은 합계·평균을 복원한다.
 * 알고리즘: 완료 표본의 합계·분모와 캐시 미상 규칙으로 평균을 구하고, 도표에 필요한 토큰 구성별 평균만 병합한다.
 */
export function mergeRollupMetrics(excludeEmptyUsage = false, includeComponentAverages = true): string {
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
  const totalTokenAverage = `${average(`${prefix}_total_tokens`, completedTurns)} AS avg_tokens_per_turn`;
  const componentAverages = includeComponentAverages
    ? [
      `${average(`${prefix}_input_tokens`, completedTurns)} AS avg_input_tokens`,
      `${average(`${prefix}_output_tokens`, completedTurns)} AS avg_output_tokens`,
      ...CACHE_COLUMNS.map(field => `CASE
        WHEN ${sum(`${prefix}_${field}_known`)} = ${sum(completedTurns)}
        THEN ${average(`${prefix}_${field}`, completedTurns)}
      END AS avg_${field}`),
    ]
    : [
      'NULL AS avg_input_tokens',
      'NULL AS avg_output_tokens',
      'NULL AS avg_cache_write_input_tokens',
      'NULL AS avg_cache_read_input_tokens',
    ];
  // #endregion

  // #region 알려진 소요 시간의 평균·품질
  const durationMetrics = [
    `${average(`${prefix}_duration_ms`, `${prefix}_duration_ms_known`)} AS avg_duration_ms`,
    `${sum(`${prefix}_duration_ms_known`)} AS turns_with_duration`,
    ...['exact', 'derived', 'approximate'].map(quality => `${sum(`${prefix}_${quality}`)} AS ${quality}_duration_turns`),
    `${sum(`${prefix}_duration_missing`)} AS missing_duration_turns`,
  ];
  // #endregion

  return [
    ...tokenTotals, ...cacheTotals, ...requestTotals,
    totalTokenAverage, ...componentAverages,
    ...durationMetrics,
  ].join(',\n      ');
}

function sum(field: string): string {
  return `SUM(${field})`;
}

function average(field: string, denominator: string): string {
  return `1.0 * SUM(${field}) / NULLIF(SUM(${denominator}), 0)`;
}
