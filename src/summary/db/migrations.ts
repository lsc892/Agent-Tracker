// 이전 상세 행을 일별 통계로 이관하고 현재 스키마를 연다.
import type { DatabaseSync } from 'node:sqlite';
import { deserialize } from 'node:v8';
import { DAILY_SCHEMA_SQL, SCHEMA_VERSION, SCHEMA_MODEL_SQL } from './schema';
import { ROLLUP_FORMAT_VERSION, ROLLUP_TABLES } from './rollup-state';
import { aggregateUsageSource } from './queries/rollup/source';
import { rollupUsageTurns } from './queries/raw/source';
import { calendarPeriod } from './timezone';
import type { SourceRelationMetadata } from './types';

function schemaVersion(connection: DatabaseSync): number {
  // [스키마 정책] user_version으로 디스크 형식을 판별하고 현재 확장보다 새로운 형식을 거부한다.
  const version = Number(connection.prepare('PRAGMA user_version').get()?.user_version);
  if (version > SCHEMA_VERSION) throw new Error('Database schema is newer than this extension');
  return version;
}

export function migrateSchema(connection: DatabaseSync, timezone: string, transaction: (action: () => void) => void): void {
  // [스키마 정책] 이미 현재 버전이면 종료하고 이관이 필요하면 시간대부터 검증한다.
  if (schemaVersion(connection) === SCHEMA_VERSION) return;
  calendarPeriod(0, timezone, 'day');
  transaction(() => {
    // [SQL 트랜잭션 정책] 쓰기 잠금을 기다리는 동안 다른 창에서 이관했을 수 있어 버전을 다시 확인한다.
    const version = schemaVersion(connection);
    if (version === SCHEMA_VERSION) return;
    // [스키마 정책] 빈 DB는 일별 스키마를 만들고 기존 DB는 버전에 맞는 이관부터 적용한다.
    if (version === 0) {
      connection.exec(DAILY_SCHEMA_SQL);
      saveTimezone(connection, timezone);
    } else {
      if (version < 26) migrateUsage(connection, version, timezone);
      connection.exec(`DROP INDEX IF EXISTS idx_source_root_id;
        DROP INDEX IF EXISTS idx_source_session;
        DROP INDEX IF EXISTS idx_usage_request_daily_day;
        DROP INDEX IF EXISTS idx_usage_request_daily_project_day;
        DROP INDEX IF EXISTS idx_usage_model_daily_day;
        DROP INDEX IF EXISTS idx_usage_model_daily_project_day;`);
      // [스키마 정책] 실제 파일 열을 확인해 폐기된 열은 지우고 필요한 계보 열만 추가한다.
      const columns = connection.prepare('PRAGMA table_info(source_file)').all();
      if (columns.some(column => column.name === 'size_bytes'))
        connection.exec('ALTER TABLE source_file DROP COLUMN size_bytes');
      if (!columns.some(column => column.name === 'capabilities_collected'))
        connection.exec('ALTER TABLE source_file ADD COLUMN capabilities_collected INTEGER NOT NULL DEFAULT 0 CHECK(capabilities_collected IN (0,1))');
      if (!columns.some(column => column.name === 'thread_id'))
        connection.exec('ALTER TABLE source_file ADD COLUMN thread_id TEXT');
      if (!columns.some(column => column.name === 'thread_usage'))
        connection.exec('ALTER TABLE source_file ADD COLUMN thread_usage INTEGER NOT NULL DEFAULT 0 CHECK(thread_usage IN (0,1))');
      if (columns.some(column => column.name === 'relation_meta')) migrateSourceRelations(connection);
    }
    // [SQL 트랜잭션 정책] 이관 작업을 모두 마친 트랜잭션 안에서 스키마 버전을 기록한다.
    connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

/** Convert stored relationships in bounded batches before discarding the old payload. */
function migrateSourceRelations(connection: DatabaseSync): void {
  // [스키마 정책] 마지막 파일 ID를 기준으로 256행씩 순회하며 바이너리 계보를 스레드 ID와 사용량 표시로 변환한다.
  const first = connection.prepare('SELECT id,relation_meta FROM source_file WHERE relation_meta IS NOT NULL ORDER BY id LIMIT 256');
  const next = connection.prepare('SELECT id,relation_meta FROM source_file WHERE id>? AND relation_meta IS NOT NULL ORDER BY id LIMIT 256');
  first.setReadBigInts(true);
  next.setReadBigInts(true);
  const save = connection.prepare('UPDATE source_file SET thread_id=?,thread_usage=? WHERE id=?');
  for (let rows = first.all(); rows.length; rows = next.all(rows[rows.length - 1].id)) {
    for (const { id, relation_meta } of rows) {
      if (!(relation_meta instanceof Uint8Array)) continue;
      const relation = deserialize(relation_meta) as SourceRelationMetadata;
      save.run(relation.identity.threadId, Number(relation.threadUsage === true), id);
    }
  }
  // [스키마 정책] 계보 변환이 끝난 뒤 예전 페이로드 열을 제거한다.
  connection.exec('ALTER TABLE source_file DROP COLUMN relation_meta');
}

function migrateUsage(connection: DatabaseSync, version: number, timezone: string): void {
  // [스키마 정책] 이미 일별 전용인 v25의 집계는 보존하고 상세 행을 가진 버전은 일별 사용량으로 다시 집계한다.
  const daily = version === 25 && connection.prepare('SELECT * FROM usage_rollup_meta WHERE singleton=1').get()?.daily_only === 1;
  if (daily) {
    connection.exec('ALTER TABLE usage_rollup_meta DROP COLUMN daily_only');
  } else {
    prepareLegacyTables(connection);
    connection.exec(DAILY_SCHEMA_SQL);
    if (version <= 2) connection.exec(`INSERT OR IGNORE INTO projects
      SELECT project_key, MIN(project_name) FROM turn_summary GROUP BY project_key;
      INSERT OR IGNORE INTO sessions SELECT DISTINCT provider, session_id, NULL FROM turn_summary;`);
    migrateLegacyUsage(connection, timezone);
    saveTimezone(connection, timezone);
  }
  // [스키마 정책] 일별 데이터가 확보된 뒤 이전 응답·턴·집계 보조 테이블을 제거한다.
  connection.exec(`DROP TABLE IF EXISTS applied_response;
    DROP TABLE IF EXISTS source_winner_candidate; DROP TABLE IF EXISTS source_winner_snapshot;
    DROP TABLE IF EXISTS turn_metadata_dependencies; DROP TABLE IF EXISTS turn_metadata_capabilities;
    DROP TABLE IF EXISTS turn_metadata_models; DROP TABLE IF EXISTS turn_metadata;
    DROP TABLE IF EXISTS turn_capability_usage; DROP TABLE IF EXISTS turn_model_usage;
    DROP TABLE IF EXISTS turn_costs; DROP TABLE IF EXISTS turn_summary;
    DROP TABLE IF EXISTS summary_refresh; DROP TABLE IF EXISTS usage_session_months;`);
}

function prepareLegacyTables(connection: DatabaseSync): void {
  // [스키마 정책] 파일 manifest가 남아 있으면 이름을 바꿔 원본 ID를 보존한다.
  if (connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manifest'").get()) {
    connection.exec(`ALTER TABLE manifest RENAME TO source_file;
      DROP INDEX IF EXISTS idx_manifest_root_id; DROP INDEX IF EXISTS idx_manifest_session;
      DROP INDEX IF EXISTS idx_manifest_source; DROP INDEX IF EXISTS idx_manifest_identity;`);
  }
  // [스키마 정책] 다시 계산할 일별 테이블을 비우고 상세 사용량 이관에 필요한 캐시·모델 스키마를 갖춘다.
  connection.exec(`DROP INDEX IF EXISTS idx_source_source; DROP INDEX IF EXISTS idx_source_identity;
    DROP TABLE IF EXISTS usage_request_daily; DROP TABLE IF EXISTS usage_model_daily;
    DROP TABLE IF EXISTS usage_capability_daily; DROP TABLE IF EXISTS usage_rollup_meta;`);
  const columns = connection.prepare('PRAGMA table_info(turn_summary)').all();
  for (const column of ['cache_write_input_tokens', 'cache_read_input_tokens']) {
    if (!columns.some(existing => existing.name === column))
      connection.exec(`ALTER TABLE turn_summary ADD COLUMN ${column} INTEGER CHECK(${column} >= 0)`);
  }
  connection.exec(SCHEMA_MODEL_SQL);

  // [스키마 정책] 파일에 남아 있는 예전 추적 열을 제거하고 소실 상태를 보관할 열을 갖춘다.
  const sourceColumns = connection.prepare('PRAGMA table_info(source_file)').all();
  if (!sourceColumns.length) return;
  for (const column of ['complete_position', 'prefix_hash', 'source_identity', 'content_hash', 'dev', 'inode', 'last_seen_scan_id']) {
    if (sourceColumns.some(existing => existing.name === column)) connection.exec(`ALTER TABLE source_file DROP COLUMN ${column}`);
  }
  if (!sourceColumns.some(column => column.name === 'source_missing'))
    connection.exec('ALTER TABLE source_file ADD COLUMN source_missing INTEGER NOT NULL DEFAULT 0 CHECK(source_missing IN (0,1))');
}

function migrateLegacyUsage(connection: DatabaseSync, timezone: string): void {
  // [집계 정책] 기존 턴의 제공자·모델 사용량을 같은 일별 집계 SQL로 변환한다.
  for (const by of ['provider', 'model'] as const) {
    const select = aggregateUsageSource(by, rollupUsageTurns(by));
    connection.prepare(`INSERT INTO ${ROLLUP_TABLES[by]} ${select}`).run(timezone);
  }
  // [집계 정책] 기존 도구 사용 행이 있으면 현지 날짜와 분류·이름으로 묶어 합산한다.
  if (!connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='turn_capability_usage'").get()) return;
  connection.prepare(`INSERT INTO usage_capability_daily
    SELECT t.provider, t.session_id, t.project_key,
      coalesce(agent_tracker_period(t.started_at_ms, ?, 'day'), '') AS local_day,
      u.category, u.name, SUM(u.usage_count)
    FROM turn_capability_usage u JOIN turn_summary t ON t.id=u.turn_id
    GROUP BY t.provider, t.session_id, t.project_key, local_day, u.category, u.name`).run(timezone);
}

function saveTimezone(connection: DatabaseSync, timezone: string): void {
  // [스키마 정책] 일별 집계 기준 시간대와 형식 버전을 메타데이터 한 행에 남긴다.
  connection.prepare('INSERT INTO usage_rollup_meta(singleton,timezone,format_version) VALUES (1,?,?)')
    .run(timezone, ROLLUP_FORMAT_VERSION);
}
