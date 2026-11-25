// 일별 사전 집계의 병합 지표·테이블·형식 버전을 정의한다.
/** Mergeable states shared by persistent daily tables and exact raw boundary queries. */
export interface RollupState {
  name: string;
  expression: string;
  type: 'INTEGER' | 'REAL' | 'TEXT';
  merge: 'SUM' | 'MAX' | 'MIN';
}

// #region 집계 상태: 총량·완료 표본·세션 시작

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

const RECORDED_USAGE = '(has_recorded_usage = 1)';
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

addState('min_started_at_ms', 'MIN(started_at_ms)', 'INTEGER', 'MIN');
export const DAILY_COST_STATES = [
  { name: 'api_cost_usd', expression: 'SUM(api_cost_usd)', type: 'REAL' },
  { name: 'api_unknown_costs', expression: 'SUM(api_unknown_costs)', type: 'INTEGER' },
  { name: 'cost_components', expression: 'SUM(cost_components)', type: 'INTEGER' },
  { name: 'default_billing_mode', expression: "CASE WHEN MIN(default_billing_mode) = MAX(default_billing_mode) THEN MIN(default_billing_mode) ELSE 'unknown' END", type: 'TEXT' },
  { name: 'recorded_cost_usd', expression: "SUM(CASE default_billing_mode WHEN 'subscription' THEN 0 WHEN 'api' THEN api_cost_usd END)", type: 'REAL' },
  { name: 'recorded_unknown_costs', expression: "SUM(CASE default_billing_mode WHEN 'subscription' THEN 0 WHEN 'api' THEN api_unknown_costs ELSE cost_components END)", type: 'INTEGER' },
] as const;

export const ROLLUP_STATES: readonly RollupState[] = states;
const MODEL_ROLLUP_STATES = states.filter(state => state.name !== 'min_started_at_ms');

/** 모델별 조회의 세션 시작은 요청 daily에서 읽으므로 모델 상태에서는 제외한다. */
export function rollupStates(by: 'provider' | 'model'): readonly RollupState[] {
  return by === 'model' ? MODEL_ROLLUP_STATES : ROLLUP_STATES;
}

export const ROLLUP_FORMAT_VERSION = 3;
export const ROLLUP_TABLES = {
  provider: 'usage_request_daily',
  model: 'usage_model_daily',
} as const;

export function dailyKeyColumns(by: keyof typeof ROLLUP_TABLES): readonly string[] {
  const keys = ['provider', 'session_id', 'project_key', 'local_day'];
  return by === 'model' ? [...keys, 'model_key'] : keys;
}

// #endregion

// #region 일별 집계 테이블 DDL

const dailyTablesSql = (['provider', 'model'] as const).map(by => {
  const table = ROLLUP_TABLES[by];
  const modelColumns = by === 'model' ? 'model TEXT,\n  model_key TEXT NOT NULL,' : '';
  const stateColumns = [...rollupStates(by), ...DAILY_COST_STATES].map(state => `${state.name} ${state.type}`).join(',\n  ');

  return `
CREATE TABLE IF NOT EXISTS ${table} (
  provider TEXT NOT NULL,
  project_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  local_day TEXT NOT NULL,
  ${modelColumns}
  ${stateColumns},
  PRIMARY KEY(${dailyKeyColumns(by).join(', ')})
) WITHOUT ROWID;
`;
}).join('');

/** 영속 일별 합계와 해당 합계를 계산한 시간대. */
export const SCHEMA_ROLLUP_SQL = `
CREATE TABLE IF NOT EXISTS usage_rollup_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  timezone TEXT NOT NULL,
  format_version INTEGER NOT NULL
);
${dailyTablesSql}`;

export const SCHEMA_DAILY_CAPABILITY_SQL = `
CREATE TABLE IF NOT EXISTS usage_capability_daily (
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_key TEXT NOT NULL,
  local_day TEXT NOT NULL,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  usage_count INTEGER NOT NULL,
  PRIMARY KEY(provider, session_id, project_key, local_day, category, name)
) WITHOUT ROWID;`;

// #endregion
