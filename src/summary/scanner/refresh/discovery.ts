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

export async function discoverSources(context: RefreshContext): Promise<void> {
  const { database, roots, check } = context;
  const paths = loadStoredPaths(database);
  for (const root of roots) {
    try {
      for await (const path of walk(root.path, check, root.provider === 'codex')) {
        const stat = await lstat(path);
        if (!stat.isFile()) continue;
        recordObservation(context, paths, { provider: root.provider, source_root: root.path, path,
          size_bytes: stat.size, mtime_ms: stat.mtimeMs });
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || paths.storedRoots.has(sessionKey(root.provider, root.path)))
        throw error;
    }
  }
  registerUnseenSources(context, paths.byPath.values());
}

function loadStoredPaths(database: SummaryDatabase): DiscoveryPaths {
  const paths: DiscoveryPaths = { byPath: new Map(), storedRoots: new Set(), nextId: 1 };
  const stored = database.connection.prepare(`SELECT id, provider, source_root, path, session_id,
    size_bytes, mtime_ms, parser_version, capabilities_collected,
    source_missing, processing_status FROM source_file ORDER BY id`).iterate() as unknown as Iterable<StoredSource>;
  for (const previous of stored) {
    paths.byPath.set(sessionKey(previous.provider, previous.path), { previous });
    paths.storedRoots.add(sessionKey(previous.provider, previous.source_root));
    paths.nextId = Math.max(paths.nextId, previous.id + 1);
  }
  return paths;
}

function recordObservation(context: RefreshContext, paths: DiscoveryPaths, observation: Observation): void {
  const { state, result, collect, report } = context;
  const { provider, path } = observation;
  const key = sessionKey(provider, path);
  const entry = paths.byPath.get(key) ?? {};
  const { observed, previous } = entry;
  const changed = needsSourceRead(observation, previous, collect);
  if (observed) {
    // Overlapping roots share one file ID and the last root supplies its metadata.
    result.reused += Number(observed.changed) - Number(changed);
    Object.assign(observed, observation);
    observed.changed = changed;
  } else {
    const file: FileState = { ...observation, changed, id: previous?.id ?? paths.nextId++, discoveryOrder: state.files.size, previous,
      session_id: previous?.session_id ?? null, selected: true, removed: false, parser_version: PARSER_VERSION,
      capabilities_collected: collect ? 1 : 0 };
    entry.observed = file;
    paths.byPath.set(key, entry);
    state.trackFile(file);
    if (!changed) result.reused++;
  }
  if (changed) state.indexRelatedSources();
  result.discovered++;
  report();
}

function registerUnseenSources(context: RefreshContext, stored: Iterable<SourcePath>): void {
  const { state, roots, retain } = context;
  const selectedRoots = new Set(roots.map(root => sessionKey(root.provider, root.path)));
  for (const { previous, observed } of stored) {
    if (observed || !previous) continue;
    const selected = selectedRoots.has(sessionKey(previous.provider, previous.source_root));
    const changed = selected && (!previous.source_missing || !retain);
    const file: FileState = { ...previous, discoveryOrder: state.files.size, previous, changed,
      removed: selected, selected };
    state.trackFile(file);
    if (changed && file.session_id) {
      state.indexRelatedSources();
      state.affect(file.provider, file.session_id);
    }
  }
}

async function* walk(directory: string, check: () => void, compressed: boolean): AsyncGenerator<string> {
  check();
  const stat = await lstat(directory);
  if (!stat.isDirectory())
    throw new SummaryError('source-root-not-directory');
  const handle = await opendir(directory, { bufferSize: 32 });
  for await (const entry of handle) {
    check();
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      yield* walk(path, check, compressed);
    else if (entry.isFile()) {
      const name = entry.name.toLowerCase();
      if (name.endsWith('.jsonl') || compressed && name.endsWith('.jsonl.zst')) yield path;
    }
  }
}
