// 영속 DB의 최근 요청과 교체에 필요한 참조 행을 메모리 DB에 복사한다.
import type { DatabaseSync } from 'node:sqlite';
import type { SummaryDatabase } from './index';

export interface RecentWindow { fromMs: number; toMs: number }

const recent = 'SELECT * FROM turn_summary WHERE started_at_ms >= ? AND started_at_ms < ?';

export function copyRecentUsage(source: DatabaseSync, target: SummaryDatabase, { fromMs, toMs }: RecentWindow): void {
  const bounds = [fromMs, toMs];
  target.transaction(() => {
    copyRows(source, target.connection, 'source_file', 'SELECT * FROM source_file');
    copyRows(source, target.connection, 'projects',
      `SELECT * FROM projects WHERE project_key IN (SELECT project_key FROM (${recent}))`, bounds);
    copyRows(source, target.connection, 'sessions', `SELECT * FROM sessions WHERE (provider, session_id) IN (
      SELECT provider, session_id FROM (${recent}) UNION SELECT provider, session_id FROM session_billing)`, bounds);
    copyRows(source, target.connection, 'session_billing', 'SELECT * FROM session_billing');
    copyRows(source, target.connection, 'turn_summary', recent, bounds);
    for (const table of ['turn_model_usage', 'turn_costs']) {
      copyRows(source, target.connection, table,
        `SELECT child.* FROM (${recent}) AS turn CROSS JOIN ${table} AS child ON child.turn_id = turn.id`, bounds);
    }
  });
}

function copyRows(source: DatabaseSync, target: DatabaseSync, table: string, sql: string, params: readonly number[] = []): void {
  const select = source.prepare(sql);
  // Migrated DBs can have a different physical column order from the memory schema.
  const output = new Set(source.prepare(`PRAGMA table_info(${table})`).all().map(column => String(column.name)));
  const columns = target.prepare(`PRAGMA table_info(${table})`).all().map(column => String(column.name))
    .filter(column => output.has(column));
  const insert = target.prepare(`INSERT INTO ${table} (${columns.map(name => `"${name.replaceAll('"', '""')}"`).join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})`);
  for (const row of select.iterate(...params)) insert.run(...columns.map(column => row[column]));
}
