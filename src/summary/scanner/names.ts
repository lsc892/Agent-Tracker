// Codex의 제목 메타데이터에서 세션 표시 이름을 고른다.
import { lstat, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readJsonl } from '../jsonl';
import { displayName, sqlText, string } from '../parsers/common';
import type { SourceRoot } from '../types';

/** 제공자와 SQLite 저장 형식으로 정규화한 세션 ID를 하나의 조회 키로 묶는다. */
const key = (provider: string, session: string): string => JSON.stringify([provider, sqlText(session)]);
const indexFields = { fields: { id: {}, thread_name: {} } };

/** Codex 세션 인덱스와 상태 DB에서 표시 이름을 읽어 우선순위대로 병합한다. */
export async function readNames(roots: readonly SourceRoot[], cancelled: () => boolean): Promise<Map<string, string>> {
  // [이름 정책] 중복 Codex 데이터 홈을 합치고 session_index 이름을 낮은 우선순위로 수집한다.
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
    catch { /* 세션 인덱스를 읽지 못해도 상태 DB의 이름을 확인한다. */ }
    // [이름 정책] 가장 높은 버전의 상태 DB를 읽고 name이 있으면 title보다 우선한다.
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
      // [이름 정책] 상태 DB의 이름을 인덱스 이름보다 우선하고 다음 홈의 인덱스에서도 보존한다.
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
    catch { /* 상태 DB를 읽지 못하면 세션 인덱스나 로그의 이름을 사용한다. */ }
    finally {
      source?.close();
    }
  }
  return names;
}
