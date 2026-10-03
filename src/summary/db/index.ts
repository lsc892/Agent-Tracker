import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';
import { calendarPeriod } from './timezone';
import type {
  DiagnosticsPage, FileMetadata, KeysetPage, ManifestRow, OffsetPage,
  ProcessingStatus, Provider, SessionReplacement, SummaryFilter,
  TurnSummaryInput, TurnSummaryRow, UsageGrouping, UsageRow,
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
  provider, project_key, project_name, session_id, root_turn_id, turn_index,
  started_at_ms, completed_at_ms, duration_ms, duration_quality,
  input_tokens, output_tokens, total_tokens, status, quality_flags,
  diagnostic_file_id, diagnostic_offset, last_error, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

function turnValues(row: TurnSummaryInput, now: string): SQLInputValue[] {
  for (const name of ['input_tokens', 'output_tokens', 'total_tokens', 'turn_index'] as const) {
    nonnegative(row[name], name);
  }
  if (row.duration_ms != null) nonnegative(row.duration_ms, 'duration_ms');
  return [
    row.provider, row.project_key, row.project_name, row.session_id, row.root_turn_id, row.turn_index,
    row.started_at_ms ?? null, row.completed_at_ms ?? null, row.duration_ms ?? null, row.duration_quality,
    row.input_tokens, row.output_tokens, row.total_tokens, row.status, row.quality_flags ?? null,
    row.diagnostic_file_id ?? null, row.diagnostic_offset ?? null, row.last_error ?? null, row.updated_at ?? now,
  ];
}

function whereClause(filter: SummaryFilter): { sql: string; values: SQLInputValue[] } {
  const clauses: string[] = [];
  const values: SQLInputValue[] = [];
  for (const [name, column] of [['provider', 'provider'], ['projectKey', 'project_key'], ['sessionId', 'session_id']] as const) {
    if (filter[name] !== undefined) {
      clauses.push(`${column} = ?`);
      values.push(filter[name]!);
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
          this.connection.exec(SCHEMA_SQL);
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
      ) WITHOUT ROWID; DELETE FROM db_replacement_sessions;`);
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
      this.connection.exec(`DELETE FROM turn_summary WHERE (provider, session_id) IN (
        SELECT provider, session_id FROM db_replacement_sessions
      )`);
      const updateFile = this.statement(`UPDATE manifest SET
        source_root = ?, path = ?, session_id = ?, size_bytes = ?, mtime_ms = ?, dev = ?, inode = ?, parser_version = ?,
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
          file.dev, file.inode, file.parser_version, now, file.id, file.provider);
        if (result.changes !== 1) throw new Error('Replacement refers to an unknown manifest file');
      }
      const insert = this.statement(TURN_INSERT);
      for (const summary of replacement.summaries) {
        if (!hasSession.get(summary.provider, summary.session_id)) throw new Error('Summary is outside the replacement session group');
        insert.run(...turnValues(summary, now));
      }
      const remove = this.statement('DELETE FROM manifest WHERE id = ?');
      for (const id of replacement.removedFileIds ?? []) {
        const previous = existingFile.get(id);
        if (previous) requireSession(previous.provider, previous.session_id);
        remove.run(id);
      }
      this.connection.exec('DELETE FROM db_replacement_sessions');
    });
  }

  queryTurns(filter: SummaryFilter = {}, page: KeysetPage & { offset?: number } = {}): TurnSummaryRow[] {
    const where = whereClause(filter);
    const after = nonnegative(page.afterId ?? 0, 'afterId');
    const offset = nonnegative(page.offset ?? 0, 'offset');
    return this.connection.prepare(`SELECT * FROM turn_summary WHERE ${where.sql} AND id > ? ORDER BY id LIMIT ? OFFSET ?`)
      .all(...where.values, after, pageLimit(page.limit), offset) as unknown as TurnSummaryRow[];
  }

  queryTurnsCount(filter: SummaryFilter = {}): number {
    const where = whereClause(filter);
    return (this.connection.prepare(`SELECT COUNT(*) AS count FROM turn_summary WHERE ${where.sql}`)
      .get(...where.values) as { count: number }).count;
  }

  queryUsageCount(filter: SummaryFilter = {}, groupBy: UsageGrouping = 'total', timezone = 'UTC'): number {
    if (!['total', 'project', 'session', 'day', 'month'].includes(groupBy)) throw new RangeError('Unknown usage grouping');
    const calendar = groupBy === 'day' || groupBy === 'month';
    if (calendar) calendarPeriod(0, timezone, groupBy);
    const where = whereClause(calendar && filter.unknownTime === undefined ? { ...filter, unknownTime: 'include' } : filter);
    const groups = ['provider'];
    if (groupBy === 'project' || groupBy === 'session') groups.push('project_key');
    if (groupBy === 'session') groups.push('session_id');
    if (calendar) groups.push('period');
    const prefix: SQLInputValue[] = calendar ? [timezone, groupBy] : [];
    return (this.connection.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT ${calendar ? 'agent_tracker_period(started_at_ms, ?, ?)' : 'NULL'} AS period
      FROM turn_summary WHERE ${where.sql} GROUP BY ${groups.join(', ')}
    )`).get(...prefix, ...where.values) as { count: number }).count;
  }

  queryUsage(filter: SummaryFilter = {}, groupBy: UsageGrouping = 'total', timezone = 'UTC', page: OffsetPage = {}): UsageRow[] {
    if (!['total', 'project', 'session', 'day', 'month'].includes(groupBy)) throw new RangeError('Unknown usage grouping');
    if (groupBy === 'day' || groupBy === 'month') calendarPeriod(0, timezone, groupBy);
    const calendar = groupBy === 'day' || groupBy === 'month';
    // Undated turns cannot be assigned to the requested interval. Keep them in
    // their own NULL-period group so a date filter does not silently hide them.
    const where = whereClause(calendar && filter.unknownTime === undefined ? { ...filter, unknownTime: 'include' } : filter);
    const project = groupBy === 'project' || groupBy === 'session';
    const period = calendar ? 'agent_tracker_period(started_at_ms, ?, ?)' : 'NULL';
    const groups = ['provider'];
    if (project) groups.push('project_key');
    if (groupBy === 'session') groups.push('session_id');
    if (calendar) groups.push('period');
    const prefix: SQLInputValue[] = calendar ? [timezone, groupBy] : [];
    return this.connection.prepare(`SELECT provider,
      ${project ? 'project_key' : 'NULL'} AS project_key,
      ${project ? 'MIN(project_name)' : 'NULL'} AS project_name,
      ${groupBy === 'session' ? 'session_id' : 'NULL'} AS session_id,
      ${period} AS period,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
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
      SUM(last_error IS NOT NULL) AS stale_turns,
      MAX(updated_at) AS last_successful_update
      FROM turn_summary WHERE ${where.sql}
      GROUP BY ${groups.join(', ')} ORDER BY ${groups.join(', ')} LIMIT ? OFFSET ?`)
      .all(...prefix, ...where.values, pageLimit(page.limit), nonnegative(page.offset ?? 0, 'offset')) as unknown as UsageRow[];
  }

  diagnostics(page: KeysetPage & { afterSummaryId?: number; offset?: number } = {}): DiagnosticsPage {
    const limit = pageLimit(page.limit);
    const offset = nonnegative(page.offset ?? 0, 'offset');
    const files = this.connection.prepare('SELECT * FROM manifest WHERE id > ? ORDER BY id LIMIT ? OFFSET ?')
      .all(nonnegative(page.afterId ?? 0, 'afterId'), limit, offset) as unknown as ManifestRow[];
    const summaries = this.connection.prepare(`SELECT * FROM turn_summary WHERE id > ? AND
      (last_error IS NOT NULL OR (quality_flags IS NOT NULL AND quality_flags <> '[]' AND quality_flags <> ''))
      ORDER BY id LIMIT ? OFFSET ?`)
      .all(nonnegative(page.afterSummaryId ?? 0, 'afterSummaryId'), limit, offset) as unknown as TurnSummaryRow[];
    const counts = this.connection.prepare(`SELECT COUNT(*) AS files,
      COALESCE(SUM(processing_status = 'processing'), 0) AS processing,
      COALESCE(SUM(processing_status = 'done'), 0) AS done,
      COALESCE(SUM(processing_status = 'error'), 0) AS error,
      COALESCE(SUM(processing_status = 'interrupted'), 0) AS interrupted,
      (SELECT COUNT(*) FROM turn_summary WHERE last_error IS NOT NULL) AS stale_summaries
      FROM manifest`).get() as unknown as DiagnosticsPage['counts'];
    return {
      files, summaries, counts,
      nextFileId: files.length === limit ? files[files.length - 1].id : null,
      nextSummaryId: summaries.length === limit ? summaries[summaries.length - 1].id : null,
    };
  }
}
