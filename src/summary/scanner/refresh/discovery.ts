// JSONL 수정 시각으로 읽을 파일을 고르고 원본 소실과 관계 해소에 필요한 파일을 등록한다.
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SummaryDatabase } from '../../db';
import { SummaryError } from '../../jsonl';
import type { RefreshContext } from './context';
import { needsSourceRead, PARSER_VERSION, sessionKey, type FileState, type StoredSource } from './state';

interface SourcePath {
  previous?: StoredSource;
  observed?: FileState;
}

interface DiscoveryPaths {
  byPath: Map<string, SourcePath>;
  storedRoots: Set<string>;
  nextId: number;
}

type Observation = Pick<FileState, 'provider' | 'source_root' | 'path' | 'size_bytes' | 'mtime_ms'>;

/** 선택한 루트에서 로그를 찾아 재파싱·재사용·소실 처리에 필요한 원본 상태를 등록한다. */
export async function discoverSources(context: RefreshContext): Promise<void> {
  // [탐색 정책] 저장된 경로와 실제 로그를 대조하며 이전 기록이 없는 루트의 ENOENT만 허용한다.
  const { database, roots, check } = context;
  const paths = loadStoredPaths(database);
  for (const root of roots) {
    try {
      await walk(root.path, check, root.provider === 'codex', async path => {
        const stat = await lstat(path);
        if (!stat.isFile()) return;
        recordObservation(context, paths, { provider: root.provider, source_root: root.path, path,
          size_bytes: stat.size, mtime_ms: stat.mtimeMs });
      });
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || paths.storedRoots.has(sessionKey(root.provider, root.path)))
        throw error;
    }
  }
  registerUnseenSources(context, paths.byPath.values());
}

/** DB에 저장된 원본 경로와 루트 목록을 불러와 탐색에 사용할 색인을 만든다. */
function loadStoredPaths(database: SummaryDatabase): DiscoveryPaths {
  // [색인 정책] 제공자·경로로 저장 행을 찾고 최대 ID 다음부터 새 파일에 배정한다.
  const paths: DiscoveryPaths = { byPath: new Map(), storedRoots: new Set(), nextId: 1 };
  const stored = database.connection.prepare(`SELECT id, provider, source_root, path, session_id,
    mtime_ms, parser_version, capabilities_collected, source_missing, processing_status FROM source_file ORDER BY id`).iterate() as unknown as Iterable<StoredSource>;
  for (const previous of stored) {
    paths.byPath.set(sessionKey(previous.provider, previous.path), { previous });
    paths.storedRoots.add(sessionKey(previous.provider, previous.source_root));
    paths.nextId = Math.max(paths.nextId, previous.id + 1);
  }
  return paths;
}

/** 발견한 파일의 메타데이터를 기록하고 재파싱 여부와 진행 집계를 갱신한다. */
function recordObservation(context: RefreshContext, paths: DiscoveryPaths, observation: Observation): void {
  // [탐색 정책] 최초 관측에는 기존 파일 ID를 재사용하고 겹치는 루트는 마지막 관측의 메타데이터로 합친다.
  const { state, result, report } = context;
  const { provider, path } = observation;
  const key = sessionKey(provider, path);
  const entry = paths.byPath.get(key) ?? {};
  const { observed, previous } = entry;
  const changed = needsSourceRead(observation, previous, context.collect);
  if (observed) {
    result.reused += Number(observed.changed) - Number(changed);
    Object.assign(observed, observation);
    observed.changed = changed;
  } else {
    const file: FileState = { ...observation, changed, id: previous?.id ?? paths.nextId++, previous,
      session_id: previous?.session_id ?? null, selected: true, removed: false, parser_version: PARSER_VERSION };
    entry.observed = file;
    paths.byPath.set(key, entry);
    state.trackFile(file);
    if (!changed) result.reused++;
  }
  if (changed) state.indexRelatedSources();
  result.discovered++;
  report();
}

/** 이번에 보지 못한 저장 원본을 소실 파일이나 선택 범위 밖 파일로 등록한다. */
function registerUnseenSources(context: RefreshContext, stored: Iterable<SourcePath>): void {
  // [소실 처리 정책] 선택 루트 안의 미관측 파일은 소실로 분류하고 보존 여부에 따라 다시 집계한다.
  const { state, roots, retain } = context;
  const selectedRoots = new Set(roots.map(root => sessionKey(root.provider, root.path)));
  for (const { previous, observed } of stored) {
    if (observed || !previous) continue;
    const selected = selectedRoots.has(sessionKey(previous.provider, previous.source_root));
    const changed = selected && (!previous.source_missing || !retain);
    // [재수집 정책] 선택 범위 밖에서 필요해진 파일은 실제로 읽기 직전에 크기를 확인한다.
    const file: FileState = { ...previous, size_bytes: 0, previous, changed,
      removed: selected, selected };
    state.trackFile(file);
    if (changed && file.session_id) {
      state.indexRelatedSources();
      state.affect(file.provider, file.session_id);
    }
  }
}

/** 하위 디렉터리를 재귀 순회하며 지원하는 로그 파일 경로를 전달한다. */
async function walk(directory: string, check: () => void, compressed: boolean,
  visit: (path: string) => Promise<void>): Promise<void> {
  // [탐색 정책] 디렉터리를 순회하며 취소를 확인하고 Zstd 확장자는 Codex 루트에서만 포함한다.
  check();
  const stat = await lstat(directory);
  if (!stat.isDirectory())
    throw new SummaryError('source-root-not-directory');
  const handle = await opendir(directory, { bufferSize: 32 });
  try {
    for (let entry = await handle.read(); entry; entry = await handle.read()) {
      check();
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), check, compressed, visit);
      } else if (entry.isFile()) {
        const name = entry.name.toLowerCase();
        if (name.endsWith('.jsonl') || compressed && name.endsWith('.jsonl.zst'))
          await visit(join(directory, entry.name));
      }
    }
  } finally {
    await handle.close();
  }
}
