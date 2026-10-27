// 원본 요청과 일치하도록 활성 시간대의 일별 사전 집계를 구축·갱신한다.
import type { SqliteSession } from './connection';
import type { Provider } from './types';
import type { SQLInputValue } from 'node:sqlite';
import { periodBounds } from './timezone';
import { aggregateUsageSource } from './rollup-queries';
import { ROLLUP_FORMAT_VERSION, ROLLUP_TABLES } from './rollup-state';

interface RollupMetadata { timezone: string; format_version: number }
// Keep local days in the four-digit AD range, with room for timezone offsets.
const MIN_CALENDAR_TIME = Date.parse('0002-01-03T00:00:00Z');
const MAX_CALENDAR_TIME = Date.parse('9998-12-29T00:00:00Z');

/** DB에서 활성 시간대 하나의 일별 사전 집계를 구축하고 세션 변경을 반영한다. */
export class UsageRollupStore {
  private readonly dayBounds = new Map<string, { fromMs: number; toMs: number }>();
  private trackingChanges = false;
  private dirtyKeys = 0;
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
   * 책임: 사전 집계의 준비 상태 확인과 실제 조회에 같은 snapshot을 보장한다.
   * 알고리즘: DEFERRED 읽기로 시간대·형식을 확인하고 재구축이 필요할 때만 쓰기 트랜잭션으로 재확인하며, 기존 트랜잭션·미지원 환경은 raw로 대체한다.
   */
  read<T>(timezone: string, action: (ready: boolean) => T): T {
    const connection = this.database.connection;
    // DatabaseSync.isTransaction arrived in Node 22.16; retain raw reads on 22.15.
    if (typeof connection.isTransaction !== 'boolean') return action(false);
    const current = (): { ready: boolean; supported: boolean } => {
      const metadata = this.metadata();
      return { ready: metadata?.format_version === ROLLUP_FORMAT_VERSION && metadata.timezone === timezone,
        supported: this.calendarSupported() };
    };
    if (connection.isTransaction) {
      const state = current();
      return action(state.ready && state.supported);
    }
    connection.exec('BEGIN');
    try {
      const state = current();
      if (state.ready || !state.supported) {
        const result = action(state.ready && state.supported);
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
      if (!this.calendarSupported()) return action(false);
      if (metadata?.format_version !== ROLLUP_FORMAT_VERSION || metadata.timezone !== timezone) {
        this.rebuild(timezone);
      }
      return action(true);
    });
  }

  private rebuild(timezone: string): void {
    this.clear();
    for (const by of ['provider', 'model'] as const) {
      this.database.statement(`INSERT INTO ${ROLLUP_TABLES[by]} ${aggregateUsageSource(by)}`).run(timezone);
    }
    this.database.statement('INSERT INTO usage_rollup_meta(singleton, timezone, format_version) VALUES (1, ?, ?)')
      .run(timezone, ROLLUP_FORMAT_VERSION);
  }

  /** Reuses the installer session set before it is cleared; old dates/projects are deleted too. */
  refreshChangedSessions(): void {
    this.refresh('(provider, session_id) IN (SELECT provider, session_id FROM db_replacement_sessions)', []);
  }

  /** Keep old and new grouping keys on disk; a moved/deleted minimum or maximum needs exact recomputation. */
  beginChanges(): void {
    this.trackingChanges = this.metadata()?.format_version === ROLLUP_FORMAT_VERSION;
    this.dirtyKeys = 0;
    this.database.connection.exec(`CREATE TEMP TABLE IF NOT EXISTS db_rollup_dirty(
      provider TEXT NOT NULL,session_id TEXT NOT NULL,project_key TEXT NOT NULL,local_day TEXT NOT NULL,
      PRIMARY KEY(provider,session_id,project_key,local_day)) WITHOUT ROWID;
      DELETE FROM db_rollup_dirty;
      CREATE TEMP TABLE IF NOT EXISTS db_rollup_inputs(id INTEGER PRIMARY KEY);
      DELETE FROM db_rollup_inputs;`);
  }

