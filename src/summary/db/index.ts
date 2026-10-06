import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION, SCHEMA_LEGACY_MIGRATION_SQL, SCHEMA_CACHE_MIGRATION_SQL } from './schema';
import { calendarPeriod } from './timezone';
import type {
  DiagnosticsPage, FileMetadata, KeysetPage, ManifestRow, OffsetPage,
  ProcessingStatus, Provider, SessionReplacement, SummaryFilter,
  TurnSummaryInput, TurnSummaryRow, UsageGrouping, UsageRow, ChartMetric, UsageChart,
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
  provider, project_key, session_id, root_turn_id, turn_index,
  started_at_ms, completed_at_ms, duration_ms, duration_quality,
  input_tokens, output_tokens, cache_write_input_tokens, cache_read_input_tokens, total_tokens, status, quality_flags,
  diagnostic_file_id, diagnostic_offset, last_error, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const NAMED_TURNS = `(SELECT t.*, p.project_name, s.session_name FROM turn_summary t
  JOIN projects p ON p.project_key=t.project_key
  JOIN sessions s ON s.provider=t.provider AND s.session_id=t.session_id)`;

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
    row.provider, row.project_key, row.session_id, row.root_turn_id, row.turn_index,
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
        insert.run(...turnValues(summary, now));
      }
      const remove = this.statement('DELETE FROM manifest WHERE id = ?');
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

  queryTurns(filter: SummaryFilter = {}, page: KeysetPage & { offset?: number } = {}): TurnSummaryRow[] {
    const where = whereClause(filter);
    const after = nonnegative(page.afterId ?? 0, 'afterId');
    const offset = nonnegative(page.offset ?? 0, 'offset');
    return this.connection.prepare(`SELECT * FROM ${NAMED_TURNS} AS turn_summary WHERE ${where.sql} AND id > ? ORDER BY id LIMIT ? OFFSET ?`)
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

  queryUsage(filter: SummaryFilter = {}, groupBy: UsageGrouping = 'total', timezone = 'UTC', page: OffsetPage & { sortBy?: ChartMetric } = {}): UsageRow[] {
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
    const metricColumns = { tokens: 'total_tokens', requests: 'turn_count', averageTokens: 'avg_tokens_per_turn', averageDuration: 'avg_duration_ms' };
    const order = page.sortBy ? `${metricColumns[page.sortBy]} DESC, ${groups.join(', ')}` : groups.join(', ');
    return this.connection.prepare(`SELECT provider,
      ${project ? 'project_key' : 'NULL'} AS project_key,
      ${project ? '(SELECT project_name FROM projects p WHERE p.project_key=turn_summary.project_key)' : 'NULL'} AS project_name,
      ${groupBy === 'session' ? 'session_id' : 'NULL'} AS session_id,
      ${groupBy === 'session' ? '(SELECT session_name FROM sessions s WHERE s.provider=turn_summary.provider AND s.session_id=turn_summary.session_id)' : 'NULL'} AS session_name,
      ${groupBy === 'session' ? '(SELECT MIN(t.started_at_ms) FROM turn_summary t WHERE t.provider=turn_summary.provider AND t.session_id=turn_summary.session_id)' : 'NULL'} AS session_started_at_ms,
      ${period} AS period,
      ${USAGE_SUMS}
      FROM turn_summary WHERE ${where.sql}
      GROUP BY ${groups.join(', ')} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...prefix, ...where.values, pageLimit(page.limit), nonnegative(page.offset ?? 0, 'offset')) as unknown as UsageRow[];
  }

  /** Bounded chart data is computed from the entire filter, independently of table pagination. */
  queryUsageChart(filter: SummaryFilter, groupBy: UsageGrouping | 'all' | 'turn', timezone: string, metric: ChartMetric): UsageChart {
    if (!['tokens', 'requests', 'averageTokens', 'averageDuration'].includes(metric)) throw new RangeError('Unknown chart metric');
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
