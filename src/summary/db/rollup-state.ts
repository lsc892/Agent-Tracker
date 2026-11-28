// 일별 사전 집계의 병합 지표·테이블·형식 버전을 정의한다.
/** Mergeable states shared by persistent daily tables and exact raw boundary queries. */
export interface RollupState {
  name: string;
  expression: string;
  type: 'INTEGER' | 'REAL' | 'TEXT';
  merge: 'SUM' | 'MAX' | 'MIN';
}

// #region 집계 상태: 총량·완료 표본·세션 시작

// [집계 정책] 저장할 상태를 합계와 분모로 나눠 여러 날짜를 다시 병합할 수 있게 한다.
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
const TOKEN_FIELDS = ['input_tokens', 'output_tokens'];
const CACHE_FIELDS = ['cache_write_input_tokens', 'cache_read_input_tokens'];

// [집계 정책] 총량은 모든 상태를 포함하고 캐시가 알려진 표본 수는 별도로 보존한다.
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

// [집계 정책] c는 완료 전체, r은 사용량이 기록된 완료 표본으로 평균의 분모를 구분한다.
const COMPLETED_SAMPLES = [
  { prefix: 'c', condition: "status = 'completed'" },
  { prefix: 'r', condition: `status = 'completed' AND ${RECORDED_USAGE}` },
];
const DURATION_QUALITIES = ['exact', 'derived', 'approximate'];

// [집계 정책] 사용량 미기록 요청의 입력·출력은 0이므로 두 표본에서 같은 토큰 합계를 쓴다.
for (const field of TOKEN_FIELDS) {
  addState(`c_${field}`, `coalesce(SUM(CASE WHEN status = 'completed' THEN ${field} END),0)`);
}

for (const { prefix, condition } of COMPLETED_SAMPLES) {
  // [집계 정책] 캐시·시간 합계와 알려진 건수는 표본별로 남긴다.
  for (const field of [...CACHE_FIELDS, 'duration_ms']) {
    // [집계 정책] 상세 조회의 AVG와 같게 소요 시간은 실수로 누적한다.
    const value = field === 'duration_ms' ? '1.0 * duration_ms' : field;
    const type = field === 'duration_ms' ? 'REAL' : 'INTEGER';
    addState(`${prefix}_${field}`, `coalesce(SUM(CASE WHEN ${condition} THEN ${value} END),0)`, type);
    addState(`${prefix}_${field}_known`, `COUNT(CASE WHEN ${condition} THEN ${field} END)`);
  }
  // [집계 정책] 소요 시간의 품질 분류와 누락 건수를 각각 센다.
  for (const quality of DURATION_QUALITIES) {
    addState(`${prefix}_${quality}`, `SUM(${condition} AND duration_quality = '${quality}')`);
  }
}

addState('min_started_at_ms', 'MIN(started_at_ms)', 'INTEGER', 'MIN');

// [결제 정책] API 추정 비용과 실제 결제 유형 기준 비용을 따로 합치고 미확정 성분 수도 보존한다.
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
  // [스키마 정책] 두 집계가 제공자·세션·프로젝트·현지 날짜 키를 공유하고 모델 집계는 모델 키를 추가한다.
  const keys = ['provider', 'session_id', 'project_key', 'local_day'];
  return by === 'model' ? [...keys, 'model_key'] : keys;
}

// #endregion

// #region 일별 집계 테이블 DDL

type RollupBasis = keyof typeof ROLLUP_TABLES;

function dailyTableColumns(by: RollupBasis): readonly { name: string; type: string }[] {
  const dimensions = ['provider', 'project_key', 'session_id', 'local_day'].map(name => ({ name, type: 'TEXT NOT NULL' }));
  if (by === 'model') dimensions.push({ name: 'model_key', type: 'TEXT NOT NULL' });
  return [...dimensions, ...rollupStates(by), ...DAILY_COST_STATES];
}

export function dailyTableColumnNames(by: RollupBasis): readonly string[] {
  return dailyTableColumns(by).map(column => column.name);
}

export function dailyTableSql(by: RollupBasis, table: string = ROLLUP_TABLES[by]): string {
  // [스키마 정책] 최초 구축과 이관에 같은 열 정의와 복합 기본 키를 사용한다.
  const columns = dailyTableColumns(by).map(({ name, type }) => `${name} ${type}`).join(',\n  ');
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  ${columns},
  PRIMARY KEY(${dailyKeyColumns(by).join(', ')})
) WITHOUT ROWID;
`;
}

/** 영속 일별 합계와 해당 합계를 계산한 시간대. */
export const SCHEMA_ROLLUP_SQL = `
CREATE TABLE IF NOT EXISTS usage_rollup_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  timezone TEXT NOT NULL,
  format_version INTEGER NOT NULL
);
${dailyTableSql('provider')}${dailyTableSql('model')}`;

// [스키마 정책] 도구 사용량 키는 일별 집계의 제공자·세션·프로젝트·현지 날짜에 분류와 이름을 더한다.
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
