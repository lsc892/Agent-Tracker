// 최근 일별 합계와 미리보기 갱신에 필요한 원본 정보를 메모리 DB에 복사한다.
import type { DatabaseSync } from 'node:sqlite';
import type { SummaryDatabase } from './index';
import { ROLLUP_TABLES } from './rollup-state';
import { calendarPeriod } from './timezone';

export interface RecentWindow { fromMs: number; toMs: number }

export function copyRecentUsage(source: DatabaseSync, target: SummaryDatabase, { fromMs, toMs }: RecentWindow, timezone: string): void {
  const bounds = [calendarPeriod(fromMs, timezone, 'day'), calendarPeriod(toMs - 1, timezone, 'day')];
  const where = 'WHERE local_day BETWEEN ? AND ?';
  const recent = `SELECT * FROM ${ROLLUP_TABLES.provider} ${where}`;
  const snapshot = target.connection;
  target.transaction(() => {
    copyRows(source, snapshot, 'source_file', 'SELECT * FROM source_file');
    copyRows(source, snapshot, 'projects', `SELECT * FROM projects WHERE project_key IN (SELECT project_key FROM (${recent}))`, bounds);
    copyRows(source, snapshot, 'sessions', `SELECT * FROM sessions WHERE (provider, session_id) IN (
      SELECT provider, session_id FROM (${recent}) UNION SELECT provider, session_id FROM session_billing)`, bounds);
    copyRows(source, snapshot, 'session_billing', 'SELECT * FROM session_billing');
    for (const table of [...Object.values(ROLLUP_TABLES), 'usage_capability_daily']) {
      copyRows(source, snapshot, table, `SELECT * FROM ${table} ${where}`, bounds);
    }
  });
}

function copyRows(source: DatabaseSync, target: DatabaseSync, table: string, sql: string, params: readonly string[] = []): void {
  const select = source.prepare(sql);
  // Older source_file schemas can have a different physical column order.
  const columns = target.prepare(`PRAGMA table_info(${table})`).all().map(column => String(column.name));
  const insert = target.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
  for (const row of select.iterate(...params)) insert.run(...columns.map(column => row[column]));
}
