import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { migrateSchema } from './migrations';
import { calendarPeriod } from './timezone';

export type SqliteSessionOptions = string | { databasePath: string; cacheKiB?: number };

/** Owns the SQLite connection shared by all summary readers and stores. */
export class SqliteSession {
  readonly connection: DatabaseSync;
  private closed = false;
  private lastOptimizedAt: number | undefined;
  // Cache only fixed statements, so its size is independent of files, sessions and user queries.
  private readonly statements = new Map<string, StatementSync>();

  constructor(options: SqliteSessionOptions) {
    const path = typeof options === 'string' ? options : options.databasePath;
    const cacheKiB = typeof options === 'string' ? 4096 : options.cacheKiB ?? 4096;
    if (!Number.isSafeInteger(cacheKiB) || cacheKiB < 256 || cacheKiB > 65536) {
      throw new RangeError('Database cache must be between 256 and 65536 KiB');
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.connection = new DatabaseSync(path);
    try {
      this.connection.exec(`PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA temp_store = FILE;
        PRAGMA cache_size = -${cacheKiB};
        PRAGMA temp.cache_size = -${cacheKiB};
        PRAGMA mmap_size = 0;`);
      migrateSchema(this.connection, action => this.transaction(action));
      this.optimizeConnection(true);
      this.connection.function('agent_tracker_period', { deterministic: true }, (timestamp, timezone, unit) => {
        if (timestamp === null) return null;
        return calendarPeriod(Number(timestamp), String(timezone), unit === 'month' ? 'month' : 'day');
      });
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.connection.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  transaction<T>(action: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  /** Collect statistics after the first scan, then at most once per day. */
  optimize(): void {
    const now = Date.now();
    if (this.lastOptimizedAt !== undefined && now - this.lastOptimizedAt < 86_400_000) return;
    if (this.optimizeConnection()) this.lastOptimizedAt = now;
  }

  close(): void {
    if (!this.closed) {
      this.optimizeConnection();
      this.statements.clear();
      this.connection.close();
      this.closed = true;
    }
  }

  private optimizeConnection(onOpen = false): boolean {
    try {
      // Limit maintenance to persistent tables, even when scan staging exists.
      this.connection.exec(onOpen ? 'PRAGMA main.optimize=0x10002;' : 'PRAGMA main.optimize;');
      return true;
    } catch {
      // Statistics are optional; a competing writer must not fail a scan or cleanup.
      return false;
    }
  }
}
