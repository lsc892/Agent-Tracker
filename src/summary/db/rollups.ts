import type { SqliteSession } from './connection';
import type { Provider } from './types';
import { aggregateUsageSource } from './rollup-queries';
import { ROLLUP_FORMAT_VERSION, ROLLUP_TABLES } from './rollup-state';

interface RollupMetadata { timezone: string; format_version: number }
// Keep local days in the four-digit AD range, with room for timezone offsets.
const MIN_CALENDAR_TIME = Date.parse('0002-01-03T00:00:00Z');
const MAX_CALENDAR_TIME = Date.parse('9998-12-29T00:00:00Z');

/** One materialized timezone per database; daily contributions follow facts in the same transaction. */
export class UsageRollupStore {
  constructor(private readonly database: SqliteSession) {}

  private metadata(): RollupMetadata | undefined {
    return this.database.statement('SELECT timezone, format_version FROM usage_rollup_meta WHERE singleton = 1')
      .get() as unknown as RollupMetadata | undefined;
  }

  private calendarSupported(): boolean {
    // Separate scalar MIN/MAX queries each seek the date index; combined MIN/MAX would scan it.
    const range = this.database.statement(`SELECT
      (SELECT MIN(started_at_ms) FROM turn_summary) AS first,
      (SELECT MAX(started_at_ms) FROM turn_summary) AS last`).get() as { first: number | null; last: number | null };
    return range.first === null || range.first >= MIN_CALENDAR_TIME && range.last! < MAX_CALENDAR_TIME;
  }

  /**
   * Check the active timezone and execute reads in the same snapshot. Warm readers use
   * a deferred transaction, never a writer lock. Caller-owned transactions are reused;
   * a timezone mismatch there selects raw SQL rather than upgrading a stale snapshot.
   */
  read<T>(timezone: string | undefined, action: (ready: boolean, timezone: string) => T): T {
    const connection = this.database.connection;
    // DatabaseSync.isTransaction arrived in Node 22.16; retain raw reads on 22.15.
    if (typeof connection.isTransaction !== 'boolean') return action(false, timezone ?? 'UTC');
    const current = (): { ready: boolean; timezone: string; supported: boolean } => {
      const metadata = this.metadata();
      const selected = timezone ?? metadata?.timezone ?? 'UTC';
      return { ready: metadata?.format_version === ROLLUP_FORMAT_VERSION && metadata.timezone === selected,
        timezone: selected, supported: this.calendarSupported() };
    };
    if (connection.isTransaction) {
      const state = current();
      return action(state.ready && state.supported, state.timezone);
    }
    connection.exec('BEGIN');
    let selected: string;
    try {
      const state = current();
      selected = state.timezone;
      if (state.ready || !state.supported) {
        const result = action(state.ready && state.supported, selected);
        connection.exec('COMMIT');
        return result;
      }
      connection.exec('ROLLBACK');
    } catch (error) {
      if (connection.isTransaction) connection.exec('ROLLBACK');
      throw error;
    }
    return this.database.transaction(() => {
      // A different window may have rebuilt while we waited for BEGIN IMMEDIATE.
      const metadata = this.metadata();
      if (timezone === undefined) selected = metadata?.timezone ?? selected;
      if (!this.calendarSupported()) return action(false, selected);
      if (metadata?.format_version !== ROLLUP_FORMAT_VERSION || metadata.timezone !== selected) {
        this.clear();
        for (const by of ['provider', 'model'] as const) {
          this.database.statement(`INSERT INTO ${ROLLUP_TABLES[by]} ${aggregateUsageSource(by)}`).run(selected);
        }
        this.database.statement('INSERT INTO usage_rollup_meta(singleton, timezone, format_version) VALUES (1, ?, ?)')
          .run(selected, ROLLUP_FORMAT_VERSION);
      }
      return action(true, selected);
    });
  }

  /** Reuses the installer session set before it is cleared; old dates/projects are deleted too. */
  refreshChangedSessions(): void {
    this.refresh('(provider, session_id) IN (SELECT provider, session_id FROM db_replacement_sessions)', []);
  }

  refreshSession(provider: Provider, sessionId: string): void {
    this.refresh('provider = ? AND session_id = ?', [provider, sessionId]);
  }

  private refresh(where: string, values: string[]): void {
    const metadata = this.metadata();
    if (!metadata || metadata.format_version !== ROLLUP_FORMAT_VERSION) return;
    if (!this.calendarSupported()) { this.clear(); return; }
    for (const by of ['provider', 'model'] as const) {
      this.database.statement(`DELETE FROM ${ROLLUP_TABLES[by]} WHERE ${where}`).run(...values);
      this.database.statement(`INSERT INTO ${ROLLUP_TABLES[by]} ${aggregateUsageSource(by, where)}`)
        .run(metadata.timezone, ...values);
    }
  }

  /** Call within the facts clear/rebuild transaction. */
  clear(): void {
    this.database.connection.exec('DELETE FROM usage_request_daily; DELETE FROM usage_model_daily; DELETE FROM usage_rollup_meta;');
  }
}
