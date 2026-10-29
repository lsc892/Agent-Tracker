// 날짜·표 페이지와 독립적인 프로젝트·세션 이름 선택 SQL을 만든다.
import type { NameQuery } from '../../../types';
import { buildQueryFilter } from '../common/filters';
import type { QuerySql } from '../common/types';

/**
 * 책임: 현재 표 페이지나 날짜와 독립적인 이름 선택 목록을 만든다.
 * 알고리즘: 제공자·프로젝트 범위의 저장 요청에서 ID로 그룹화하고 이름·고정 키로 정렬한 행과 전체 개수 SQL을 함께 생성한다.
 */
export function buildNameQueries(query: NameQuery): { count: QuerySql; rows: QuerySql } {
  if (!['project', 'session'].includes(query.kind)) throw new RangeError('Unknown name kind');
  const session = query.kind === 'session';
  const where = buildQueryFilter({
    provider: query.provider,
    providers: query.providers,
    projectKey: session ? query.projectKey : undefined,
  });
  const groups = session ? 'provider, project_key, session_id' : 'project_key';
  const provider = session ? 'provider' : 'NULL';
  const sessionId = session ? 'session_id' : 'NULL';
  const sessionName = session ? `(
        SELECT session_name
        FROM sessions s
        WHERE s.provider = turn_summary.provider AND s.session_id = turn_summary.session_id
      )` : 'NULL';
  const sessionStartedAt = session ? 'MIN(started_at_ms)' : 'NULL';
  const sessionNameOrder = session ? "COALESCE(session_name, '이름 없는 세션') COLLATE NOCASE, provider," : '';
  const sessionIdOrder = session ? ', session_started_at_ms, session_id' : '';
  return {
    count: {
      sql: `SELECT COUNT(*) AS count
      FROM (
        SELECT 1
        FROM turn_summary
        WHERE ${where.sql}
        GROUP BY ${groups}
      )`,
      values: where.values,
    },
    rows: {
      sql: `SELECT
        project_key,
        (
          SELECT project_name
          FROM projects p
          WHERE p.project_key = turn_summary.project_key
        ) AS project_name,
        ${provider} AS provider,
        ${sessionId} AS session_id,
        ${sessionName} AS session_name,
        ${sessionStartedAt} AS session_started_at_ms
      FROM turn_summary
      WHERE ${where.sql}
      GROUP BY ${groups}
      ORDER BY ${sessionNameOrder}
        project_name COLLATE NOCASE, project_key${sessionIdOrder}
      LIMIT ?
      OFFSET ?`,
      values: where.values,
    },
  };
}
