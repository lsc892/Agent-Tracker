import type { SQLInputValue } from 'node:sqlite';
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

/** Installs complete session groups and their dependent usage and billing rows atomically. */
export class SessionStore {
  constructor(private readonly database: SqliteSession, private readonly billing: SessionBillingStore) {}

  /** Removes only derived statistics; transcript sources and lock files are untouched. */
  clearData(): void {
    this.database.transaction(() => {
      this.database.rollups.clear();
      this.database.connection.exec('DELETE FROM turn_summary; DELETE FROM manifest; DELETE FROM sessions; DELETE FROM projects;');
    });
  }

  /** Stage outside this call; this transaction only installs a complete session group. */
  replaceSessions(replacement: SessionReplacement): void {
    this.database.transaction(() => {
      this.database.connection.exec(`CREATE TEMP TABLE IF NOT EXISTS db_replacement_sessions (
        provider TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(provider, session_id)
      ) WITHOUT ROWID; DELETE FROM db_replacement_sessions;
      CREATE TEMP TABLE IF NOT EXISTS db_replacement_projects(project_key TEXT PRIMARY KEY) WITHOUT ROWID;
      DELETE FROM db_replacement_projects;`);
      const addSession = this.database.statement('INSERT OR IGNORE INTO db_replacement_sessions VALUES (?, ?)');
      for (const session of replacement.sessions) addSession.run(session.provider, session.session_id);
      const hasSession = this.database.statement('SELECT 1 FROM db_replacement_sessions WHERE provider = ? AND session_id = ?');
      const existingFile = this.database.statement('SELECT provider, session_id FROM manifest WHERE id = ?');
      const requireSession = (provider: SQLInputValue, session: SQLInputValue): void => {
        if (session !== null && !hasSession.get(provider, session)) {
          throw new Error('Manifest file is outside the replacement session group');
        }
      };
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
          WHERE (t.provider,t.session_id) IN (SELECT provider,session_id FROM db_replacement_sessions);`);
      this.database.connection.exec(`DELETE FROM turn_summary WHERE (provider, session_id) IN (
        SELECT provider, session_id FROM db_replacement_sessions
      )`);
      const updateFile = this.database.statement(`UPDATE manifest SET
        source_root = ?, path = ?, session_id = ?, size_bytes = ?, mtime_ms = ?, dev = ?, inode = ?, parser_version = ?, capabilities_collected = ?,
        processing_status = 'done', processing_position = 'committed', recorded_at = ?, last_error = NULL
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
      const insert = this.database.statement(TURN_INSERT);
      const project = this.database.statement(`INSERT INTO projects VALUES (?,?) ON CONFLICT(project_key)
        DO UPDATE SET project_name=excluded.project_name WHERE project_name<>excluded.project_name`);
      const session = this.database.statement(`INSERT INTO sessions VALUES (?,?,?) ON CONFLICT(provider,session_id)
        DO UPDATE SET session_name=excluded.session_name
        WHERE excluded.session_name IS NOT NULL AND session_name IS NOT excluded.session_name`);
      const addProject = this.database.statement('INSERT OR IGNORE INTO db_replacement_projects VALUES (?)');
      for (const summary of replacement.summaries) {
        if (!hasSession.get(summary.provider, summary.session_id)) throw new Error('Summary is outside the replacement session group');
        project.run(summary.project_key, summary.project_name);
        session.run(summary.provider, summary.session_id, summary.session_name?.trim() || null);
        addProject.run(summary.project_key);
        const inserted = insert.run(...turnValues(summary, now));
        for (const usage of summary.capability_usage ?? []) {
          nonnegative(usage.usage_count, 'capability count');
          if (usage.name.length > 512) throw new RangeError('Capability name is too long');
          this.database.statement('INSERT INTO turn_capability_usage VALUES (?,?,?,?)')
            .run(inserted.lastInsertRowid,usage.category,usage.name,usage.usage_count);
        }
        let input = 0, output = 0, cacheWrite = 0, cacheRead = 0;
        for (const model of summary.model_usage ?? []) {
          nonnegative(model.input_tokens, 'model input tokens');
          nonnegative(model.output_tokens, 'model output tokens');
          if (model.cache_write_input_tokens != null) nonnegative(model.cache_write_input_tokens, 'model cache write tokens');
          if (model.cache_read_input_tokens != null) nonnegative(model.cache_read_input_tokens, 'model cache read tokens');
          if ((model.cache_write_input_tokens ?? 0) + (model.cache_read_input_tokens ?? 0) > model.input_tokens) throw new RangeError('Invalid model cache components');
          this.database.statement('INSERT INTO turn_model_usage VALUES (?,?,?,?,?,?,?,?)').run(inserted.lastInsertRowid,model.model,
            model.input_tokens,model.output_tokens,model.cache_write_input_tokens,model.cache_read_input_tokens,
            estimateCost(summary.provider,model),PRICING_VERSION);
          input += model.input_tokens; output += model.output_tokens;
          cacheWrite += model.cache_write_input_tokens ?? 0; cacheRead += model.cache_read_input_tokens ?? 0;
        }
        if (summary.model_usage && (input !== summary.input_tokens || output !== summary.output_tokens
          || cacheWrite !== (summary.cache_write_input_tokens ?? 0) || cacheRead !== (summary.cache_read_input_tokens ?? 0))) {
          throw new RangeError('Model totals must match the request summary');
        }
        const chosen = this.database.statement('SELECT billing_mode FROM session_billing WHERE provider=? AND session_id=?')
          .get(summary.provider,summary.session_id)?.billing_mode as BillingMode | undefined;
        this.billing.saveTurnCost(inserted.lastInsertRowid,chosen ?? summary.billing ?? 'unknown');
      }
      const remove = this.database.statement('DELETE FROM manifest WHERE id = ?');
      if (replacement.preserveCapabilities) this.database.connection.exec(`
        INSERT INTO turn_capability_usage SELECT t.id,u.category,u.name,u.usage_count FROM db_saved_capabilities u
          JOIN turn_summary t ON t.provider=u.provider AND t.session_id=u.session_id AND t.root_turn_id=u.root_turn_id;
        DELETE FROM db_saved_capabilities;`);
      for (const id of replacement.removedFileIds ?? []) {
        const previous = existingFile.get(id);
        if (previous) requireSession(previous.provider, previous.session_id);
        remove.run(id);
      }
      this.database.rollups.refreshChangedSessions();
      this.database.connection.exec(`DELETE FROM sessions WHERE (provider,session_id) IN (SELECT provider,session_id FROM db_replacement_sessions)
        AND NOT EXISTS(SELECT 1 FROM turn_summary t WHERE t.provider=sessions.provider AND t.session_id=sessions.session_id);
        DELETE FROM projects WHERE project_key IN (SELECT project_key FROM db_replacement_projects)
        AND NOT EXISTS(SELECT 1 FROM turn_summary t WHERE t.provider='claude' AND t.project_key=projects.project_key)
        AND NOT EXISTS(SELECT 1 FROM turn_summary t WHERE t.provider='codex' AND t.project_key=projects.project_key);
        DELETE FROM db_replacement_sessions; DELETE FROM db_replacement_projects;`);
    });
  }

}
