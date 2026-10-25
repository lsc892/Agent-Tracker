// Codex의 별도 제목 메타데이터를 수집해 저장된 세션 이름에 반영한다.
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readJsonl } from './jsonl';
import { displayName, string } from './parsers/common';
import type { SummaryStaging } from './staging';
import type { SourceRoot } from './types';

/**
 * 책임: 원본 대화 재파싱 없이 제공자 소유의 세션 제목을 수집한다.
 * 알고리즘: Codex index를 스트리밍하고 최신 state DB를 읽기 전용으로 100행씩 조회하며, DB 제목에 더 높은 우선순위를 주어 TEMP에 병합한다.
 */
export async function readSessionNames(staging: SummaryStaging, roots: SourceRoot[], isCancelled: () => boolean): Promise<void> {
  const homes = new Set(roots.filter(root => root.provider === 'codex')
    .map(root => resolve(root.dataHome ?? dirname(root.path))));
  const insert = staging.connection.prepare(`INSERT INTO session_names VALUES ('codex',?,?,?)
    ON CONFLICT(provider,session_id) DO UPDATE SET session_name=excluded.session_name,priority=excluded.priority
    WHERE excluded.priority>=priority`);
  for (const home of homes) {
    if (isCancelled()) return;
    try {
      const path = join(home, 'session_index.jsonl');
      const stat = await lstat(path);
      if (stat.isFile() && !stat.isSymbolicLink()) await readJsonl(path, stat.size, row => {
        const id = string(row.id), name = displayName(row.thread_name);
        if (id && name) insert.run(id, name, 1);
      }, { isCancelled, processBatch: rows => staging.batchEvents(rows) });
    } catch { /* Optional title metadata cannot invalidate transcript statistics. */ }
    if (isCancelled()) return;
    let source: DatabaseSync | undefined;
    try {
      const files = (await readdir(home)).filter(name => /^state_\d+\.sqlite$/.test(name))
        .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
      if (!files.length) continue;
      const path = join(home, files[0]);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      source = new DatabaseSync(path, { readOnly: true });
      source.exec('PRAGMA busy_timeout=250; PRAGMA query_only=ON; PRAGMA cache_size=-512; PRAGMA mmap_size=0;');
      const columns = source.prepare('PRAGMA table_info(threads)').all().map(row => row.name);
      if (!columns.includes('id') || !columns.includes('title')) continue;
      const title = columns.includes('name') ? "coalesce(nullif(trim(name),''),title)" : 'title';
      let after = '';
      while (!isCancelled()) {
        const rows = source.prepare(`SELECT id,${title} AS title FROM threads WHERE id>? ORDER BY id LIMIT 100`).all(after);
        if (!rows.length) break;
        staging.batchEvents(() => {
          for (const row of rows) {
            after = String(row.id);
            const name = displayName(row.title);
            if (name) insert.run(after, name, 2);
          }
        });
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } catch { /* A missing or incompatible provider DB leaves index/log titles available. */ }
    finally { source?.close(); }
  }
}

/**
 * 책임: 토큰 변경과 독립적으로 저장된 세션 제목을 최신화한다.
 * 알고리즘: TEMP의 제공자·세션 ID와 연결해 제목이 다른 sessions 행만 UPDATE한다.
 */
export function applySessionNames(connection: DatabaseSync): void {
  connection.exec(`UPDATE sessions SET session_name=(SELECT n.session_name FROM session_names n
    WHERE n.provider=sessions.provider AND n.session_id=sessions.session_id)
    WHERE EXISTS(SELECT 1 FROM session_names n WHERE n.provider=sessions.provider AND n.session_id=sessions.session_id
      AND n.session_name IS NOT sessions.session_name)`);
}
