// 메모리 집계에서 날짜별 사용량을 계산해 해당 세션의 일별 행을 교체한다.
import type { SqliteSession } from './connection';
import type { Provider, SessionRef, TurnSummaryInput } from './types';
import { aggregateUsageSource, dailyKeySource } from './queries/rollup/source';
import { DAILY_COST_STATES, dailyKeyColumns, rollupStates, ROLLUP_TABLES } from './rollup-state';
import type { StageProfiler, StorageStage } from '../profiling';
import { DAILY_FACTS_SOURCE, dailyFacts } from './dailyFacts';
import { calendarPeriod } from './timezone';

const SESSION_KEYS = `SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)`;
const SESSION_SET_FILTER = `(provider, session_id) IN (${SESSION_KEYS})`;
const AFFECTED_SESSION_FILTER = `(provider, session_id) IN (SELECT provider, session_id FROM affected_sessions)`;
const MISSING_SESSIONS = `SELECT DISTINCT f.provider, f.session_id FROM json_each(?) AS s
  CROSS JOIN source_file f ON f.provider=json_extract(s.value, '$[0]') AND f.session_id=json_extract(s.value, '$[1]')
  WHERE f.source_missing=1`;
const MISSING_DAY_FILTER = `(NOT (${SESSION_SET_FILTER}) OR (provider, session_id, local_day) IN (
  SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?)
))`;

function dailyStatements(by: keyof typeof ROLLUP_TABLES, insertStage: StorageStage, deleteStage: StorageStage) {
  // [저장 정책] 집계 기준별 키로 일별 행을 UPSERT하고 NULL까지 포함해 실제로 값이 달라진 행만 갱신한다.
  const table = ROLLUP_TABLES[by];
  const keys = dailyKeyColumns(by).join(', ');
  const states = [...rollupStates(by), ...DAILY_COST_STATES].map(state => state.name);
  const fields = by === 'model' ? ['model', ...states] : states;
  const incoming = fields.map(field => `excluded.${field}`);
  const upsert = `INSERT INTO ${table}
    SELECT * FROM (${aggregateUsageSource(by, DAILY_FACTS_SOURCE, 'local_day')}) WHERE true
    ON CONFLICT(${keys}) DO UPDATE SET
      (${fields.join(', ')}) = (${incoming.join(', ')})
    WHERE (${fields.map(field => `${table}.${field}`).join(', ')}) IS NOT (${incoming.join(', ')})`;

  // [저장 정책] 바깥 삭제와 키 대조가 같은 세션 목록을 사용해 영향 세션의 PK 범위만 탐색한다.
  const incomingKeys = dailyKeySource(by);
  const deleteAbsent = (extraFilter = '') => `WITH affected_sessions(provider, session_id) AS MATERIALIZED (${SESSION_KEYS})
    DELETE FROM ${table} WHERE ${AFFECTED_SESSION_FILTER} AND (${keys}) IN (
      SELECT ${keys} FROM ${table} WHERE ${AFFECTED_SESSION_FILTER}${extraFilter}
      EXCEPT
      ${incomingKeys}
    )`;
  return { upsert, insertStage, deleteStage, remove: deleteAbsent(),
    removeWithMissing: deleteAbsent(` AND ${MISSING_DAY_FILTER}`) };
}

const DAILY_STATEMENTS = {
  provider: dailyStatements('provider', 'rollupRequestInsert', 'rollupRequestDelete'),
  model: dailyStatements('model', 'rollupModelInsert', 'rollupModelDelete'),
};

export class UsageRollupStore {
  constructor(private readonly database: SqliteSession) {}

  dailyTimezone(): string {
    // [시간대 정책] 저장 당시의 시간대를 집계 메타데이터에서 읽고 값이 없으면 실패한다.
    const row = this.database.statement('SELECT timezone FROM usage_rollup_meta WHERE singleton=1').get();
    if (typeof row?.timezone !== 'string') throw new Error('Missing daily usage timezone');
    return row.timezone;
  }

