// 저장된 통계와 식별자를 보존하며 SQLite 스키마를 현재 버전으로 갱신한다.
import type { DatabaseSync } from 'node:sqlite';
import {
  SCHEMA_SQL, SCHEMA_VERSION, SCHEMA_LEGACY_MIGRATION_SQL, SCHEMA_CACHE_MIGRATION_SQL,
  SCHEMA_MODEL_SQL, SCHEMA_CAPABILITY_SQL, SCHEMA_ROLLUP_SQL, SCHEMA_TURN_INDEX_MIGRATION_SQL, sourceIdentityIndexSql,
} from './schema';

function initialMigrationSql(version: number): string {
  switch (version) {
    case 1:
    case 2: return SCHEMA_LEGACY_MIGRATION_SQL;
    case 3: return SCHEMA_CACHE_MIGRATION_SQL;
    default: return SCHEMA_SQL;
  }
}

/**
 * 책임: 기존 통계와 식별자를 보존하며 DB 스키마를 현재 버전으로 맞춘다.
 * 알고리즘: 쓰기 트랜잭션 안에서 버전을 다시 확인하고 버전별 SQL·누락 열을 적용한 뒤 운영체제별 인덱스와 user_version을 갱신한다.
 */
export function migrateSchema(connection: DatabaseSync, transaction: (action: () => void) => void): void {
  const version = connection.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version.user_version > SCHEMA_VERSION) throw new Error('Database schema is newer than this extension');
  if (version.user_version < SCHEMA_VERSION) {
    transaction(() => {
      // Another window can finish migration while this connection waits for the write lock.
      const current = connection.prepare('PRAGMA user_version').get() as { user_version: number };
      if (current.user_version > SCHEMA_VERSION) throw new Error('Database schema is newer than this extension');
      if (current.user_version === SCHEMA_VERSION) return;
      // The former metadata manifest becomes a source/diagnostic registry only.
      if (connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manifest'").get()) {
        connection.exec(`ALTER TABLE manifest RENAME TO source_file;
          DROP INDEX IF EXISTS idx_manifest_root_id; DROP INDEX IF EXISTS idx_manifest_session;
          DROP INDEX IF EXISTS idx_manifest_source; DROP INDEX IF EXISTS idx_manifest_identity;`);
      }
      const existingSourceColumns = connection.prepare('PRAGMA table_info(source_file)').all();
      for (const column of ['source_identity', 'content_hash']) {
        if (existingSourceColumns.length && !existingSourceColumns.some(existing => existing.name === column)) {
          connection.exec(`ALTER TABLE source_file ADD COLUMN ${column} TEXT`);
        }
      }
      connection.exec(initialMigrationSql(current.user_version));
      // v1/v2/v3 use targeted migrations instead of SCHEMA_SQL; restore renamed indexes too.
      connection.exec(`CREATE INDEX IF NOT EXISTS idx_source_root_id ON source_file(provider, source_root, id);
        CREATE INDEX IF NOT EXISTS idx_source_session ON source_file(provider, session_id, id);`);
      const sourceColumns = connection.prepare('PRAGMA table_info(source_file)').all();
      if (!sourceColumns.some(column => column.name === 'complete_position'))
        connection.exec('ALTER TABLE source_file ADD COLUMN complete_position INTEGER NOT NULL DEFAULT 0 CHECK(complete_position >= 0)');
      if (!sourceColumns.some(column => column.name === 'prefix_hash'))
        connection.exec('ALTER TABLE source_file ADD COLUMN prefix_hash TEXT');
      connection.exec(SCHEMA_MODEL_SQL);
      connection.exec(SCHEMA_CAPABILITY_SQL);
      // Removed aggregate columns change the derived layout; source facts and IDs stay intact.
      if (current.user_version > 0) {
        connection.exec(`DROP TABLE IF EXISTS usage_request_daily; DROP TABLE IF EXISTS usage_model_daily;
          DROP TABLE IF EXISTS usage_rollup_meta; DROP TABLE IF EXISTS usage_session_months;`);
      }
      connection.exec(SCHEMA_ROLLUP_SQL);
      connection.exec(`DROP TABLE IF EXISTS turn_metadata_dependencies; DROP TABLE IF EXISTS turn_metadata_capabilities;
        DROP TABLE IF EXISTS turn_metadata_models; DROP TABLE IF EXISTS turn_metadata;`);
      if (!connection.prepare('PRAGMA table_info(source_file)').all().some(column => column.name === 'capabilities_collected')) {
        connection.exec('ALTER TABLE source_file ADD COLUMN capabilities_collected INTEGER NOT NULL DEFAULT 0 CHECK(capabilities_collected IN (0,1))');
      }
      if (!connection.prepare('PRAGMA table_info(source_file)').all().some(column => column.name === 'source_missing')) {
        connection.exec('ALTER TABLE source_file ADD COLUMN source_missing INTEGER NOT NULL DEFAULT 0 CHECK(source_missing IN (0,1))');
      }
      connection.exec('CREATE INDEX IF NOT EXISTS idx_source_source ON source_file(provider, source_identity, id)');
      if (!connection.prepare('PRAGMA table_info(turn_summary)').all().some(column => column.name === 'request_title')) {
        connection.exec('ALTER TABLE turn_summary ADD COLUMN request_title TEXT');
      }
      if (connection.prepare('PRAGMA table_info(turn_summary)').all().some(column => column.name === 'turn_index')) {
        connection.exec(SCHEMA_TURN_INDEX_MIGRATION_SQL);
      }
      connection.exec('DROP INDEX IF EXISTS idx_summary_session;');
      connection.exec(sourceIdentityIndexSql(process.platform));
      connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }
  // Reconcile an already-current database copied from another operating system.
  connection.exec(sourceIdentityIndexSql(process.platform));
}
