// 최근 일별 합계와 미리보기 갱신에 필요한 원본 정보를 메모리 DB에 복사한다.
import type { DatabaseSync } from 'node:sqlite';
import type { SummaryDatabase } from './index';
import { ROLLUP_TABLES } from './rollup-state';
import { calendarPeriod } from './timezone';

export interface RecentWindow { fromMs: number; toMs: number }

export function copyRecentUsage(source: DatabaseSync, target: SummaryDatabase, { fromMs, toMs }: RecentWindow, timezone: string): void {
  // [시간대 정책] 끝 시각을 제외한 밀리초 범위를 현지 날짜의 양끝을 포함하는 범위로 바꾼다.
  const bounds = [calendarPeriod(fromMs, timezone, 'day'), calendarPeriod(toMs - 1, timezone, 'day')];
  const where = 'WHERE local_day BETWEEN ? AND ?';
  const recent = `SELECT * FROM ${ROLLUP_TABLES.provider} ${where}`;
  const snapshot = target.connection;
  // [SQL 트랜잭션 정책] 원본·이름과 결제에 필요한 세션을 먼저 복사한 뒤 범위 내 일별 행을 함께 확정한다.
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
  // [DTO 정책] 스키마 버전마다 물리적 순서가 다를 수 있어 대상 DB의 열 이름으로 값을 맞춘다.
  const columns = target.prepare(`PRAGMA table_info(${table})`).all().map(column => String(column.name));
  const insert = target.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
  for (const row of select.iterate(...params)) insert.run(...columns.map(column => row[column]));
}
