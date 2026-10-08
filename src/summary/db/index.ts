import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION, SCHEMA_LEGACY_MIGRATION_SQL, SCHEMA_CACHE_MIGRATION_SQL, SCHEMA_MODEL_SQL, SCHEMA_CAPABILITY_SQL } from './schema';
import { calendarPeriod } from './timezone';
import { estimateCost, PRICING_VERSION } from '../pricing';
import type { NameQuery, NameResult } from '../types';
import type {
  DiagnosticsPage, FileMetadata, KeysetPage, ManifestRow, OffsetPage,
  ProcessingStatus, Provider, SessionReplacement, SummaryFilter,
  TurnSummaryInput, TurnSummaryRow, UsageGrouping, UsageRow, ChartMetric, UsageChart, CumulativeRow, BillingMode,
  CapabilityCategory, CapabilityPage, CapabilityRow,
} from './types';

export * from './types';
export { periodBounds } from './timezone';

const pageLimit = (limit = 100): number => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError('Page limit must be an integer between 1 and 1000');
  }
  return limit;
};

function nonnegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative integer`);
  return value;
}

const TURN_INSERT = `INSERT INTO turn_summary (
  provider, project_key, session_id, root_turn_id, turn_index, request_title,
  started_at_ms, completed_at_ms, duration_ms, duration_quality,
  input_tokens, output_tokens, cache_write_input_tokens, cache_read_input_tokens, total_tokens, status, quality_flags,
  diagnostic_file_id, diagnostic_offset, last_error, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const COSTED_TURNS = `(SELECT t.*,c.cost_usd,coalesce(c.unknown_costs,1) AS unknown_costs,
  coalesce(c.billing_mode,'unknown') AS billing_mode FROM turn_summary t LEFT JOIN turn_costs c ON c.turn_id=t.id)`;
// Keep unrecorded usage separate from tokens whose model is unknown.
const MODEL_NAME = `CASE WHEN coalesce(m.model,'')='' AND coalesce(m.input_tokens+m.output_tokens,t.total_tokens)=0
  THEN NULL ELSE coalesce(m.model,'') END AS model`;
// One row per request/model; older summaries retain all reported tokens.
const modelTurns = (costs = false): string => `(SELECT t.id,t.provider,t.project_key,t.session_id,t.root_turn_id,t.turn_index,
  t.request_title,
  t.started_at_ms,t.completed_at_ms,t.duration_ms,t.duration_quality,t.status,t.quality_flags,
  t.diagnostic_file_id,t.diagnostic_offset,t.last_error,t.updated_at,${MODEL_NAME},
  coalesce(m.input_tokens,t.input_tokens) AS input_tokens,coalesce(m.output_tokens,t.output_tokens) AS output_tokens,
  CASE WHEN m.turn_id IS NULL THEN t.cache_write_input_tokens ELSE m.cache_write_input_tokens END AS cache_write_input_tokens,
  CASE WHEN m.turn_id IS NULL THEN t.cache_read_input_tokens ELSE m.cache_read_input_tokens END AS cache_read_input_tokens,
  coalesce(m.input_tokens+m.output_tokens,t.total_tokens) AS total_tokens${costs ? `,
  coalesce(c.billing_mode,'unknown') AS billing_mode,
  CASE WHEN c.billing_mode='subscription' THEN 0 WHEN c.billing_mode='api' THEN m.estimated_cost_usd END AS cost_usd,
  CASE WHEN c.billing_mode='subscription' OR c.billing_mode='api' AND m.estimated_cost_usd IS NOT NULL THEN 0 ELSE 1 END AS unknown_costs` : ''}
  FROM turn_summary t LEFT JOIN turn_model_usage m ON m.turn_id=t.id${costs ? ' LEFT JOIN turn_costs c ON c.turn_id=t.id' : ''})`;
const usageTurns = (costs = false, by: 'provider' | 'model' = 'provider'): string => {
  if (by === 'model') return modelTurns(costs);
  if (by !== 'provider') throw new RangeError('Unknown usage grouping basis');
  return costs ? COSTED_TURNS : 'turn_summary';
};
const namedTurns = (costs = false, by: 'provider' | 'model' = 'provider'): string => `(SELECT t.*, p.project_name, s.session_name FROM ${usageTurns(costs,by)} t
  JOIN projects p ON p.project_key=t.project_key
  JOIN sessions s ON s.provider=t.provider AND s.session_id=t.session_id)`;
const NAMED_TURNS = namedTurns();
const COST_SUMS = `SUM(cost_usd) AS cost_usd,SUM(unknown_costs) AS unknown_costs,
  CASE WHEN min(billing_mode)=max(billing_mode) THEN min(billing_mode) ELSE 'unknown' END AS billing_mode`;

const USAGE_SUMS = `SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
  CASE WHEN COUNT(cache_write_input_tokens) = COUNT(*) THEN SUM(cache_write_input_tokens) END AS cache_write_input_tokens,
  CASE WHEN COUNT(cache_read_input_tokens) = COUNT(*) THEN SUM(cache_read_input_tokens) END AS cache_read_input_tokens,
  SUM(total_tokens) AS total_tokens, COUNT(*) AS turn_count,
  SUM(status = 'completed') AS completed_turns,
  AVG(CASE WHEN status = 'completed' THEN total_tokens END) AS avg_tokens_per_turn,
  AVG(CASE WHEN status = 'completed' THEN duration_ms END) AS avg_duration_ms,
  SUM(status = 'completed' AND duration_ms IS NOT NULL) AS turns_with_duration,
  SUM(status = 'completed' AND duration_quality = 'exact') AS exact_duration_turns,
  SUM(status = 'completed' AND duration_quality = 'derived') AS derived_duration_turns,
  SUM(status = 'completed' AND duration_quality = 'approximate') AS approximate_duration_turns,
  SUM(status = 'completed' AND duration_ms IS NULL) AS missing_duration_turns,
  SUM(started_at_ms IS NULL) AS unknown_time_turns,
  SUM(last_error IS NOT NULL) AS stale_turns, MAX(updated_at) AS last_successful_update`;

function turnValues(row: TurnSummaryInput, now: string): SQLInputValue[] {
  for (const name of ['input_tokens', 'output_tokens', 'total_tokens', 'turn_index'] as const) {
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
    row.provider, row.project_key, row.session_id, row.root_turn_id, row.turn_index, row.request_title ?? null,
    row.started_at_ms ?? null, row.completed_at_ms ?? null, row.duration_ms ?? null, row.duration_quality,
    row.input_tokens, row.output_tokens,
    row.cache_write_input_tokens === undefined ? 0 : row.cache_write_input_tokens,
    row.cache_read_input_tokens === undefined ? 0 : row.cache_read_input_tokens,
    row.total_tokens, row.status, row.quality_flags ?? null,
    row.diagnostic_file_id ?? null, row.diagnostic_offset ?? null, row.last_error ?? null, row.updated_at ?? now,
  ];
}

function whereClause(filter: SummaryFilter): { sql: string; values: SQLInputValue[] } {
  const clauses: string[] = [];
  const values: SQLInputValue[] = [];
  if (filter.providers) {
    clauses.push(filter.providers.length ? `provider IN (${filter.providers.map(() => '?').join(',')})` : '0 = 1');
    values.push(...filter.providers);
  }
  for (const [name, column] of [['provider', 'provider'], ['projectKey', 'project_key'], ['sessionId', 'session_id']] as const) {
    if (filter[name] !== undefined) {
      clauses.push(`${column} = ?`);
      values.push(filter[name]!);
    }
  }
  for (const [name, table, condition, column] of [
    ['projectName', 'projects', 'projects.project_key=turn_summary.project_key', 'project_name'],
    ['sessionName', 'sessions', 'sessions.provider=turn_summary.provider AND sessions.session_id=turn_summary.session_id', 'session_name'],
  ] as const) {
    if (filter[name]) {
      clauses.push(`EXISTS(SELECT 1 FROM ${table} WHERE ${condition} AND ${column} LIKE ? ESCAPE '\\')`);
      values.push(`%${filter[name]!.replace(/[\\%_]/g, character => `\\${character}`)}%`);
    }
  }
  const time: string[] = [];
  for (const [name, operator] of [['fromMs', '>='], ['toMs', '<']] as const) {
    if (filter[name] !== undefined) {
      if (!Number.isSafeInteger(filter[name])) throw new RangeError(`${name} must be an epoch millisecond integer`);
      time.push(`started_at_ms ${operator} ?`);
      values.push(filter[name]!);
    }
  }
  if (filter.unknownTime === 'only') {
    // A missing timestamp cannot satisfy a supplied UTC interval.
    values.splice(values.length - time.length, time.length);
    clauses.push('started_at_ms IS NULL');
  } else if (time.length) {
    clauses.push(filter.unknownTime === 'include'
      ? `((${time.join(' AND ')}) OR started_at_ms IS NULL)` : `(${time.join(' AND ')})`);
  } else if (filter.unknownTime === 'exclude') {
    clauses.push('started_at_ms IS NOT NULL');
  }
  return { sql: clauses.length ? clauses.join(' AND ') : '1 = 1', values };
}

/** Synchronous database access is confined to the summary worker. */
export class SummaryDatabase {
  readonly connection: DatabaseSync;
  private closed = false;
  // Only fixed SQL statements from metadata/commit methods enter this cache.
  // Its size does not grow with file, session, or user-query counts.
  private readonly statements = new Map<string, StatementSync>();

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.connection.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  constructor(options: string | { databasePath: string; cacheKiB?: number }) {
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
      const version = this.connection.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version.user_version > SCHEMA_VERSION) throw new Error('Database schema is newer than this extension');
      if (version.user_version < SCHEMA_VERSION) {
        this.transaction(() => {
          // Another window can finish migration while this connection waits for the write lock.
          const current = this.connection.prepare('PRAGMA user_version').get() as { user_version: number };
          if (current.user_version > SCHEMA_VERSION) throw new Error('Database schema is newer than this extension');
          if (current.user_version === SCHEMA_VERSION) return;
          this.connection.exec(current.user_version === 1 || current.user_version === 2 ? SCHEMA_LEGACY_MIGRATION_SQL
            : current.user_version === 3 ? SCHEMA_CACHE_MIGRATION_SQL : SCHEMA_SQL);
          this.connection.exec(SCHEMA_MODEL_SQL);
          this.connection.exec(SCHEMA_CAPABILITY_SQL);
          if (!this.connection.prepare('PRAGMA table_info(manifest)').all().some(column=>column.name==='capabilities_collected')) {
            this.connection.exec('ALTER TABLE manifest ADD COLUMN capabilities_collected INTEGER NOT NULL DEFAULT 0 CHECK(capabilities_collected IN (0,1))');
          }
          if (!this.connection.prepare('PRAGMA table_info(turn_summary)').all().some(column=>column.name==='request_title')) {
            this.connection.exec('ALTER TABLE turn_summary ADD COLUMN request_title TEXT');
          }
          this.connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        });
      }
      this.connection.function('agent_tracker_period', { deterministic: true }, (timestamp, timezone, unit) => {
        if (timestamp === null) return null;
        return calendarPeriod(Number(timestamp), String(timezone), unit === 'month' ? 'month' : 'day');
      });
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  close(): void {
    if (!this.closed) {
      this.statements.clear();
      this.connection.close();
      this.closed = true;
    }
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

  /** Removes only derived statistics; transcript sources and lock files are untouched. */
  clearData(): void {
    this.transaction(() => this.connection.exec('DELETE FROM turn_summary; DELETE FROM manifest; DELETE FROM sessions; DELETE FROM projects;'));
  }

  findManifest(provider: Provider, path: string): ManifestRow | undefined {
    return this.statement('SELECT * FROM manifest WHERE provider = ? AND path = ?')
      .get(provider, path) as unknown as ManifestRow | undefined;
  }

  /** At most two candidates are needed: multiple identities disable the move shortcut. */
  findIdentity(provider: Provider, dev: string | null, inode: string | null): ManifestRow[] {
    if (!dev || !inode || dev === '0' || inode === '0') return [];
    return this.statement('SELECT * FROM manifest WHERE provider = ? AND dev = ? AND inode = ? LIMIT 2')
      .all(provider, dev, inode) as unknown as ManifestRow[];
  }

  /** Discovery updates presence only; accepted metadata is replaced with the session. */
  observeFile(metadata: FileMetadata, scanId: string): ManifestRow {
    return this.statement(`INSERT INTO manifest (
      provider, source_root, path, last_seen_scan_id, processing_status, processing_position, recorded_at
    ) VALUES (?, ?, ?, ?, 'processing', 'discovery', ?)
    ON CONFLICT(provider, path) DO UPDATE SET last_seen_scan_id = excluded.last_seen_scan_id
    RETURNING *`)
      .get(metadata.provider, metadata.source_root, metadata.path, scanId, new Date().toISOString()) as unknown as ManifestRow;
  }

  markSeen(id: number, scanId: string): void {
    this.statement('UPDATE manifest SET last_seen_scan_id = ? WHERE id = ?').run(scanId, id);
  }

  setManifestDiagnostic(id: number, status: ProcessingStatus, position: string | null, error: string | null, offset: number | null = null): void {
    this.transaction(() => {
      const file = this.statement('SELECT provider, session_id FROM manifest WHERE id = ?').get(id);
      if (!file) throw new Error('Unknown manifest file');
      this.statement(`UPDATE manifest SET processing_status = ?, processing_position = ?, recorded_at = ?, last_error = ? WHERE id = ?`)
        .run(status, position, new Date().toISOString(), error, id);
      if (status === 'error' || status === 'interrupted') {
        this.statement(`UPDATE turn_summary SET diagnostic_file_id = ?, diagnostic_offset = ?, last_error = ?
          WHERE provider = ? AND session_id = ?`)
          .run(id, offset, error ?? status, file.provider, file.session_id);
      }
    });
  }

  *sessionFiles(provider: Provider, sessionId: string, limit = 100): IterableIterator<ManifestRow> {
    pageLimit(limit);
    let after = 0;
    const query = this.connection.prepare('SELECT * FROM manifest WHERE provider = ? AND session_id = ? AND id > ? ORDER BY id LIMIT ?');
    while (true) {
      const rows = query.all(provider, sessionId, after, limit) as unknown as ManifestRow[];
      for (const row of rows) yield row;
      if (rows.length < limit) return;
      after = rows[rows.length - 1].id;
    }
  }

  /** Call only after all selected roots were successfully traversed. */
  *unseenFiles(provider: Provider, sourceRoot: string, scanId: string, limit = 100): IterableIterator<ManifestRow> {
    pageLimit(limit);
    let after = 0;
    const query = this.connection.prepare(`SELECT * FROM manifest WHERE provider = ? AND source_root = ?
      AND (last_seen_scan_id IS NULL OR last_seen_scan_id <> ?) AND id > ? ORDER BY id LIMIT ?`);
    while (true) {
      const rows = query.all(provider, sourceRoot, scanId, after, limit) as unknown as ManifestRow[];
      for (const row of rows) yield row;
      if (rows.length < limit) return;
      after = rows[rows.length - 1].id;
    }
  }

  /** Stage outside this call; this transaction only installs a complete session group. */
  replaceSessions(replacement: SessionReplacement): void {
    this.transaction(() => {
      this.connection.exec(`CREATE TEMP TABLE IF NOT EXISTS db_replacement_sessions (
        provider TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(provider, session_id)
      ) WITHOUT ROWID; DELETE FROM db_replacement_sessions;
      CREATE TEMP TABLE IF NOT EXISTS db_replacement_projects(project_key TEXT PRIMARY KEY) WITHOUT ROWID;
      DELETE FROM db_replacement_projects;`);
      const addSession = this.statement('INSERT OR IGNORE INTO db_replacement_sessions VALUES (?, ?)');
      for (const session of replacement.sessions) addSession.run(session.provider, session.session_id);
      const hasSession = this.statement('SELECT 1 FROM db_replacement_sessions WHERE provider = ? AND session_id = ?');
      const existingFile = this.statement('SELECT provider, session_id FROM manifest WHERE id = ?');
      const requireSession = (provider: SQLInputValue, session: SQLInputValue): void => {
        if (session !== null && !hasSession.get(provider, session)) {
          throw new Error('Manifest file is outside the replacement session group');
        }
      };
      // Row-value IN lets SQLite seek idx_summary_session for the small group;
      // a correlated EXISTS scans every stored turn for each replaced session.
      this.connection.exec(`INSERT OR IGNORE INTO db_replacement_projects SELECT project_key FROM turn_summary
        WHERE (provider,session_id) IN (SELECT provider,session_id FROM db_replacement_sessions)`);
      if (replacement.preserveCapabilities) this.connection.exec(`
        CREATE TEMP TABLE IF NOT EXISTS db_saved_capabilities (
          provider TEXT NOT NULL,session_id TEXT NOT NULL,root_turn_id TEXT NOT NULL,
          category TEXT NOT NULL,name TEXT NOT NULL,usage_count INTEGER NOT NULL,
          PRIMARY KEY(provider,session_id,root_turn_id,category,name)
        ) WITHOUT ROWID;
        DELETE FROM db_saved_capabilities;
        INSERT INTO db_saved_capabilities SELECT t.provider,t.session_id,t.root_turn_id,u.category,u.name,u.usage_count
          FROM turn_summary t JOIN turn_capability_usage u ON u.turn_id=t.id
          WHERE (t.provider,t.session_id) IN (SELECT provider,session_id FROM db_replacement_sessions);`);
      this.connection.exec(`DELETE FROM turn_summary WHERE (provider, session_id) IN (
        SELECT provider, session_id FROM db_replacement_sessions
      )`);
      const updateFile = this.statement(`UPDATE manifest SET
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
      const insert = this.statement(TURN_INSERT);
      const project = this.statement(`INSERT INTO projects VALUES (?,?) ON CONFLICT(project_key)
        DO UPDATE SET project_name=excluded.project_name WHERE project_name<>excluded.project_name`);
      const session = this.statement(`INSERT INTO sessions VALUES (?,?,?) ON CONFLICT(provider,session_id)
        DO UPDATE SET session_name=excluded.session_name
        WHERE excluded.session_name IS NOT NULL AND session_name IS NOT excluded.session_name`);
      const addProject = this.statement('INSERT OR IGNORE INTO db_replacement_projects VALUES (?)');
      for (const summary of replacement.summaries) {
        if (!hasSession.get(summary.provider, summary.session_id)) throw new Error('Summary is outside the replacement session group');
        project.run(summary.project_key, summary.project_name);
        session.run(summary.provider, summary.session_id, summary.session_name?.trim() || null);
        addProject.run(summary.project_key);
        const inserted = insert.run(...turnValues(summary, now));
        for (const usage of summary.capability_usage ?? []) {
          nonnegative(usage.usage_count, 'capability count');
          if (usage.name.length > 512) throw new RangeError('Capability name is too long');
          this.statement('INSERT INTO turn_capability_usage VALUES (?,?,?,?)')
            .run(inserted.lastInsertRowid,usage.category,usage.name,usage.usage_count);
        }
        let input = 0, output = 0, cacheWrite = 0, cacheRead = 0;
        for (const model of summary.model_usage ?? []) {
          nonnegative(model.input_tokens, 'model input tokens');
          nonnegative(model.output_tokens, 'model output tokens');
          if (model.cache_write_input_tokens != null) nonnegative(model.cache_write_input_tokens, 'model cache write tokens');
          if (model.cache_read_input_tokens != null) nonnegative(model.cache_read_input_tokens, 'model cache read tokens');
          if ((model.cache_write_input_tokens ?? 0) + (model.cache_read_input_tokens ?? 0) > model.input_tokens) throw new RangeError('Invalid model cache components');
          this.statement('INSERT INTO turn_model_usage VALUES (?,?,?,?,?,?,?,?)').run(inserted.lastInsertRowid,model.model,
            model.input_tokens,model.output_tokens,model.cache_write_input_tokens,model.cache_read_input_tokens,
            estimateCost(summary.provider,model),PRICING_VERSION);
          input += model.input_tokens; output += model.output_tokens;
          cacheWrite += model.cache_write_input_tokens ?? 0; cacheRead += model.cache_read_input_tokens ?? 0;
        }
        if (summary.model_usage && (input !== summary.input_tokens || output !== summary.output_tokens
          || cacheWrite !== (summary.cache_write_input_tokens ?? 0) || cacheRead !== (summary.cache_read_input_tokens ?? 0))) {
          throw new RangeError('Model totals must match the request summary');
        }
        const chosen = this.statement('SELECT billing_mode FROM session_billing WHERE provider=? AND session_id=?')
          .get(summary.provider,summary.session_id)?.billing_mode as BillingMode | undefined;
        this.saveTurnCost(inserted.lastInsertRowid,chosen ?? summary.billing ?? 'unknown');
      }
      const remove = this.statement('DELETE FROM manifest WHERE id = ?');
      if (replacement.preserveCapabilities) this.connection.exec(`
        INSERT INTO turn_capability_usage SELECT t.id,u.category,u.name,u.usage_count FROM db_saved_capabilities u
          JOIN turn_summary t ON t.provider=u.provider AND t.session_id=u.session_id AND t.root_turn_id=u.root_turn_id;
        DELETE FROM db_saved_capabilities;`);
      for (const id of replacement.removedFileIds ?? []) {
        const previous = existingFile.get(id);
        if (previous) requireSession(previous.provider, previous.session_id);
        remove.run(id);
      }
      this.connection.exec(`DELETE FROM sessions WHERE (provider,session_id) IN (SELECT provider,session_id FROM db_replacement_sessions)
        AND NOT EXISTS(SELECT 1 FROM turn_summary t WHERE t.provider=sessions.provider AND t.session_id=sessions.session_id);
        DELETE FROM projects WHERE project_key IN (SELECT project_key FROM db_replacement_projects)
        AND NOT EXISTS(SELECT 1 FROM turn_summary t WHERE t.provider='claude' AND t.project_key=projects.project_key)
        AND NOT EXISTS(SELECT 1 FROM turn_summary t WHERE t.provider='codex' AND t.project_key=projects.project_key);
        DELETE FROM db_replacement_sessions; DELETE FROM db_replacement_projects;`);
    });
  }

  /** Name choices cover all stored usage, independently of dates and the table page. */
  queryNames(query: NameQuery): NameResult {
    if (!['project', 'session'].includes(query.kind)) throw new RangeError('Unknown name kind');
    const session = query.kind === 'session';
    const where = whereClause({ provider: query.provider, providers: query.providers,
      projectKey: session ? query.projectKey : undefined });
    const groups = session ? 'provider, project_key, session_id' : 'project_key';
    const total = (this.connection.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM turn_summary WHERE ${where.sql} GROUP BY ${groups}
    )`).get(...where.values) as { count: number }).count;
    const rows = this.connection.prepare(`SELECT project_key,
      (SELECT project_name FROM projects p WHERE p.project_key=turn_summary.project_key) AS project_name,
      ${session ? 'provider' : 'NULL'} AS provider,
      ${session ? 'session_id' : 'NULL'} AS session_id,
      ${session ? '(SELECT session_name FROM sessions s WHERE s.provider=turn_summary.provider AND s.session_id=turn_summary.session_id)' : 'NULL'} AS session_name,
      ${session ? 'MIN(started_at_ms)' : 'NULL'} AS session_started_at_ms
      FROM turn_summary WHERE ${where.sql} GROUP BY ${groups}
      ORDER BY ${session ? "COALESCE(session_name, '이름 없는 세션') COLLATE NOCASE, provider," : ''}
        project_name COLLATE NOCASE, project_key${session ? ', session_started_at_ms, session_id' : ''}
      LIMIT ? OFFSET ?`).all(...where.values, pageLimit(query.limit), nonnegative(query.offset ?? 0, 'offset')) as unknown as NameResult['rows'];
    return { rows, total };
  }

  queryTurns(filter: SummaryFilter = {}, page: KeysetPage & { offset?: number } = {}, by: 'provider' | 'model' = 'provider'): TurnSummaryRow[] {
    const where = whereClause(filter);
    const after = nonnegative(page.afterId ?? 0, 'afterId');
    const offset = nonnegative(page.offset ?? 0, 'offset');
    return this.connection.prepare(`SELECT * FROM ${namedTurns(filter.includeCosts,by)} AS turn_summary WHERE ${where.sql} AND id > ? ORDER BY id${by === 'model' ? ',model' : ''} LIMIT ? OFFSET ?`)
      .all(...where.values, after, pageLimit(page.limit), offset) as unknown as TurnSummaryRow[];
  }

  private saveTurnCost(id: SQLInputValue, mode: BillingMode): void {
    this.statement(`INSERT OR REPLACE INTO turn_costs
      SELECT ?,?,CASE WHEN ?='subscription' THEN 0 WHEN ?='api' THEN sum(estimated_cost_usd) END,
        CASE WHEN ?='subscription' THEN 0 WHEN ?='api' THEN max(1,count(*))-count(estimated_cost_usd) ELSE max(1,count(*)) END,?
      FROM turn_model_usage WHERE turn_id=?`)
      .run(id,mode,mode,mode,mode,mode,PRICING_VERSION,id);
  }

  setSessionBilling(provider: Provider, sessionId: string, mode: BillingMode): void {
    if (!['claude','codex'].includes(provider) || !sessionId || !['subscription','api','unknown'].includes(mode)) throw new RangeError('Invalid session billing');
    this.transaction(() => {
      this.statement(`INSERT INTO session_billing VALUES (?,?,?)
        ON CONFLICT(provider,session_id) DO UPDATE SET billing_mode=excluded.billing_mode`).run(provider,sessionId,mode);
      // Page through ids to keep historical classification bounded, including large sessions.
      let after = 0;
      while (true) {
        const turns = this.statement('SELECT id FROM turn_summary WHERE provider=? AND session_id=? AND id>? ORDER BY id LIMIT 100')
          .all(provider,sessionId,after) as {id:number}[];
        if (!turns.length) break;
        for (const turn of turns) this.saveTurnCost(turn.id,mode);
        after = turns[turns.length-1].id;
      }
    });
  }

  sessionBilling(provider: Provider, sessionId: string): BillingMode {
    const chosen = this.statement('SELECT billing_mode FROM session_billing WHERE provider=? AND session_id=?')
      .get(provider,sessionId)?.billing_mode as BillingMode | undefined;
    if (chosen) return chosen;
    return this.statement(`SELECT CASE WHEN count(*)=count(c.billing_mode) AND min(c.billing_mode)=max(c.billing_mode)
      THEN min(c.billing_mode) ELSE 'unknown' END AS mode FROM turn_summary t LEFT JOIN turn_costs c ON c.turn_id=t.id
      WHERE t.provider=? AND t.session_id=?`).get(provider,sessionId)?.mode as BillingMode ?? 'unknown';
  }

  queryTurnsCount(filter: SummaryFilter = {}, by: 'provider' | 'model' = 'provider'): number {
    const where = whereClause(filter);
    return (this.connection.prepare(`SELECT COUNT(*) AS count FROM ${usageTurns(false,by)} AS turn_summary WHERE ${where.sql}`)
      .get(...where.values) as { count: number }).count;
  }

  queryCapabilities(filter: SummaryFilter, category: CapabilityCategory, offset = 0): CapabilityPage {
    if (!['skill','subagent','plugin','model'].includes(category)) throw new RangeError('Unknown capability category');
    const where = whereClause(filter);
    const source = `(SELECT t.*,u.category,u.name,u.usage_count FROM turn_summary t
      JOIN turn_capability_usage u ON u.turn_id=t.id) AS turn_summary`;
    const scope = `${where.sql} AND category=?`;
    const counts = this.connection.prepare(`SELECT count(*) AS total,coalesce(sum(uses),0) AS totalUses FROM (
      SELECT sum(usage_count) AS uses FROM ${source} WHERE ${scope} GROUP BY provider,name)`)
      .get(...where.values,category) as {total:number;totalUses:number};
    const ranking = this.connection.prepare(`SELECT provider,category,name,sum(usage_count) AS usage_count
      FROM ${source} WHERE ${scope} GROUP BY provider,name ORDER BY usage_count DESC,provider,name LIMIT ? OFFSET ?`);
    const pageOffset = nonnegative(offset,'offset');
    const rows = ranking.all(...where.values,category,100,pageOffset) as unknown as CapabilityRow[];
    const chartRows = pageOffset === 0 ? rows.slice(0,20)
      : ranking.all(...where.values,category,20,0) as unknown as CapabilityRow[];
    const withPercentage = (row: CapabilityRow): CapabilityRow => ({...row,percentage:counts.totalUses ? row.usage_count/counts.totalUses*100 : 0});
    return {...counts,rows:rows.map(withPercentage),chartRows:chartRows.map(withPercentage)};
  }

  queryCumulative(filter: SummaryFilter, by: 'provider' | 'model', offset = 0): { rows: CumulativeRow[]; total: number; by: 'provider' | 'model' } {
    if (by !== 'provider' && by !== 'model') throw new RangeError('Unknown cumulative grouping');
    const where = whereClause(filter);
    if (by === 'provider') return { rows: this.queryUsage(filter).map(row => ({ ...row, model: '' })), total: this.queryUsageCount(filter), by };
    // Preserve zero-token requests without assigning them to an unknown model.
    const source = `(SELECT t.provider,t.project_key,t.session_id,t.started_at_ms,${MODEL_NAME},
      coalesce(m.input_tokens,t.input_tokens) AS input_tokens,coalesce(m.output_tokens,t.output_tokens) AS output_tokens,
      CASE WHEN m.turn_id IS NULL THEN t.cache_write_input_tokens ELSE m.cache_write_input_tokens END AS cache_write_input_tokens,
      CASE WHEN m.turn_id IS NULL THEN t.cache_read_input_tokens ELSE m.cache_read_input_tokens END AS cache_read_input_tokens,
      coalesce(c.billing_mode,'unknown') AS billing_mode,
      CASE WHEN c.billing_mode='subscription' THEN 0 WHEN c.billing_mode='api' THEN m.estimated_cost_usd END AS cost_usd,
      CASE WHEN c.billing_mode='subscription' OR c.billing_mode='api' AND m.estimated_cost_usd IS NOT NULL THEN 0 ELSE 1 END AS unknown_costs
      FROM turn_summary t LEFT JOIN turn_model_usage m ON m.turn_id=t.id LEFT JOIN turn_costs c ON c.turn_id=t.id) AS turn_summary`;
    const total = (this.connection.prepare(`SELECT count(*) AS count FROM (
      SELECT 1 FROM ${source} WHERE ${where.sql} GROUP BY provider,model)`)
      .get(...where.values) as {count:number}).count;
    const rows = this.connection.prepare(`SELECT provider,model,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,
      CASE WHEN count(cache_write_input_tokens)=count(*) THEN sum(cache_write_input_tokens) END AS cache_write_input_tokens,
      CASE WHEN count(cache_read_input_tokens)=count(*) THEN sum(cache_read_input_tokens) END AS cache_read_input_tokens,
      sum(input_tokens+output_tokens) AS total_tokens${filter.includeCosts ? `,${COST_SUMS}` : ''} FROM ${source} WHERE ${where.sql}
      GROUP BY provider,model ORDER BY total_tokens DESC,provider,model LIMIT 100 OFFSET ?`)
      .all(...where.values,nonnegative(offset,'offset')) as unknown as CumulativeRow[];
    return { rows, total, by };
  }

  queryUsageCount(filter: SummaryFilter = {}, groupBy: UsageGrouping = 'total', timezone = 'UTC', by: 'provider' | 'model' = 'provider'): number {
    if (!['total', 'project', 'session', 'day', 'month'].includes(groupBy)) throw new RangeError('Unknown usage grouping');
    const calendar = groupBy === 'day' || groupBy === 'month';
    if (calendar) calendarPeriod(0, timezone, groupBy);
    const where = whereClause(calendar && filter.unknownTime === undefined ? { ...filter, unknownTime: 'include' } : filter);
    const groups = by === 'model' ? ['provider','model'] : ['provider'];
    if (groupBy === 'project' || groupBy === 'session') groups.push('project_key');
    if (groupBy === 'session') groups.push('session_id');
    if (calendar) groups.push('period');
    const prefix: SQLInputValue[] = calendar ? [timezone, groupBy] : [];
    return (this.connection.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT ${calendar ? 'agent_tracker_period(started_at_ms, ?, ?)' : 'NULL'} AS period
      FROM ${usageTurns(false,by)} AS turn_summary WHERE ${where.sql} GROUP BY ${groups.join(', ')}
    )`).get(...prefix, ...where.values) as { count: number }).count;
  }

  queryUsage(filter: SummaryFilter = {}, groupBy: UsageGrouping = 'total', timezone = 'UTC', page: OffsetPage & { sortBy?: ChartMetric } = {}, by: 'provider' | 'model' = 'provider'): UsageRow[] {
    if (!['total', 'project', 'session', 'day', 'month'].includes(groupBy)) throw new RangeError('Unknown usage grouping');
    if (groupBy === 'day' || groupBy === 'month') calendarPeriod(0, timezone, groupBy);
    const calendar = groupBy === 'day' || groupBy === 'month';
    // Undated turns cannot be assigned to the requested interval. Keep them in
    // their own NULL-period group so a date filter does not silently hide them.
    const where = whereClause(calendar && filter.unknownTime === undefined ? { ...filter, unknownTime: 'include' } : filter);
    const project = groupBy === 'project' || groupBy === 'session';
    const period = calendar ? 'agent_tracker_period(started_at_ms, ?, ?)' : 'NULL';
    const groups = by === 'model' ? ['provider','model'] : ['provider'];
    if (project) groups.push('project_key');
    if (groupBy === 'session') groups.push('session_id');
    if (calendar) groups.push('period');
    const prefix: SQLInputValue[] = calendar ? [timezone, groupBy] : [];
    const metricColumns = { tokens: 'total_tokens', requests: 'turn_count', averageTokens: 'avg_tokens_per_turn', averageDuration: 'avg_duration_ms' };
    const order = page.sortBy ? `${metricColumns[page.sortBy]} DESC, ${groups.join(', ')}` : groups.join(', ');
    return this.connection.prepare(`SELECT provider,${by === 'model' ? 'model,' : ''}
      ${project ? 'project_key' : 'NULL'} AS project_key,
      ${project ? '(SELECT project_name FROM projects p WHERE p.project_key=turn_summary.project_key)' : 'NULL'} AS project_name,
      ${groupBy === 'session' ? 'session_id' : 'NULL'} AS session_id,
      ${groupBy === 'session' ? '(SELECT session_name FROM sessions s WHERE s.provider=turn_summary.provider AND s.session_id=turn_summary.session_id)' : 'NULL'} AS session_name,
      ${groupBy === 'session' ? '(SELECT MIN(t.started_at_ms) FROM turn_summary t WHERE t.provider=turn_summary.provider AND t.session_id=turn_summary.session_id)' : 'NULL'} AS session_started_at_ms,
      ${period} AS period,
      ${USAGE_SUMS}${filter.includeCosts ? `,${COST_SUMS}` : ''}
      FROM ${usageTurns(filter.includeCosts,by)} AS turn_summary WHERE ${where.sql}
      GROUP BY ${groups.join(', ')} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...prefix, ...where.values, pageLimit(page.limit), nonnegative(page.offset ?? 0, 'offset')) as unknown as UsageRow[];
  }

  /** Bounded chart data is computed from the entire filter, independently of table pagination. */
  queryUsageChart(filter: SummaryFilter, groupBy: UsageGrouping | 'all' | 'turn', timezone: string, metric: ChartMetric, by: 'provider' | 'model' = 'provider'): UsageChart {
    if (!['tokens', 'requests', 'averageTokens', 'averageDuration'].includes(metric)) throw new RangeError('Unknown chart metric');
    if (by === 'model') return this.queryModelChart(filter, groupBy, timezone, metric);
    if (by !== 'provider') throw new RangeError('Unknown chart grouping');
    if (groupBy === 'turn') {
      const where = whereClause(filter);
      const rows = this.connection.prepare(`SELECT * FROM ${NAMED_TURNS} AS turn_summary WHERE ${where.sql}
        ORDER BY started_at_ms DESC, id DESC LIMIT 60`).all(...where.values) as unknown as TurnSummaryRow[];
      rows.reverse();
      return { rows, mode: 'turn', metric: metric === 'averageDuration' ? metric : 'tokens', total: this.queryTurnsCount(filter) };
    }
    const grouping = groupBy === 'all' ? 'total' : groupBy;
    const total = this.queryUsageCount(filter, grouping, timezone);
    if (grouping !== 'day' && grouping !== 'month') {
      return { rows: this.queryUsage(filter, grouping, timezone, { limit: 10, sortBy: metric }),
        mode: grouping === 'total' ? 'total' : 'ranking', metric, total };
    }
    calendarPeriod(0, timezone, grouping);
    const where = whereClause(filter.unknownTime === undefined ? { ...filter, unknownTime: 'include' } : filter);
    // At most 30 chronological bins per provider. Average raw completed turns,
    // never averages of daily averages; undated turns retain their own bin.
    const rows = this.connection.prepare(`WITH filtered AS (
      SELECT *, agent_tracker_period(started_at_ms, ?, ?) AS chart_period FROM turn_summary WHERE ${where.sql}
    ), periods AS (
      SELECT chart_period, NTILE(30) OVER (ORDER BY chart_period) AS bucket
      FROM (SELECT DISTINCT chart_period FROM filtered WHERE chart_period IS NOT NULL)
    ), ranges AS (
      SELECT bucket, MIN(chart_period) AS first_period, MAX(chart_period) AS last_period,
        COUNT(*) AS period_count FROM periods GROUP BY bucket
    ) SELECT provider, NULL AS project_key, NULL AS project_name, NULL AS session_id,
      NULL AS session_name, NULL AS session_started_at_ms,
      CASE WHEN first_period = last_period THEN first_period
        ELSE first_period || ' ~ ' || last_period END AS period,
      COALESCE(ranges.period_count, 0) AS period_count, ${USAGE_SUMS}
      FROM filtered LEFT JOIN periods USING (chart_period) LEFT JOIN ranges USING (bucket)
      GROUP BY bucket, provider ORDER BY bucket IS NULL, bucket, provider`)
      .all(timezone, grouping, ...where.values) as unknown as UsageRow[];
    return { rows, mode: 'calendar', metric, total };
  }

  private queryModelChart(filter: SummaryFilter, groupBy: UsageGrouping | 'all' | 'turn', timezone: string, metric: ChartMetric): UsageChart {
    if (!['total','all','day','month','project','session','turn'].includes(groupBy)) throw new RangeError('Unknown usage grouping');
    const calendar = groupBy === 'day' || groupBy === 'month';
    if (calendar) calendarPeriod(0, timezone, groupBy);
    const where = whereClause(calendar && filter.unknownTime === undefined ? {...filter,unknownTime:'include'} : filter);
    const args: SQLInputValue[] = [...(calendar ? [timezone,groupBy] : []),...where.values];
    // Model rows are already deduplicated per root request. Keep unknown models and unrecorded usage
    // and combine the tail per provider, preserving tokens and unique requests.
    const scope = `WITH model_turns AS ${modelTurns()}, filtered AS (
      SELECT *,${calendar ? 'agent_tracker_period(started_at_ms,?,?)' : 'NULL'} AS chart_period
      FROM model_turns AS turn_summary WHERE ${where.sql}
    ), ranked_models AS (
      SELECT provider,model,ROW_NUMBER() OVER (ORDER BY sum(total_tokens) DESC,provider,model) AS rank
      FROM filtered WHERE model<>'' GROUP BY provider,model
    ), bounded AS (
      SELECT id,provider,project_key,session_id,root_turn_id,turn_index,request_title,started_at_ms,status,duration_ms,duration_quality,
        last_error,updated_at,chart_period,CASE WHEN rank>8 THEN '' ELSE model END AS model,
        CASE WHEN rank>8 THEN 1 ELSE 0 END AS other_models,
        SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,
        CASE WHEN count(cache_write_input_tokens)=count(*) THEN sum(cache_write_input_tokens) END AS cache_write_input_tokens,
        CASE WHEN count(cache_read_input_tokens)=count(*) THEN sum(cache_read_input_tokens) END AS cache_read_input_tokens,
        SUM(total_tokens) AS total_tokens
      FROM filtered LEFT JOIN ranked_models USING(provider,model)
      GROUP BY id,CASE WHEN rank>8 THEN '' ELSE model END,CASE WHEN rank>8 THEN 1 ELSE 0 END
    )`;
    if (groupBy === 'turn') {
      const rows = this.connection.prepare(`${scope} SELECT b.*,
        (SELECT project_name FROM projects p WHERE p.project_key=b.project_key) AS project_name,
        (SELECT session_name FROM sessions s WHERE s.provider=b.provider AND s.session_id=b.session_id) AS session_name
        FROM bounded b ORDER BY started_at_ms DESC,id DESC,provider,model,other_models LIMIT 60`)
        .all(...args) as unknown as TurnSummaryRow[];
      rows.reverse();
      const total = (this.connection.prepare(`${scope} SELECT count(*) AS total FROM bounded`).get(...args) as {total:number}).total;
      return {rows,mode:'turn',metric:metric === 'averageDuration' ? metric : 'tokens',total,by:'model'};
    }
    const project = groupBy === 'project' || groupBy === 'session';
    const groups = ['provider','model','other_models',...(project ? ['project_key'] : []),...(groupBy === 'session' ? ['session_id'] : []),...(calendar ? ['chart_period'] : [])];
    const total = (this.connection.prepare(`${scope} SELECT count(*) AS total FROM (
      SELECT 1 FROM bounded GROUP BY ${groups.join(',')})`).get(...args) as {total:number}).total;
    const periods = calendar ? `,periods AS (
      SELECT chart_period,NTILE(30) OVER (ORDER BY chart_period) AS bucket
      FROM (SELECT DISTINCT chart_period FROM bounded WHERE chart_period IS NOT NULL)
    ),ranges AS (
      SELECT bucket,MIN(chart_period) AS first_period,MAX(chart_period) AS last_period,count(*) AS period_count
      FROM periods GROUP BY bucket)` : '';
    const metricColumns = {tokens:'total_tokens',requests:'turn_count',averageTokens:'avg_tokens_per_turn',averageDuration:'avg_duration_ms'};
    const rows = this.connection.prepare(`${scope}${periods} SELECT provider,model,other_models,
      ${project ? 'project_key' : 'NULL'} AS project_key,
      ${project ? '(SELECT project_name FROM projects p WHERE p.project_key=bounded.project_key)' : 'NULL'} AS project_name,
      ${groupBy === 'session' ? 'session_id' : 'NULL'} AS session_id,
      ${groupBy === 'session' ? '(SELECT session_name FROM sessions s WHERE s.provider=bounded.provider AND s.session_id=bounded.session_id)' : 'NULL'} AS session_name,
      NULL AS session_started_at_ms,
      ${calendar ? "CASE WHEN first_period=last_period THEN first_period ELSE first_period || ' ~ ' || last_period END" : 'NULL'} AS period,
      ${calendar ? 'coalesce(ranges.period_count,0)' : '0'} AS period_count,${USAGE_SUMS}
      FROM bounded ${calendar ? 'LEFT JOIN periods USING(chart_period) LEFT JOIN ranges USING(bucket)' : ''}
      GROUP BY ${calendar ? 'bucket,provider,model,other_models' : groups.join(',')}
      ORDER BY ${calendar ? 'bucket IS NULL,bucket,provider,other_models,model' : `${metricColumns[metric]} DESC,${groups.join(',')}`}
      ${project ? 'LIMIT 10' : ''}`).all(...args) as unknown as UsageRow[];
    return {rows,mode:calendar ? 'calendar' : project ? 'ranking' : 'total',metric,total,by:'model'};
  }

  diagnostics(page: KeysetPage & { afterSummaryId?: number; offset?: number; providers?: Provider[] } = {}): DiagnosticsPage {
    const limit = pageLimit(page.limit);
    const offset = nonnegative(page.offset ?? 0, 'offset');
    const where = whereClause({ providers: page.providers });
    const files = this.connection.prepare(`SELECT * FROM manifest WHERE ${where.sql} AND id > ? ORDER BY id LIMIT ? OFFSET ?`)
      .all(...where.values, nonnegative(page.afterId ?? 0, 'afterId'), limit, offset) as unknown as ManifestRow[];
    const summaries = this.connection.prepare(`SELECT * FROM ${NAMED_TURNS} AS turn_summary WHERE ${where.sql} AND id > ? AND
      (last_error IS NOT NULL OR (quality_flags IS NOT NULL AND quality_flags <> '[]' AND quality_flags <> ''))
      ORDER BY id LIMIT ? OFFSET ?`)
      .all(...where.values, nonnegative(page.afterSummaryId ?? 0, 'afterSummaryId'), limit, offset) as unknown as TurnSummaryRow[];
    const counts = this.connection.prepare(`SELECT COUNT(*) AS files,
      COALESCE(SUM(processing_status = 'processing'), 0) AS processing,
      COALESCE(SUM(processing_status = 'done'), 0) AS done,
      COALESCE(SUM(processing_status = 'error'), 0) AS error,
      COALESCE(SUM(processing_status = 'interrupted'), 0) AS interrupted,
      (SELECT COUNT(*) FROM turn_summary WHERE ${where.sql} AND last_error IS NOT NULL) AS stale_summaries
      FROM manifest WHERE ${where.sql}`).get(...where.values, ...where.values) as unknown as DiagnosticsPage['counts'];
    return {
      files, summaries, counts,
      nextFileId: files.length === limit ? files[files.length - 1].id : null,
      nextSummaryId: summaries.length === limit ? summaries[summaries.length - 1].id : null,
    };
  }
}