  captureTurns(where: string, values: SQLInputValue[] = []): void {
    if (!this.trackingChanges || this.dirtyKeys > 32) return;
    const result = this.database.statement(`INSERT OR IGNORE INTO db_rollup_dirty
      SELECT provider,session_id,project_key,CASE WHEN started_at_ms>=${MIN_CALENDAR_TIME} AND started_at_ms<${MAX_CALENDAR_TIME}
        THEN agent_tracker_period(started_at_ms,meta.timezone,'day') ELSE '' END
      FROM turn_summary CROSS JOIN usage_rollup_meta meta WHERE meta.singleton=1 AND meta.format_version=? AND (${where})`)
      .run(ROLLUP_FORMAT_VERSION, ...values);
    this.dirtyKeys += Number(result.changes);
  }

  /**
   * 책임: 실제 요청 변경이 닿은 이전·새 일별 구간만 정확하게 갱신한다.
   * 알고리즘: 현지 일 경계를 epoch 범위로 바꿔 현재 facts를 좁히고 두 rollup의 해당 키를 교체한다. 합계와 분모·MIN/MAX를 함께 복원한다.
   */
  refreshChangedTurns(): void {
    const metadata = this.metadata();
    if (!metadata || metadata.format_version !== ROLLUP_FORMAT_VERSION) return;
    if (!this.calendarSupported()) { this.clear(); return; }
    // Dense rebuilds amortize calendar work with the existing set-based session SQL.
    // Sparse refreshes keep exact bucket invalidation, including very long sessions.
    if (this.dirtyKeys > 32) {
      this.refreshChangedSessions();
      this.database.connection.exec('DELETE FROM db_rollup_dirty; DELETE FROM db_rollup_inputs;');
      return;
    }
    const dated = this.database.statement(`INSERT OR IGNORE INTO db_rollup_inputs SELECT id FROM turn_summary
      WHERE provider=? AND session_id=? AND project_key=? AND started_at_ms>=? AND started_at_ms<?`);
    const unknown = this.database.statement(`INSERT OR IGNORE INTO db_rollup_inputs SELECT id FROM turn_summary
      WHERE provider=? AND session_id=? AND project_key=? AND started_at_ms IS NULL`);
    for (const row of this.database.statement('SELECT * FROM db_rollup_dirty').iterate()) {
      if (row.local_day === '') unknown.run(row.provider,row.session_id,row.project_key);
      else {
        const key = `${metadata.timezone}/${row.local_day}`;
        let bounds = this.dayBounds.get(key);
        if (!bounds) {
          bounds = periodBounds(row.local_day as string, metadata.timezone);
          if (this.dayBounds.size >= 32) this.dayBounds.delete(this.dayBounds.keys().next().value!);
          this.dayBounds.set(key, bounds);
        }
        dated.run(row.provider,row.session_id,row.project_key,bounds.fromMs,bounds.toMs);
      }
    }
    for (const by of ['provider', 'model'] as const) {
      this.database.connection.exec(`DELETE FROM ${ROLLUP_TABLES[by]} WHERE (provider,session_id,project_key,local_day)
        IN (SELECT provider,session_id,project_key,local_day FROM db_rollup_dirty)`);
      this.database.statement(`INSERT INTO ${ROLLUP_TABLES[by]} ${aggregateUsageSource(by, 'id IN (SELECT id FROM db_rollup_inputs)')}`)
        .run(metadata.timezone);
    }
    this.database.connection.exec('DELETE FROM db_rollup_dirty; DELETE FROM db_rollup_inputs;');
  }

  refreshSession(provider: Provider, sessionId: string): void {
    this.refresh('provider = ? AND session_id = ?', [provider, sessionId]);
  }

  /**
   * 책임: 변경된 세션의 이전 날짜·프로젝트 기여분까지 교체한다.
   * 알고리즘: 활성 시간대·형식을 검증한 뒤 대상 세션의 provider·model 일별 행을 지우고 현재 facts로 다시 집계한다.
   */
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
