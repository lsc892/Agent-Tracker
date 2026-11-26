// 제공자별 선택적 제목 metadata를 읽어 표시 이름의 우선순위를 정한다.
import { lstat, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readJsonl } from '../jsonl';
import { displayName, sqlText, string } from '../parsers/common';
import type { SourceRoot } from '../types';
const key = (provider: string, session: string): string => JSON.stringify([provider, sqlText(session)]);
const indexFields = { fields: { id: {}, thread_name: {} } };
/** 제공자 제목의 우선순위를 메모리에 병합하며 통계 DB는 여기서 쓰지 않는다. */
export async function readNames(roots: readonly SourceRoot[], cancelled: () => boolean): Promise<Map<string, string>> {
  const names = new Map<string, string>(), stateNames = new Set<string>();
  const homes = new Set(roots.filter(root => root.provider === 'codex').map(root => resolve(root.dataHome ?? dirname(root.path))));
  for (const home of homes) {
    if (cancelled())
      break;
    try {
      const path = join(home, 'session_index.jsonl'), stat = await lstat(path);
      if (stat.isFile())
        await readJsonl(path, stat.size, row => {
          const id = string(row.id), name = displayName(row.thread_name);
          if (!id || !name) return;
          const session = key('codex', id);
          if (!stateNames.has(session)) names.set(session, name);
        }, { isCancelled: cancelled, fixedShape: indexFields });
    }
    catch { /* Optional metadata does not invalidate transcript facts. */ }
    let source: DatabaseSync | undefined;
    try {
      let latestFile: string | undefined;
      let latestVersion = -1;
      for (const file of await readdir(home)) {
        const match = /^state_(\d+)\.sqlite$/.exec(file);
        if (!match) continue;
        const version = Number(match[1]);
        if (version <= latestVersion) continue;
        latestFile = file;
        latestVersion = version;
      }
      if (!latestFile) continue;
      const path = join(home, latestFile), stat = await lstat(path);
      if (!stat.isFile())
        continue;
      source = new DatabaseSync(path, { readOnly: true });
      source.exec('PRAGMA busy_timeout=250;PRAGMA query_only=ON;PRAGMA cache_size=-512;PRAGMA mmap_size=0');
      const columns = source.prepare('PRAGMA table_info(threads)').all().map(row => row.name);
      if (!columns.includes('id') || !columns.includes('title'))
        continue;
      const title = columns.includes('name') ? "coalesce(nullif(trim(name),''),title)" : 'title';
      for (const row of source.prepare(`SELECT id,${title} AS title FROM threads ORDER BY id`).iterate()) {
        if (cancelled())
          break;
        const name = displayName(row.title);
        if (name) {
          const id = key('codex', String(row.id));
          names.set(id, name);
          stateNames.add(id);
        }
      }
    }
    catch { /* Keep index/log fallback when the optional provider DB is unavailable. */ }
    finally {
      source?.close();
    }
  }
  return names;
}
