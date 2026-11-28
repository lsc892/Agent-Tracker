// 제공자·프로젝트·세션·날짜 조건을 SQL과 순서 있는 바인딩으로 변환한다.
import type { SQLInputValue } from 'node:sqlite';
import type { SummaryFilter } from '../../types';
import type { QuerySql } from './types';

/**
 * 책임: 행 조회와 개수 조회에 동일한 필터 의미를 제공한다.
 * 알고리즘: 허용된 열의 조건과 바인딩을 순서대로 만들고 이름 검색 문자를 escape하며 날짜를 검증해 미상 시간 포함 정책을 적용한다.
 */
export function buildQueryFilter(filter: SummaryFilter, source: 'turn_summary' | 'usage' = 'turn_summary'): QuerySql {
  // [SQL 필터 정책] 제공자 목록은 IN으로 바인딩하고 명시적으로 비어 있으면 모든 행을 제외한다.
  const clauses: string[] = [];
  const values: SQLInputValue[] = [];
  if (filter.providers) {
    const providerList = filter.providers.map(() => '?').join(',');
    clauses.push(filter.providers.length ? `provider IN (${providerList})` : '0 = 1');
    values.push(...filter.providers);
  }

  // [SQL 필터 정책] 제공자·프로젝트·세션 식별자는 정확히 일치하는 행만 남긴다.
  for (const [name, column] of [
    ['provider', 'provider'],
    ['projectKey', 'project_key'],
    ['sessionId', 'session_id'],
  ] as const) {
    if (filter[name] === undefined) continue;
    clauses.push(`${column} = ?`);
    values.push(filter[name]!);
  }

  // [SQL 필터 정책] 이름은 저장된 메타데이터에서 부분 검색하고 와일드카드를 리터럴로 이스케이프한다.
  for (const [name, table, condition, column] of [
    ['projectName', 'projects', `projects.project_key = ${source}.project_key`, 'project_name'],
    ['sessionName', 'sessions', `sessions.provider = ${source}.provider AND sessions.session_id = ${source}.session_id`, 'session_name'],
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
  // [기간 정책] 경계를 안전한 밀리초 정수로 검증하고 시작은 포함, 끝은 제외하는 범위를 만든다.
  const time: string[] = [];
  const timeValues: SQLInputValue[] = [];
  for (const [name, operator] of [['fromMs', '>='], ['toMs', '<']] as const) {
    if (filter[name] === undefined) continue;
    if (!Number.isSafeInteger(filter[name])) throw new RangeError(`${name} must be an epoch millisecond integer`);
    time.push(`started_at_ms ${operator} ?`);
    timeValues.push(filter[name]!);
  }

  // [기간 정책] 시간 미상만 선택하면 날짜 범위를 건너뛰고, 포함 옵션은 범위에 NULL을 더한다.
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
