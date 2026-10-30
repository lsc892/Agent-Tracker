// 큰 세션 snapshot을 TEMP에서 한 번 비교하고 소수 변경 또는 일괄 교체로 반영한다.
import type { SQLInputValue } from 'node:sqlite';
import type { SqliteSession } from './connection';
import type { SessionReplacement, TurnSummaryInput } from './types';
import { nonnegative } from './validation';
import { estimateCost, PRICING_VERSION } from '../pricing';

export const TURN_COLUMNS = `provider,project_key,session_id,root_turn_id,request_title,started_at_ms,completed_at_ms,
  duration_ms,duration_quality,input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens,total_tokens,
  status,quality_flags,diagnostic_file_id,diagnostic_offset,last_error,updated_at`.split(',').map(s => s.trim());
const MODEL_COLUMNS = 'model,input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens,estimated_cost_usd,pricing_version';
const CAP_COLUMNS = 'category,name,usage_count';
const JOIN_KEY = 't.provider=n.provider AND t.session_id=n.session_id AND t.root_turn_id=n.root_turn_id';
const TEMP_TABLES = ['session_next', 'session_next_models', 'session_next_caps', 'session_model_changes', 'session_cap_changes', 'session_matches', 'session_removed'];
const MIN_SESSION_TURNS = 1000;
const MAX_CHANGED_TURNS = 32;

/** 입력을 한 번 소비하고 SQL 집합 비교로 큰 세션의 쓰기 범위를 선택한다. */
export class SessionChanges {
  private oldCount = 0;
  private changedCount = 0;
  private replaceAll = true;
  constructor(private readonly database: SqliteSession,
    private readonly values: (row: TurnSummaryInput, now: string) => SQLInputValue[]) {}

  eligible(replacement: SessionReplacement): boolean {
    if (replacement.preserveCapabilities) return false;
    if (this.database.statement('SELECT 1 FROM db_removed_files UNION ALL SELECT 1 FROM db_retained_turns LIMIT 1').get()) return false;
    const counts = this.database.statement(`SELECT min(n) AS smallest,sum(n) AS total FROM (
      SELECT r.provider,r.session_id,count(t.id) AS n FROM db_replacement_sessions r
      LEFT JOIN turn_summary t ON t.provider=r.provider AND t.session_id=r.session_id GROUP BY r.provider,r.session_id)`).get();
    this.oldCount = Number(counts?.total ?? 0);
    return Number(counts?.smallest ?? 0) >= MIN_SESSION_TURNS;
  }

  stage(replacement: SessionReplacement, now: string): void {
    this.database.connection.exec(`CREATE TEMP TABLE IF NOT EXISTS session_next AS
      SELECT 0 AS seq,0 AS explicit_time,NULL AS project_name,NULL AS session_name,NULL AS billing,${TURN_COLUMNS} FROM turn_summary WHERE 0;
      CREATE UNIQUE INDEX IF NOT EXISTS temp.session_next_seq ON session_next(seq);
      CREATE UNIQUE INDEX IF NOT EXISTS temp.session_next_key ON session_next(provider,session_id,root_turn_id);
      CREATE TEMP TABLE IF NOT EXISTS session_next_models(seq INTEGER NOT NULL,model TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER,
        cache_write_input_tokens INTEGER,cache_read_input_tokens INTEGER,estimated_cost_usd REAL,pricing_version TEXT NOT NULL,
        PRIMARY KEY(seq,model)) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS session_next_caps(seq INTEGER NOT NULL,category TEXT NOT NULL CHECK(category IN ('skill','subagent','plugin','model')),
        name TEXT NOT NULL,usage_count INTEGER NOT NULL CHECK(usage_count>0),PRIMARY KEY(seq,category,name)) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS session_model_changes(seq INTEGER PRIMARY KEY);
      CREATE TEMP TABLE IF NOT EXISTS session_cap_changes(seq INTEGER PRIMARY KEY);
      CREATE TEMP TABLE IF NOT EXISTS session_removed(id INTEGER PRIMARY KEY);`);
    this.clear();
    const insert = this.database.statement(`INSERT INTO session_next VALUES(${Array(TURN_COLUMNS.length + 5).fill('?')})`);
    const hasSession = this.database.statement('SELECT 1 FROM db_replacement_sessions WHERE provider=? AND session_id=?');
    let seq = 0;
    for (const row of replacement.summaries) {
      if (!hasSession.get(row.provider,row.session_id)) throw new Error('Summary is outside the replacement session group');
      if (row.project_name === null) throw new Error('Project name cannot be null');
      insert.run(seq,Number(row.updated_at !== undefined),row.project_name,row.session_name?.trim() || null,row.billing ?? null,...this.values(row,now));
      this.stageModels(row,seq);
      for (const usage of row.capability_usage ?? []) {
        nonnegative(usage.usage_count,'capability count');
        if (usage.name.length > 512) throw new RangeError('Capability name is too long');
        this.database.statement('INSERT INTO session_next_caps VALUES(?,?,?,?)').run(seq,usage.category,usage.name,usage.usage_count);
      }
      seq++;
    }
    this.compare();
    const changed = this.database.statement(`SELECT (SELECT count(*) FROM session_matches WHERE changed)
      +(SELECT count(*) FROM session_removed) AS n`).get();
    this.changedCount = Number(changed?.n ?? 0);
    this.replaceAll = this.changedCount > Math.min(MAX_CHANGED_TURNS,Math.floor(this.oldCount / 10));
  }

