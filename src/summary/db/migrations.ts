import type { DatabaseSync } from 'node:sqlite';
import {
  SCHEMA_SQL, SCHEMA_VERSION, SCHEMA_LEGACY_MIGRATION_SQL, SCHEMA_CACHE_MIGRATION_SQL,
  SCHEMA_MODEL_SQL, SCHEMA_CAPABILITY_SQL, SCHEMA_ROLLUP_SQL, SCHEMA_TURN_INDEX_MIGRATION_SQL, manifestIdentityIndexSql,
} from './schema';

/** Upgrade derived data while holding the connection's write transaction. */
export function migrateSchema(connection: DatabaseSync, transaction: (action: () => void) => void): void {
  const version = connection.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version.user_version > SCHEMA_VERSION) throw new Error('Database schema is newer than this extension');
  if (version.user_version < SCHEMA_VERSION) {
    transaction(() => {
      // Another window can finish migration while this connection waits for the write lock.
      const current = connection.prepare('PRAGMA user_version').get() as { user_version: number };
      if (current.user_version > SCHEMA_VERSION) throw new Error('Database schema is newer than this extension');
      if (current.user_version === SCHEMA_VERSION) return;
      connection.exec(current.user_version === 1 || current.user_version === 2 ? SCHEMA_LEGACY_MIGRATION_SQL
        : current.user_version === 3 ? SCHEMA_CACHE_MIGRATION_SQL : SCHEMA_SQL);
      connection.exec(SCHEMA_MODEL_SQL);
      connection.exec(SCHEMA_CAPABILITY_SQL);
      connection.exec(SCHEMA_ROLLUP_SQL);
      if (!connection.prepare('PRAGMA table_info(manifest)').all().some(column => column.name === 'capabilities_collected')) {
        connection.exec('ALTER TABLE manifest ADD COLUMN capabilities_collected INTEGER NOT NULL DEFAULT 0 CHECK(capabilities_collected IN (0,1))');
      }
      if (!connection.prepare('PRAGMA table_info(turn_summary)').all().some(column => column.name === 'request_title')) {
        connection.exec('ALTER TABLE turn_summary ADD COLUMN request_title TEXT');
      }
      if (connection.prepare('PRAGMA table_info(turn_summary)').all().some(column => column.name === 'turn_index')) {
        connection.exec(SCHEMA_TURN_INDEX_MIGRATION_SQL);
      }
      connection.exec('DROP INDEX IF EXISTS idx_summary_session;');
      connection.exec(manifestIdentityIndexSql(process.platform));
      connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }
  // Reconcile an already-current database copied from another operating system.
  connection.exec(manifestIdentityIndexSql(process.platform));
}
