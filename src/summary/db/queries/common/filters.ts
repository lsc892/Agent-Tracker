// 제공자·프로젝트·세션·날짜 조건을 SQL과 순서 있는 바인딩으로 변환한다.
import type { SQLInputValue } from 'node:sqlite';
import type { SummaryFilter } from '../../types';
import type { QuerySql } from './types';

/**
 * 책임: 행 조회와 개수 조회에 동일한 필터 의미를 제공한다.
 * 알고리즘: 허용된 열의 조건과 바인딩을 순서대로 만들고 이름 검색 문자를 escape하며 날짜를 검증해 미상 시간 포함 정책을 적용한다.
 */
export function buildQueryFilter(filter: SummaryFilter): QuerySql {
  const clauses: string[] = [];
  const values: SQLInputValue[] = [];
  if (filter.providers) {
    const providerList = filter.providers.map(() => '?').join(',');
    clauses.push(filter.providers.length ? `provider IN (${providerList})` : '0 = 1');
    values.push(...filter.providers);
  }
  for (const [name, column] of [
    ['provider', 'provider'],
    ['projectKey', 'project_key'],
    ['sessionId', 'session_id'],
  ] as const) {
    if (filter[name] === undefined) continue;
    clauses.push(`${column} = ?`);
    values.push(filter[name]!);
  }
  for (const [name, table, condition, column] of [
    ['projectName', 'projects', 'projects.project_key = turn_summary.project_key', 'project_name'],
    ['sessionName', 'sessions', 'sessions.provider = turn_summary.provider AND sessions.session_id = turn_summary.session_id', 'session_name'],
  ] as const) {
    if (!filter[name]) continue;
    clauses.push(`EXISTS(
      SELECT 1
      FROM ${table}
      WHERE ${condition} AND ${column} LIKE ? ESCAPE '\\'
    )`);
    const escapedName = filter[name]!.replace(/[\\%_]/g, character => `\\${character}`);
    values.push(`%${escapedName}%`);
  }
  appendTimeFilter(filter, clauses, values);
  return { sql: clauses.length ? clauses.join(' AND ') : '1 = 1', values };
}

function appendTimeFilter(filter: SummaryFilter, clauses: string[], values: SQLInputValue[]): void {
  const time: string[] = [];
  const timeValues: SQLInputValue[] = [];
  for (const [name, operator] of [['fromMs', '>='], ['toMs', '<']] as const) {
    if (filter[name] === undefined) continue;
    if (!Number.isSafeInteger(filter[name])) throw new RangeError(`${name} must be an epoch millisecond integer`);
    time.push(`started_at_ms ${operator} ?`);
    timeValues.push(filter[name]!);
  }
  if (filter.unknownTime === 'only') {
    clauses.push('started_at_ms IS NULL');
    return;
  }
  if (time.length) {
    const interval = time.join(' AND ');
    clauses.push(filter.unknownTime === 'include' ? `((${interval}) OR started_at_ms IS NULL)` : `(${interval})`);
    values.push(...timeValues);
    return;
  }
  if (filter.unknownTime === 'exclude') clauses.push('started_at_ms IS NOT NULL');
}