  /** 시간대가 바뀌면 읽을 수 있는 원본을 다시 집계하고 미반영 파일의 재시도를 보장한다. */
  setDailyTimezone(timezone: string): void {
    if (this.dailyTimezone() === timezone) return;
    calendarPeriod(0, timezone, 'day');
    // [SQL 트랜잭션 정책] 잠금 뒤 시간대를 다시 확인하고 변경 시 남아 있는 원본의 파서 버전을 초기화한다.
    this.database.transaction(() => {
      if (this.dailyTimezone() === timezone) return;
      this.database.statement('UPDATE usage_rollup_meta SET timezone=? WHERE singleton=1').run(timezone);
      this.database.connection.exec('UPDATE source_file SET parser_version=0 WHERE source_missing=0');
    });
  }

  replaceDaily(sessions: readonly SessionRef[], summaries: readonly TurnSummaryInput[], retain: boolean,
    profile: StageProfiler<StorageStage>, preserveCapabilities = false): void {
    if (!sessions.length) return;

    // [SQL 트랜잭션 정책] 소실 원본을 보존하는 세션은 이번에 집계한 날짜만 교체 범위에 넣는다.
    const timezone = this.dailyTimezone();
    const scope = JSON.stringify(sessions.map(row => [row.provider, row.session_id]));
    const missing = retain ? this.database.statement(MISSING_SESSIONS).all(scope).map(row => [row.provider, row.session_id]) : [];
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
      params.push(JSON.stringify(missing), JSON.stringify([...dates.values()]));
    }

    // [SQL 트랜잭션 정책] 일별 제공자·모델 합계를 UPSERT하고 새 집계에서 사라진 키는 EXCEPT로 찾아 삭제한다.
    const facts = dailyFacts(summaries, timezone);
    for (const by of ['provider', 'model'] as const) {
      const { upsert, insertStage, deleteStage, remove, removeWithMissing } = DAILY_STATEMENTS[by];
      profile.measure(insertStage, () => {
        this.database.statement(upsert).run(facts[by]);
      });
      profile.measure(deleteStage, () => {
        this.database.statement(missing.length ? removeWithMissing : remove)
          .run(...params, by === 'provider' ? facts.requestKeys : facts.modelKeys);
      });
    }
    if (preserveCapabilities) {
      this.database.statement(`DELETE FROM usage_capability_daily WHERE ${SESSION_SET_FILTER}
        AND NOT EXISTS (SELECT 1 FROM usage_request_daily AS usage
          WHERE usage.provider=usage_capability_daily.provider AND usage.session_id=usage_capability_daily.session_id)`).run(scope);
    } else {
      const capabilities = [];
      for (const row of summaries) {
        for (const use of row.capability_usage ?? []) {
          capabilities.push([row.provider, row.session_id, row.project_key, row.started_at_ms ?? null,
            use.category, use.name, use.usage_count]);
        }
      }
      const filter = missing.length ? `${SESSION_SET_FILTER} AND ${MISSING_DAY_FILTER}` : SESSION_SET_FILTER;
      this.database.statement(`DELETE FROM usage_capability_daily WHERE ${filter}`).run(...params);
      if (capabilities.length) this.database.statement(`INSERT INTO usage_capability_daily
        SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]'),
          coalesce(agent_tracker_period(json_extract(value,'$[3]'), ?, 'day'),''),
          json_extract(value,'$[4]'), json_extract(value,'$[5]'), sum(json_extract(value,'$[6]'))
        FROM json_each(?) GROUP BY 1,2,3,4,5,6`).run(timezone, JSON.stringify(capabilities));
    }
  }

  clear(): void {
    this.database.connection.exec('DELETE FROM usage_request_daily; DELETE FROM usage_model_daily; DELETE FROM usage_capability_daily;');
  }
}
