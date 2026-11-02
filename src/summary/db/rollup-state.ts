// 일별 사전 집계의 병합 지표·테이블·형식 버전을 정의한다.
/** Mergeable states shared by persistent daily tables and exact raw boundary queries. */
export interface RollupState {
  name: string;
  expression: string;
  type: 'INTEGER' | 'REAL' | 'TEXT';
  merge: 'SUM' | 'MAX' | 'MIN';
}

// #region 집계 상태: 총량·완료 표본·진단

// 평균 대신 합계와 분모를 저장해 여러 날짜를 다시 병합할 수 있게 한다.
const states: RollupState[] = [];
const addState = (
  name: string,
  expression: string,
  type: RollupState['type'] = 'INTEGER',
  merge: RollupState['merge'] = 'SUM',
): void => {
  states.push({ name, expression, type, merge });
};

const RECORDED_USAGE = '(total_tokens > 0 OR has_model = 1)';
const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'total_tokens'];
const CACHE_FIELDS = ['cache_write_input_tokens', 'cache_read_input_tokens'];

// 총량에는 모든 상태를 포함하고, 캐시 미상 여부를 별도 개수로 보존한다.
for (const field of TOKEN_FIELDS) {
  addState(field, `SUM(${field})`);
}
addState('turn_count', 'COUNT(*)');
addState('completed_turns', "SUM(status = 'completed')");
addState('recorded_turns', `SUM(${RECORDED_USAGE})`);
addState('recorded_completed_turns', `SUM(status = 'completed' AND ${RECORDED_USAGE})`);
for (const field of CACHE_FIELDS) {
  addState(field, `coalesce(SUM(${field}),0)`);
  addState(`${field}_known`, `COUNT(${field})`);
}

// c는 완료 전체, r은 사용량이 기록된 완료 표본이다.
const COMPLETED_SAMPLES = [
  { prefix: 'c', condition: "status = 'completed'" },
  { prefix: 'r', condition: `status = 'completed' AND ${RECORDED_USAGE}` },
];
const AVERAGE_FIELDS = [...TOKEN_FIELDS, ...CACHE_FIELDS, 'duration_ms'];
const DURATION_QUALITIES = ['exact', 'derived', 'approximate'];

for (const { prefix, condition } of COMPLETED_SAMPLES) {
  for (const field of AVERAGE_FIELDS) {
    // AVG(duration_ms) uses floating-point accumulation in the raw query as well.
    const value = field === 'duration_ms' ? '1.0 * duration_ms' : field;
    const type = field === 'duration_ms' ? 'REAL' : 'INTEGER';
    addState(`${prefix}_${field}`, `coalesce(SUM(CASE WHEN ${condition} THEN ${value} END),0)`, type);
    if (field.startsWith('cache_') || field === 'duration_ms') {
      addState(`${prefix}_${field}_known`, `COUNT(CASE WHEN ${condition} THEN ${field} END)`);
    }
  }
  for (const quality of DURATION_QUALITIES) {
    addState(`${prefix}_${quality}`, `SUM(${condition} AND duration_quality = '${quality}')`);
  }
  addState(`${prefix}_duration_missing`, `SUM(${condition} AND duration_ms IS NULL)`);
}

addState('unknown_time_turns', 'SUM(started_at_ms IS NULL)');
addState('stale_turns', 'SUM(last_error IS NOT NULL)');
addState('last_successful_update', 'MAX(updated_at)', 'TEXT', 'MAX');
addState('min_started_at_ms', 'MIN(started_at_ms)', 'INTEGER', 'MIN');

export const ROLLUP_STATES: readonly RollupState[] = states;
export const ROLLUP_FORMAT_VERSION = 1;
export const ROLLUP_TABLES = {
  provider: 'usage_request_daily',
  model: 'usage_model_daily',
} as const;

// #endregion

// #region 일별 집계 테이블 DDL

const dailyTablesSql = (['provider', 'model'] as const).map(by => {
  const table = ROLLUP_TABLES[by];
  const modelColumns = by === 'model' ? 'model TEXT,\n  model_key TEXT NOT NULL,' : '';
  const stateColumns = states.map(state => `${state.name} ${state.type}`).join(',\n  ');
  const modelKey = by === 'model' ? ', model_key' : '';

  return `
CREATE TABLE IF NOT EXISTS ${table} (
  provider TEXT NOT NULL,
  project_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  local_day TEXT NOT NULL,
  ${modelColumns}
  ${stateColumns},
  PRIMARY KEY(provider, session_id, project_key, local_day${modelKey})
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_${table}_day
  ON ${table}(local_day, provider);
CREATE INDEX IF NOT EXISTS idx_${table}_project_day
  ON ${table}(provider, project_key, local_day);
`;
}).join('');

/** Empty derived tables are migrated immediately; facts are materialized only on first use. */
export const SCHEMA_ROLLUP_SQL = `
CREATE TABLE IF NOT EXISTS usage_rollup_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  timezone TEXT NOT NULL,
  format_version INTEGER NOT NULL
);
${dailyTablesSql}`;

// #endregion
