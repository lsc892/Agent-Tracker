import type { SQLInputValue, StatementSync } from 'node:sqlite';
import type { SessionBillingStore } from './billing';
import type { SqliteSession } from './connection';
import type { BillingMode, SessionReplacement, TurnSummaryInput } from './types';
import { nonnegative } from './validation';
import { estimateCost, PRICING_VERSION } from '../pricing';

const TURN_INSERT = `INSERT INTO turn_summary (
  provider, project_key, session_id, root_turn_id, request_title,
  started_at_ms, completed_at_ms, duration_ms, duration_quality,
  input_tokens, output_tokens, cache_write_input_tokens, cache_read_input_tokens, total_tokens, status, quality_flags,
  diagnostic_file_id, diagnostic_offset, last_error, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/**
 * 책임: 요청 요약의 숫자·캐시 불변식을 저장 전에 검증한다.
 * 알고리즘: 토큰·duration의 비음수 정수와 캐시 합계 상한을 검사하고 미상 null과 생략된 기본값을 구분해 INSERT 순서로 변환한다.
 */
function turnValues(row: TurnSummaryInput, now: string): SQLInputValue[] {
  for (const name of ['input_tokens', 'output_tokens', 'total_tokens'] as const) {
    nonnegative(row[name], name);
  }
  if (row.duration_ms != null) nonnegative(row.duration_ms, 'duration_ms');
  for (const name of ['cache_write_input_tokens', 'cache_read_input_tokens'] as const) {
    if (row[name] != null) nonnegative(row[name], name);
  }
  if ((row.cache_write_input_tokens ?? 0) + (row.cache_read_input_tokens ?? 0) > row.input_tokens) {
    throw new RangeError('Cache components cannot exceed input tokens');
  }
  return [
    row.provider, row.project_key, row.session_id, row.root_turn_id, row.request_title ?? null,
    row.started_at_ms ?? null, row.completed_at_ms ?? null, row.duration_ms ?? null, row.duration_quality,
    row.input_tokens, row.output_tokens,
    row.cache_write_input_tokens === undefined ? 0 : row.cache_write_input_tokens,
    row.cache_read_input_tokens === undefined ? 0 : row.cache_read_input_tokens,
    row.total_tokens, row.status, row.quality_flags ?? null,
    row.diagnostic_file_id ?? null, row.diagnostic_offset ?? null, row.last_error ?? null, row.updated_at ?? now,
  ];
}

/**
 * 책임: 세션과 종속된 요청·모델·도구·비용·집계를 함께 저장한다.
 * 알고리즘: 교체 대상 집합을 TEMP에 두고 단일 트랜잭션에서 검증·교체·보존·사전 집계 갱신을 수행한다.
 */
export class SessionStore {
  constructor(private readonly database: SqliteSession, private readonly billing: SessionBillingStore) {}

  /** Removes only derived statistics; transcript sources and lock files are untouched. */
  clearData(): void {
    this.database.transaction(() => {
      this.database.rollups.clear();
      this.database.connection.exec('DELETE FROM turn_summary; DELETE FROM manifest; DELETE FROM sessions; DELETE FROM projects;');
    });
  }

  /**
   * 책임: 준비가 끝난 세션 묶음만 통계에 원자적으로 반영한다.
   * 알고리즘: 대상·원본 참조를 검증하고 삭제 원본의 유효 요청을 보존한 뒤 나머지를 재삽입하며, 모델 합계 검증과 rollup 갱신도 함께 커밋한다.
   */
  replaceSessions(replacement: SessionReplacement): void {
    this.database.transaction(() => {
      this.prepareReplacementSessions(replacement);
      const hasSession = this.database.statement('SELECT 1 FROM db_replacement_sessions WHERE provider = ? AND session_id = ?');
      const existingFile = this.database.statement('SELECT provider, session_id FROM manifest WHERE id = ?');
      const requireSession = (provider: SQLInputValue, session: SQLInputValue): void => {
        if (session !== null && !hasSession.get(provider, session)) {
          throw new Error('Manifest file is outside the replacement session group');
        }
      };
      this.prepareRemovedFiles(replacement, existingFile, requireSession);
      this.preserveReplacementData(replacement);
      this.database.connection.exec(`DELETE FROM turn_summary WHERE (provider, session_id) IN (
        SELECT provider, session_id FROM db_replacement_sessions
      ) AND id NOT IN (SELECT id FROM db_retained_turns)`);
      const now = this.replaceManifestFiles(replacement, existingFile, requireSession);
      this.insertSummaries(replacement, hasSession, now);
      this.restoreCapabilitiesAndRemoveFiles(replacement, now);
      this.database.rollups.refreshChangedSessions();
      this.cleanReplacementNames();
    });
  }

  private prepareReplacementSessions(replacement: SessionReplacement): void {
    this.database.connection.exec(`CREATE TEMP TABLE IF NOT EXISTS db_replacement_sessions (
        provider TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(provider, session_id)
      ) WITHOUT ROWID; DELETE FROM db_replacement_sessions;
      CREATE TEMP TABLE IF NOT EXISTS db_replacement_projects(project_key TEXT PRIMARY KEY) WITHOUT ROWID;
      DELETE FROM db_replacement_projects;
      CREATE TEMP TABLE IF NOT EXISTS db_removed_files(id INTEGER PRIMARY KEY);
      DELETE FROM db_removed_files;
      CREATE TEMP TABLE IF NOT EXISTS db_retained_turns(
        id INTEGER PRIMARY KEY,provider TEXT NOT NULL,session_id TEXT NOT NULL,root_turn_id TEXT NOT NULL,
        UNIQUE(provider,session_id,root_turn_id));
      CREATE INDEX IF NOT EXISTS temp.db_retained_root ON db_retained_turns(provider,root_turn_id);
      DELETE FROM db_retained_turns;`);
    const addSession = this.database.statement('INSERT OR IGNORE INTO db_replacement_sessions VALUES (?, ?)');
    for (const session of replacement.sessions) addSession.run(session.provider, session.session_id);
  }

  private prepareRemovedFiles(replacement: SessionReplacement, existingFile: StatementSync, requireSession: (provider: SQLInputValue, session: SQLInputValue) => void): void {
    const addRemoved = this.database.statement('INSERT INTO db_removed_files VALUES (?)');
    for (const id of replacement.removedFileIds ?? []) {
      const previous = existingFile.get(id);
      if (previous) requireSession(previous.provider, previous.session_id);
      addRemoved.run(id);
    }
    if (replacement.retainDeletedSourceUsage) this.database.connection.exec(`
        INSERT INTO db_retained_turns SELECT t.id,t.provider,t.session_id,t.root_turn_id FROM turn_summary t
        JOIN sessions s ON s.provider=t.provider AND s.session_id=t.session_id
        WHERE (t.provider,t.session_id) IN (SELECT m.provider,m.session_id FROM db_removed_files r JOIN manifest m ON m.id=r.id)
          AND trim(t.session_id)<>'' AND trim(t.root_turn_id)<>'' AND t.total_tokens>0
          AND EXISTS(SELECT 1 FROM turn_model_usage u WHERE u.turn_id=t.id AND trim(u.model)<>'' AND u.input_tokens+u.output_tokens>0);`);
  }

  private preserveReplacementData(replacement: SessionReplacement): void {
    // Row-value IN lets SQLite seek the request UNIQUE index by its session prefix;
    // a correlated EXISTS scans every stored turn for each replaced session.
    this.database.connection.exec(`INSERT OR IGNORE INTO db_replacement_projects SELECT project_key FROM turn_summary
        WHERE (provider,session_id) IN (SELECT provider,session_id FROM db_replacement_sessions)`);
    if (replacement.preserveCapabilities) this.database.connection.exec(`
        CREATE TEMP TABLE IF NOT EXISTS db_saved_capabilities (
          provider TEXT NOT NULL,session_id TEXT NOT NULL,root_turn_id TEXT NOT NULL,
          category TEXT NOT NULL,name TEXT NOT NULL,usage_count INTEGER NOT NULL,
          PRIMARY KEY(provider,session_id,root_turn_id,category,name)
        ) WITHOUT ROWID;
        DELETE FROM db_saved_capabilities;
        INSERT INTO db_saved_capabilities SELECT t.provider,t.session_id,t.root_turn_id,u.category,u.name,u.usage_count
          FROM turn_summary t JOIN turn_capability_usage u ON u.turn_id=t.id
          WHERE (t.provider,t.session_id) IN (SELECT provider,session_id FROM db_replacement_sessions)
            AND t.id NOT IN (SELECT id FROM db_retained_turns);`);
  }

  private replaceManifestFiles(replacement: SessionReplacement, existingFile: StatementSync, requireSession: (provider: SQLInputValue, session: SQLInputValue) => void): string {
    const updateFile = this.database.statement(`UPDATE manifest SET
        source_root = ?, path = ?, session_id = ?, size_bytes = ?, mtime_ms = ?, dev = ?, inode = ?, parser_version = ?, capabilities_collected = ?,
        source_missing = 0, processing_status = 'done', processing_position = 'committed', recorded_at = ?, last_error = NULL
        WHERE id = ? AND provider = ?`);
    const now = new Date().toISOString();
    for (const file of replacement.files) {
      nonnegative(file.size_bytes, 'size_bytes');
      const previous = existingFile.get(file.id);
      if (!previous || previous.provider !== file.provider) throw new Error('Replacement refers to an unknown manifest file');
      requireSession(previous.provider, previous.session_id);
      requireSession(file.provider, file.session_id);
      const result = updateFile.run(file.source_root, file.path, file.session_id, file.size_bytes, file.mtime_ms,
        file.dev, file.inode, file.parser_version, file.capabilities_collected ?? 1, now, file.id, file.provider);
      if (result.changes !== 1) throw new Error('Replacement refers to an unknown manifest file');
    }
    return now;
  }

  private insertSummaries(replacement: SessionReplacement, hasSession: StatementSync, now: string): void {
    const insert = this.database.statement(TURN_INSERT);
    const project = this.database.statement(`INSERT INTO projects VALUES (?,?) ON CONFLICT(project_key)
        DO UPDATE SET project_name=excluded.project_name WHERE project_name<>excluded.project_name`);
    const session = this.database.statement(`INSERT INTO sessions VALUES (?,?,?) ON CONFLICT(provider,session_id)
        DO UPDATE SET session_name=excluded.session_name
        WHERE excluded.session_name IS NOT NULL AND session_name IS NOT excluded.session_name`);
    const addProject = this.database.statement('INSERT OR IGNORE INTO db_replacement_projects VALUES (?)');
    // A request snapshot includes all source contributions. With a source missing, replacing
    // or adding to that snapshot would lose usage or double count overlapping responses.
    const retained = this.database.statement('SELECT 1 FROM db_retained_turns WHERE provider=? AND root_turn_id=? LIMIT 1');
    for (const summary of replacement.summaries) {
      if (!hasSession.get(summary.provider, summary.session_id)) throw new Error('Summary is outside the replacement session group');
      if (retained.get(summary.provider,summary.root_turn_id)) continue;
      project.run(summary.project_key, summary.project_name);
      session.run(summary.provider, summary.session_id, summary.session_name?.trim() || null);
      addProject.run(summary.project_key);
      const inserted = insert.run(...turnValues(summary, now));
      this.insertCapabilityUsage(summary, inserted.lastInsertRowid);
      this.insertModelUsage(summary, inserted.lastInsertRowid);
      this.saveSummaryCost(summary, inserted.lastInsertRowid);
    }
  }

  private insertCapabilityUsage(summary: TurnSummaryInput, turnId: number | bigint): void {
    for (const usage of summary.capability_usage ?? []) {
      nonnegative(usage.usage_count, 'capability count');
      if (usage.name.length > 512) throw new RangeError('Capability name is too long');
      this.database.statement('INSERT INTO turn_capability_usage VALUES (?,?,?,?)')
        .run(turnId,usage.category,usage.name,usage.usage_count);
    }
  }

  private insertModelUsage(summary: TurnSummaryInput, turnId: number | bigint): void {
    let input = 0, output = 0, cacheWrite = 0, cacheRead = 0;
    for (const model of summary.model_usage ?? []) {
      nonnegative(model.input_tokens, 'model input tokens');
      nonnegative(model.output_tokens, 'model output tokens');
      if (model.cache_write_input_tokens != null) nonnegative(model.cache_write_input_tokens, 'model cache write tokens');
      if (model.cache_read_input_tokens != null) nonnegative(model.cache_read_input_tokens, 'model cache read tokens');
      if ((model.cache_write_input_tokens ?? 0) + (model.cache_read_input_tokens ?? 0) > model.input_tokens) throw new RangeError('Invalid model cache components');
      this.database.statement('INSERT INTO turn_model_usage VALUES (?,?,?,?,?,?,?,?)').run(turnId,model.model,
        model.input_tokens,model.output_tokens,model.cache_write_input_tokens,model.cache_read_input_tokens,
        estimateCost(summary.provider,model),PRICING_VERSION);
      input += model.input_tokens; output += model.output_tokens;
      cacheWrite += model.cache_write_input_tokens ?? 0; cacheRead += model.cache_read_input_tokens ?? 0;
    }
    if (summary.model_usage && (input !== summary.input_tokens || output !== summary.output_tokens
      || cacheWrite !== (summary.cache_write_input_tokens ?? 0) || cacheRead !== (summary.cache_read_input_tokens ?? 0))) {
      throw new RangeError('Model totals must match the request summary');
    }
  }

  private saveSummaryCost(summary: TurnSummaryInput, turnId: number | bigint): void {
    const chosen = this.database.statement('SELECT billing_mode FROM session_billing WHERE provider=? AND session_id=?')
      .get(summary.provider,summary.session_id)?.billing_mode as BillingMode | undefined;
    this.billing.saveTurnCost(turnId,chosen ?? summary.billing ?? 'unknown');
  }

  private restoreCapabilitiesAndRemoveFiles(replacement: SessionReplacement, now: string): void {
    const remove = this.database.statement('DELETE FROM manifest WHERE id = ?');
    if (replacement.preserveCapabilities) this.database.connection.exec(`
        INSERT INTO turn_capability_usage SELECT t.id,u.category,u.name,u.usage_count FROM db_saved_capabilities u
          JOIN turn_summary t ON t.provider=u.provider AND t.session_id=u.session_id AND t.root_turn_id=u.root_turn_id;
        DELETE FROM db_saved_capabilities;`);
    const keepMissing = this.database.statement(`SELECT 1 FROM db_retained_turns t JOIN manifest m
        ON m.provider=t.provider AND m.session_id=t.session_id WHERE m.id=? LIMIT 1`);
    const markMissing = this.database.statement('UPDATE manifest SET source_missing=1,recorded_at=? WHERE id=? AND source_missing=0');
    for (const row of this.database.statement('SELECT id FROM db_removed_files').iterate()) {
      if (keepMissing.get(row.id)) markMissing.run(now,row.id);
      else remove.run(row.id);
    }
  }

  private cleanReplacementNames(): void {
    this.database.connection.exec(`DELETE FROM sessions WHERE (provider,session_id) IN (SELECT provider,session_id FROM db_replacement_sessions)
        AND NOT EXISTS(SELECT 1 FROM turn_summary t WHERE t.provider=sessions.provider AND t.session_id=sessions.session_id);
        DELETE FROM projects WHERE project_key IN (SELECT project_key FROM db_replacement_projects)
        AND NOT EXISTS(SELECT 1 FROM turn_summary t WHERE t.provider='claude' AND t.project_key=projects.project_key)
        AND NOT EXISTS(SELECT 1 FROM turn_summary t WHERE t.provider='codex' AND t.project_key=projects.project_key);
        DELETE FROM db_replacement_sessions; DELETE FROM db_replacement_projects;
        DELETE FROM db_removed_files; DELETE FROM db_retained_turns;`);
  }
}
