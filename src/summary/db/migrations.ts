// 이전 상세 행을 일별 통계로 이관하고 현재 스키마를 연다.
import type { DatabaseSync } from 'node:sqlite';
import { DAILY_SCHEMA_SQL, SCHEMA_VERSION, SCHEMA_MODEL_SQL } from './schema';
import { ROLLUP_FORMAT_VERSION, ROLLUP_TABLES } from './rollup-state';
import { aggregateUsageSource } from './queries/rollup/source';
import { rollupUsageTurns } from './queries/raw/source';
import { calendarPeriod } from './timezone';

function schemaVersion(connection: DatabaseSync): number {
  const version = Number(connection.prepare('PRAGMA user_version').get()?.user_version);
  if (version > SCHEMA_VERSION) throw new Error('Database schema is newer than this extension');
  return version;
}

export function migrateSchema(connection: DatabaseSync, timezone: string, transaction: (action: () => void) => void): void {
  if (schemaVersion(connection) === SCHEMA_VERSION) return;
  calendarPeriod(0, timezone, 'day');
  transaction(() => {
    // Another window may have finished the migration while this writer waited.
    const version = schemaVersion(connection);
    if (version === SCHEMA_VERSION) return;
    if (version === 0) {
      connection.exec(DAILY_SCHEMA_SQL);
      saveTimezone(connection, timezone);
    } else {
      migrateUsage(connection, version, timezone);
    }
    connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

function migrateUsage(connection: DatabaseSync, version: number, timezone: string): void {
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
  connection.exec(`DROP TABLE IF EXISTS applied_response;
    DROP TABLE IF EXISTS source_winner_candidate; DROP TABLE IF EXISTS source_winner_snapshot;
    DROP TABLE IF EXISTS turn_metadata_dependencies; DROP TABLE IF EXISTS turn_metadata_capabilities;
    DROP TABLE IF EXISTS turn_metadata_models; DROP TABLE IF EXISTS turn_metadata;
    DROP TABLE IF EXISTS turn_capability_usage; DROP TABLE IF EXISTS turn_model_usage;
    DROP TABLE IF EXISTS turn_costs; DROP TABLE IF EXISTS turn_summary;
    DROP TABLE IF EXISTS summary_refresh; DROP TABLE IF EXISTS usage_session_months;`);
}

function prepareLegacyTables(connection: DatabaseSync): void {
  if (connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manifest'").get()) {
    connection.exec(`ALTER TABLE manifest RENAME TO source_file;
      DROP INDEX IF EXISTS idx_manifest_root_id; DROP INDEX IF EXISTS idx_manifest_session;
      DROP INDEX IF EXISTS idx_manifest_source; DROP INDEX IF EXISTS idx_manifest_identity;`);
  }
  connection.exec(`DROP INDEX IF EXISTS idx_source_source; DROP INDEX IF EXISTS idx_source_identity;
    DROP TABLE IF EXISTS usage_request_daily; DROP TABLE IF EXISTS usage_model_daily;
    DROP TABLE IF EXISTS usage_capability_daily; DROP TABLE IF EXISTS usage_rollup_meta;`);
  const columns = connection.prepare('PRAGMA table_info(turn_summary)').all();
  for (const column of ['cache_write_input_tokens', 'cache_read_input_tokens']) {
    if (!columns.some(existing => existing.name === column))
      connection.exec(`ALTER TABLE turn_summary ADD COLUMN ${column} INTEGER CHECK(${column} >= 0)`);
  }
  connection.exec(SCHEMA_MODEL_SQL);

  const sourceColumns = connection.prepare('PRAGMA table_info(source_file)').all();
  if (!sourceColumns.length) return;
  for (const column of ['complete_position', 'prefix_hash', 'source_identity', 'content_hash', 'dev', 'inode', 'last_seen_scan_id']) {
    if (sourceColumns.some(existing => existing.name === column)) connection.exec(`ALTER TABLE source_file DROP COLUMN ${column}`);
  }
  if (!sourceColumns.some(column => column.name === 'relation_meta'))
    connection.exec('ALTER TABLE source_file ADD COLUMN relation_meta BLOB');
  for (const column of ['capabilities_collected', 'source_missing']) {
    if (!sourceColumns.some(existing => existing.name === column))
      connection.exec(`ALTER TABLE source_file ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0 CHECK(${column} IN (0,1))`);
  }
}

function migrateLegacyUsage(connection: DatabaseSync, timezone: string): void {
  for (const by of ['provider', 'model'] as const) {
    const select = aggregateUsageSource(by, rollupUsageTurns(by));
    connection.prepare(`INSERT INTO ${ROLLUP_TABLES[by]} ${select}`).run(timezone);
  }
  if (!connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='turn_capability_usage'").get()) return;
  connection.prepare(`INSERT INTO usage_capability_daily
    SELECT t.provider, t.session_id, t.project_key,
      coalesce(agent_tracker_period(t.started_at_ms, ?, 'day'), '') AS local_day,
      u.category, u.name, SUM(u.usage_count)
    FROM turn_capability_usage u JOIN turn_summary t ON t.id=u.turn_id
    GROUP BY t.provider, t.session_id, t.project_key, local_day, u.category, u.name`).run(timezone);
}

function saveTimezone(connection: DatabaseSync, timezone: string): void {
  connection.prepare('INSERT INTO usage_rollup_meta(singleton,timezone,format_version) VALUES (1,?,?)')
    .run(timezone, ROLLUP_FORMAT_VERSION);
}
