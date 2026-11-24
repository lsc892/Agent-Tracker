// 메모리 집계에서 날짜별 사용량을 계산해 해당 세션의 일별 행을 교체한다.
import type { SqliteSession } from './connection';
import type { Provider, SessionRef, TurnSummaryInput } from './types';
import { aggregateUsageSource, dailyKeySource } from './queries/rollup/source';
import { DAILY_COST_STATES, dailyKeyColumns, rollupStates, ROLLUP_TABLES } from './rollup-state';
import type { StageProfiler, StorageStage } from '../profiling';
import { DAILY_FACTS_SOURCE, dailyFacts } from './dailyFacts';
import { calendarPeriod } from './timezone';

const SESSION_SET_FILTER = `(provider, session_id) IN (
  SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
)`;
const MISSING_SESSIONS = `SELECT DISTINCT f.provider, f.session_id FROM json_each(?) AS s
  CROSS JOIN source_file f ON f.provider=json_extract(s.value, '$[0]') AND f.session_id=json_extract(s.value, '$[1]')
  WHERE f.source_missing=1`;
const REPLACE_MISSING_DAYS = `AND (NOT (${SESSION_SET_FILTER}) OR (provider, session_id, local_day) IN (
  SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?)
))`;

function dailyUpsert(by: keyof typeof ROLLUP_TABLES): string {
  const table = ROLLUP_TABLES[by];
  const states = [...rollupStates(by), ...DAILY_COST_STATES].map(state => state.name);
  const fields = by === 'model' ? ['model', ...states] : states;
  const incoming = fields.map(field => `excluded.${field}`);
  return `INSERT INTO ${table}
    SELECT * FROM (${aggregateUsageSource(by, DAILY_FACTS_SOURCE)}) WHERE true
    ON CONFLICT(${dailyKeyColumns(by).join(', ')}) DO UPDATE SET
      (${fields.join(', ')}) = (${incoming.join(', ')})
    WHERE (${fields.map(field => `${table}.${field}`).join(', ')}) IS NOT (${incoming.join(', ')})`;
}

const DAILY_UPSERTS = { provider: dailyUpsert('provider'), model: dailyUpsert('model') };

export class UsageRollupStore {
  constructor(private readonly database: SqliteSession) {}

  dailyTimezone(): string {
    const row = this.database.statement('SELECT timezone FROM usage_rollup_meta WHERE singleton=1').get();
    if (typeof row?.timezone !== 'string') throw new Error('Missing daily usage timezone');
    return row.timezone;
  }

  /** 시간대가 바뀌면 읽을 수 있는 원본을 다시 집계하고 미반영 파일의 재시도를 보장한다. */
  setDailyTimezone(timezone: string): void {
    if (this.dailyTimezone() === timezone) return;
    calendarPeriod(0, timezone, 'day');
    this.database.transaction(() => {
      if (this.dailyTimezone() === timezone) return;
      this.database.statement('UPDATE usage_rollup_meta SET timezone=? WHERE singleton=1').run(timezone);
      this.database.connection.exec('UPDATE source_file SET parser_version=0 WHERE source_missing=0');
    });
  }

  replaceDaily(sessions: readonly SessionRef[], summaries: readonly TurnSummaryInput[], retain: boolean,
    profile: StageProfiler<StorageStage>): void {
    if (!sessions.length) return;
    const timezone = this.dailyTimezone();
    const scope = JSON.stringify(sessions.map(row => [row.provider, row.session_id]));
    const missing = retain ? this.database.statement(MISSING_SESSIONS).all(scope).map(row => [row.provider, row.session_id]) : [];
    const where = `WHERE ${SESSION_SET_FILTER} ${missing.length ? REPLACE_MISSING_DAYS : ''}`;
    const params = [scope];
    if (missing.length) {
      const missingSessions = new Set(missing.map(session => JSON.stringify(session)));
      const dates = new Map<string, [Provider, string, string]>();
      for (const row of summaries) {
        if (!missingSessions.has(JSON.stringify([row.provider, row.session_id]))) continue;
        const day = row.started_at_ms == null ? '' : calendarPeriod(row.started_at_ms, timezone, 'day');
        const date: [Provider, string, string] = [row.provider, row.session_id, day];
        dates.set(JSON.stringify(date), date);
      }
      // Missing sessions keep old dates for which this scan could produce no new result.
      params.push(JSON.stringify(missing), JSON.stringify([...dates.values()]));
    }

    const facts = dailyFacts(summaries);
    for (const by of ['provider', 'model'] as const) {
      const table = ROLLUP_TABLES[by];
      profile.measure(by === 'provider' ? 'rollupRequestInsert' : 'rollupModelInsert', () => {
        this.database.statement(DAILY_UPSERTS[by]).run(timezone, facts[by]);
      });
      const keys = dailyKeyColumns(by).join(', ');
      profile.measure(by === 'provider' ? 'rollupRequestDelete' : 'rollupModelDelete', () => {
        this.database.statement(`DELETE FROM ${table} WHERE (${keys}) IN (
          SELECT ${keys} FROM ${table} ${where}
          EXCEPT
          ${dailyKeySource(by, DAILY_FACTS_SOURCE)}
        )`).run(...params, timezone, facts[by]);
      });
    }
    this.database.statement(`DELETE FROM usage_capability_daily ${where}`).run(...params);
  }

  clear(): void {
    this.database.connection.exec('DELETE FROM usage_request_daily; DELETE FROM usage_model_daily; DELETE FROM usage_capability_daily;');
  }
}
