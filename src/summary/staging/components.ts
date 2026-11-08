// 저장 단위인 양방향 세션 연결 성분을 SQL에서 선택·정리한다.
import type { DatabaseSync } from 'node:sqlite';
import type { Provider } from '../types';

export const CONNECTED_SESSIONS = `WITH RECURSIVE connected(session_id) AS (
  SELECT ? UNION SELECT CASE WHEN links.a=connected.session_id THEN links.b ELSE links.a END
  FROM links JOIN connected ON links.a=connected.session_id OR links.b=connected.session_id WHERE links.provider=?
)`;

/** 함께 저장할 첫 영향 세션의 양방향 연결 성분을 선택한다. */
export function nextComponent(connection: DatabaseSync): boolean {
  connection.exec('DELETE FROM component');
  const first = connection.prepare('SELECT provider,session_id FROM affected ORDER BY provider,session_id LIMIT 1').get() as { provider: string; session_id: string } | undefined;
  if (!first) return false;
  connection.prepare(`${CONNECTED_SESSIONS} INSERT INTO component SELECT ?,session_id FROM connected`)
    .run(first.session_id, first.provider, first.provider);
  return true;
}

/** 현재 연결 성분에 실패한 원본이 있는지 확인한다. */
export function componentFailed(connection: DatabaseSync): boolean {
  return Boolean(connection.prepare(`SELECT 1 FROM scan_files f JOIN component c ON c.provider=f.provider
      AND (c.session_id=f.session_id OR c.session_id=f.old_session) WHERE f.failed=1 LIMIT 1`).get());
}

/** 현재 연결 성분의 제공자·세션 키를 순회한다. */
export function componentSessions(connection: DatabaseSync): Iterable<{ provider: Provider; session_id: string }> {
  return connection.prepare('SELECT provider,session_id FROM component').iterate() as unknown as Iterable<{ provider: Provider; session_id: string }>;
}

/** 성공한 성분의 원본을 확정 표시하고 임시 이벤트·플래그·영향 키를 제거한다. */
export function finishComponent(connection: DatabaseSync): void {
  connection.exec(`UPDATE scan_files SET settled=1 WHERE EXISTS(SELECT 1 FROM component c
        WHERE c.provider=scan_files.provider AND (c.session_id=scan_files.session_id OR c.session_id=scan_files.old_session));
      DELETE FROM events WHERE file_id IN(SELECT f.id FROM scan_files f JOIN component c
        ON c.provider=f.provider AND (c.session_id=f.session_id OR c.session_id=f.old_session));
      DELETE FROM flags WHERE file_id IN(SELECT f.id FROM scan_files f JOIN component c
        ON c.provider=f.provider AND (c.session_id=f.session_id OR c.session_id=f.old_session));
      DELETE FROM affected WHERE EXISTS(SELECT 1 FROM component c WHERE c.provider=affected.provider AND c.session_id=affected.session_id)`);
}
