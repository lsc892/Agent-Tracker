// 통계 DB의 테이블·인덱스·버전과 기존 스키마 변환 SQL을 정의한다.
import { SCHEMA_DAILY_CAPABILITY_SQL, SCHEMA_ROLLUP_SQL } from './rollup-state';

export { SCHEMA_ROLLUP_SQL } from './rollup-state';
export const SCHEMA_VERSION = 31;
export const SESSION_BILLING_COLUMN_SQL = "billing_mode TEXT CHECK(billing_mode IN ('subscription','api','unknown'))";

// [스키마 정책] 레거시 반영 이력은 턴·응답 키로 중복을 막고 턴 삭제에 맞춰 정리한다.
export const SCHEMA_APPLIED_RESPONSES_SQL = `
CREATE TABLE IF NOT EXISTS applied_response (
  turn_id INTEGER NOT NULL REFERENCES turn_summary(id) ON DELETE CASCADE,
  response_key TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  PRIMARY KEY (turn_id, response_key)
) WITHOUT ROWID;
`;

// [스키마 정책] 레거시 도구 사용량은 턴·분류·이름마다 양수 횟수만 저장한다.
export const SCHEMA_CAPABILITY_SQL = `
CREATE TABLE IF NOT EXISTS turn_capability_usage (
  turn_id INTEGER NOT NULL REFERENCES turn_summary(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(category IN ('skill','subagent','plugin','model')),
  name TEXT NOT NULL,
  usage_count INTEGER NOT NULL CHECK(usage_count > 0),
  PRIMARY KEY(turn_id, category, name)
) WITHOUT ROWID;
`;

// [스키마 정책] 레거시 결제 지정값은 구형 세션과 같은 복합 키로 이관한다.
const SESSION_BILLING_SQL = `
CREATE TABLE IF NOT EXISTS session_billing (
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  billing_mode TEXT NOT NULL CHECK(billing_mode IN ('subscription','api','unknown')),
  PRIMARY KEY(provider,session_id),
  FOREIGN KEY(provider,session_id) REFERENCES sessions(provider,session_id) ON DELETE CASCADE
) WITHOUT ROWID;
`;

// [스키마 정책] 레거시 모델별 토큰과 턴 비용에 추정값과 가격표 버전을 보존한다.
export const SCHEMA_MODEL_SQL = `
CREATE TABLE IF NOT EXISTS turn_model_usage (
  turn_id INTEGER NOT NULL REFERENCES turn_summary(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
  cache_write_input_tokens INTEGER CHECK(cache_write_input_tokens >= 0),
  cache_read_input_tokens INTEGER CHECK(cache_read_input_tokens >= 0),
  estimated_cost_usd REAL CHECK(estimated_cost_usd >= 0),
  pricing_version TEXT NOT NULL,
  PRIMARY KEY(turn_id, model)
) WITHOUT ROWID;
${SESSION_BILLING_SQL}
CREATE TABLE IF NOT EXISTS turn_costs (
  turn_id INTEGER PRIMARY KEY REFERENCES turn_summary(id) ON DELETE CASCADE,
  billing_mode TEXT NOT NULL CHECK(billing_mode IN ('subscription','api','unknown')),
  cost_usd REAL CHECK(cost_usd >= 0),
  unknown_costs INTEGER NOT NULL CHECK(unknown_costs >= 0),
  pricing_version TEXT NOT NULL
);
`;

// [스키마 정책] 표시 이름은 프로젝트 키와 제공자·세션 키로 따로 관리한다.
function namesSql(legacy = false): string {
  return `
CREATE TABLE IF NOT EXISTS projects (
  project_key TEXT PRIMARY KEY,
  project_name TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sessions (
  provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex')),
  session_id TEXT NOT NULL,
  session_name TEXT,${legacy ? '' : `\n  ${SESSION_BILLING_COLUMN_SQL},`}
  PRIMARY KEY(provider, session_id)
) WITHOUT ROWID;
`;
}