  private stageModels(row: TurnSummaryInput, seq: number): void {
    let input = 0, output = 0, cacheWrite = 0, cacheRead = 0;
    const insert = this.database.statement('INSERT INTO session_next_models VALUES(?,?,?,?,?,?,?,?)');
    for (const model of row.model_usage ?? []) {
      nonnegative(model.input_tokens,'model input tokens'); nonnegative(model.output_tokens,'model output tokens');
      if (model.cache_write_input_tokens != null) nonnegative(model.cache_write_input_tokens,'model cache write tokens');
      if (model.cache_read_input_tokens != null) nonnegative(model.cache_read_input_tokens,'model cache read tokens');
      if ((model.cache_write_input_tokens ?? 0)+(model.cache_read_input_tokens ?? 0)>model.input_tokens) throw new RangeError('Invalid model cache components');
      insert.run(seq,model.model,model.input_tokens,model.output_tokens,model.cache_write_input_tokens,model.cache_read_input_tokens,
        estimateCost(row.provider,model),PRICING_VERSION);
      input+=model.input_tokens; output+=model.output_tokens; cacheWrite+=model.cache_write_input_tokens ?? 0; cacheRead+=model.cache_read_input_tokens ?? 0;
    }
    if (row.model_usage && (input!==row.input_tokens || output!==row.output_tokens || cacheWrite!==(row.cache_write_input_tokens ?? 0)
      || cacheRead!==(row.cache_read_input_tokens ?? 0))) throw new RangeError('Model totals must match the request summary');
  }

  private compare(): void {
    const connection = this.database.connection;
    for (const [table,next,changes,columns] of [['turn_model_usage','session_next_models','session_model_changes',MODEL_COLUMNS],
      ['turn_capability_usage','session_next_caps','session_cap_changes',CAP_COLUMNS]]) {
      const old = `SELECT n.seq,${columns.split(',').map(c=>`u.${c}`)} FROM session_next n
        JOIN turn_summary t ON ${JOIN_KEY} JOIN ${table} u ON u.turn_id=t.id`;
      const incoming = `SELECT seq,${columns} FROM ${next}`;
      connection.exec(`INSERT OR IGNORE INTO ${changes} SELECT seq FROM (${old} EXCEPT ${incoming});
        INSERT OR IGNORE INTO ${changes} SELECT seq FROM (${incoming} EXCEPT ${old});`);
    }
    const different = TURN_COLUMNS.filter(c=>c!=='updated_at').map(c=>`t.${c} IS NOT n.${c}`).join(' OR ');
    connection.exec(`DROP TABLE IF EXISTS temp.session_matches;`);
    this.database.statement(`CREATE TEMP TABLE session_matches AS SELECT n.seq,t.id AS old_id,
      (t.id IS NULL OR ${different} OR (n.explicit_time AND t.updated_at IS NOT n.updated_at)
        OR mc.seq IS NOT NULL OR cc.seq IS NOT NULL OR coalesce(b.billing_mode,n.billing,'unknown') IS NOT c.billing_mode
        OR c.pricing_version IS NOT ?) AS changed,
      (t.id IS NULL OR mc.seq IS NOT NULL) AS models_changed,(t.id IS NULL OR cc.seq IS NOT NULL) AS caps_changed
      FROM session_next n LEFT JOIN turn_summary t ON ${JOIN_KEY}
      LEFT JOIN session_model_changes mc ON mc.seq=n.seq LEFT JOIN session_cap_changes cc ON cc.seq=n.seq
      LEFT JOIN session_billing b ON b.provider=n.provider AND b.session_id=n.session_id LEFT JOIN turn_costs c ON c.turn_id=t.id`)
      .run(PRICING_VERSION);
    connection.exec(`CREATE UNIQUE INDEX temp.session_matches_seq ON session_matches(seq);
      INSERT INTO session_removed SELECT id FROM turn_summary WHERE (provider,session_id) IN
        (SELECT provider,session_id FROM db_replacement_sessions) AND id NOT IN (SELECT old_id FROM session_matches WHERE old_id IS NOT NULL);`);
  }