// [스키마 정책] 레거시 상세 행은 세션 내 루트 요청의 유일성과 입력·출력 토큰 합계를 제약한다.
const TURN_SUMMARY_SQL = `
CREATE TABLE IF NOT EXISTS turn_summary (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex')),
  project_key TEXT NOT NULL REFERENCES projects(project_key),
  session_id TEXT NOT NULL,
  root_turn_id TEXT NOT NULL,
  request_title TEXT,
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  duration_ms INTEGER CHECK(duration_ms >= 0),
  duration_quality TEXT NOT NULL CHECK(duration_quality IN ('exact','derived','approximate','missing')),
  input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
  cache_write_input_tokens INTEGER CHECK(cache_write_input_tokens >= 0),
  cache_read_input_tokens INTEGER CHECK(cache_read_input_tokens >= 0),
  total_tokens INTEGER NOT NULL CHECK(total_tokens = input_tokens + output_tokens),
  status TEXT NOT NULL CHECK(status IN ('completed','in_progress','failed')),
  quality_flags TEXT,
  diagnostic_file_id INTEGER REFERENCES source_file(id) ON DELETE SET NULL,
  diagnostic_offset INTEGER,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, session_id, root_turn_id),
  FOREIGN KEY(provider, session_id) REFERENCES sessions(provider, session_id)
);
`;

// [조회 정책] 레거시 시간순 조회에 시각 인덱스와 제공자·프로젝트별 시각 인덱스를 사용한다.
const TURN_SUMMARY_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_summary_period ON turn_summary(started_at_ms, provider);
CREATE INDEX IF NOT EXISTS idx_summary_project_period ON turn_summary(provider, project_key, started_at_ms);
`;

function sourceSql(legacy = false): string {
  // [스키마 정책] 원본의 제공자·경로 유일성을 유지하고 레거시와 현재 형식의 계보 열을 구분한다.
  const legacyColumns = legacy ? '\n  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes >= 0),' : '';
  return `
CREATE TABLE IF NOT EXISTS source_file (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex')),
  source_root TEXT NOT NULL,
  path TEXT NOT NULL,
  session_id TEXT,${legacyColumns}
  mtime_ms REAL NOT NULL DEFAULT 0,
  parser_version INTEGER NOT NULL DEFAULT 0,
  capabilities_collected INTEGER NOT NULL DEFAULT 0 CHECK(capabilities_collected IN (0,1)),
  ${legacy ? 'relation_meta BLOB,' : `thread_id TEXT,
  thread_usage INTEGER NOT NULL DEFAULT 0 CHECK(thread_usage IN (0,1)),`}
  source_missing INTEGER NOT NULL DEFAULT 0 CHECK(source_missing IN (0,1)),
  processing_status TEXT NOT NULL DEFAULT 'processing'
    CHECK(processing_status IN ('processing','done','error','interrupted')),
  processing_position TEXT,
  recorded_at TEXT NOT NULL,
  last_error TEXT,
  UNIQUE(provider, path)
);
`;
}

// [스키마 정책] 현재 형식은 원본·이름·결제 설정과 일별 집계 테이블로 구성한다.
export const DAILY_SCHEMA_SQL = `
${sourceSql()}
${namesSql()}
${SCHEMA_ROLLUP_SQL}
${SCHEMA_DAILY_CAPABILITY_SQL}
`;

/** Legacy DDL used to describe the on-disk format before daily-only storage. */
export const SCHEMA_SQL = `
${sourceSql(true)}
${namesSql(true)}
${TURN_SUMMARY_SQL}
${TURN_SUMMARY_INDEX_SQL}
${SCHEMA_MODEL_SQL}
${SCHEMA_CAPABILITY_SQL}
${SCHEMA_ROLLUP_SQL}
${SCHEMA_APPLIED_RESPONSES_SQL}
`;