  apply(): boolean {
    const c = this.database.connection;
    // Choose the last supplied name just as the streaming UPSERT loop does; blank session names preserve old metadata.
    c.exec(`INSERT INTO projects SELECT n.project_key,n.project_name FROM session_next n WHERE n.seq IN
        (SELECT max(seq) FROM session_next GROUP BY project_key)
      ON CONFLICT(project_key) DO UPDATE SET project_name=excluded.project_name WHERE project_name<>excluded.project_name;
      INSERT INTO sessions SELECT n.provider,n.session_id,n.session_name FROM session_next n WHERE n.seq IN
        (SELECT max(seq) FROM session_next WHERE session_name IS NOT NULL GROUP BY provider,session_id)
      ON CONFLICT(provider,session_id) DO UPDATE SET session_name=excluded.session_name;
      INSERT OR IGNORE INTO db_replacement_projects SELECT project_key FROM session_next;`);
    // Sessions with no new nonempty name still have to exist for the facts FK.
    c.exec(`INSERT OR IGNORE INTO sessions SELECT DISTINCT provider,session_id,NULL FROM session_next;`);
    if (this.replaceAll) {
      c.exec(`DELETE FROM turn_summary WHERE (provider,session_id) IN (SELECT provider,session_id FROM db_replacement_sessions)`);
    } else {
      c.exec('DELETE FROM turn_summary WHERE id IN (SELECT id FROM session_removed)');
      c.exec(`UPDATE turn_summary AS t SET (${TURN_COLUMNS})=(SELECT ${TURN_COLUMNS.map(k=>`n.${k}`)} FROM session_next n
        JOIN session_matches m ON m.seq=n.seq WHERE m.old_id=t.id) WHERE id IN (SELECT old_id FROM session_matches WHERE changed AND old_id IS NOT NULL)`);
    }
    c.exec(`INSERT INTO turn_summary(${TURN_COLUMNS}) SELECT ${TURN_COLUMNS.map(k=>`n.${k}`)} FROM session_next n
      JOIN session_matches m ON m.seq=n.seq ${this.replaceAll?'':'WHERE m.old_id IS NULL'} ORDER BY n.seq;`);
    for (const [table,next,columns,flag] of [['turn_model_usage','session_next_models',MODEL_COLUMNS,'models_changed'],
      ['turn_capability_usage','session_next_caps',CAP_COLUMNS,'caps_changed']]) {
      if (!this.replaceAll) c.exec(`DELETE FROM ${table} WHERE turn_id IN (SELECT old_id FROM session_matches WHERE ${flag} AND old_id IS NOT NULL)`);
      c.exec(`INSERT INTO ${table} SELECT t.id,${columns.split(',').map(k=>`u.${k}`)} FROM ${next} u
        JOIN session_next n ON n.seq=u.seq JOIN session_matches m ON m.seq=n.seq JOIN turn_summary t ON ${JOIN_KEY}
        ${this.replaceAll?'':`WHERE m.${flag}`}`);
    }
    this.database.statement(`INSERT OR REPLACE INTO turn_costs SELECT t.id,coalesce(b.billing_mode,n.billing,'unknown') AS mode,
      CASE WHEN coalesce(b.billing_mode,n.billing,'unknown')='subscription' THEN 0
        WHEN coalesce(b.billing_mode,n.billing,'unknown')='api' THEN sum(u.estimated_cost_usd) END,
      CASE WHEN coalesce(b.billing_mode,n.billing,'unknown')='subscription' THEN 0
        WHEN coalesce(b.billing_mode,n.billing,'unknown')='api' THEN max(1,count(u.turn_id))-count(u.estimated_cost_usd)
        ELSE max(1,count(u.turn_id)) END,?
      FROM session_next n JOIN session_matches m ON m.seq=n.seq JOIN turn_summary t ON ${JOIN_KEY}
      LEFT JOIN session_billing b ON b.provider=t.provider AND b.session_id=t.session_id
      LEFT JOIN turn_model_usage u ON u.turn_id=t.id ${this.replaceAll?'':'WHERE m.changed'} GROUP BY t.id`)
      .run(PRICING_VERSION);
    return this.changedCount>0;
  }

  clear(): void {
    for (const table of TEMP_TABLES) {
      if (this.database.statement("SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name=?").get(table)) {
        this.database.connection.exec(`DELETE FROM ${table}`);
      }
    }
  }
}
