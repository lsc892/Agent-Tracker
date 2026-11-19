// 디렉터리를 탐색하고 source_file와 비교하여 관측·변경·소실 파일을 등록한다.
import { lstat, opendir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FileMetadata, SourceFileRow } from '../../db/types';
import { SummaryError } from '../../jsonl';
import type { RefreshContext } from './context';
import { PARSER_VERSION, sessionKey } from './state';
import type { FileState } from './state';

export async function discoverSources(context: RefreshContext): Promise<void> {
  const { database, state, roots, collect, retain, result, check, report } = context;
  const source_file = database.connection.prepare('SELECT * FROM source_file ORDER BY id').all() as unknown as SourceFileRow[];
  const paths = new Map(source_file.map(file => [sessionKey(file.provider, file.path), file]));
  let nextId = source_file.reduce((max, file) => Math.max(max, file.id), 0) + 1;
  const observed = new Set<number>();
  for (const root of roots) {
    try {
      for await (const path of walk(root.path, check, root.provider === 'codex')) {
        const stat = await lstat(path);
        if (!stat.isFile())
          continue;
        // Deleted inodes can be reused. Cross-path matches need the parsed content proof in reconnectSources.
        const previous = paths.get(sessionKey(root.provider, resolve(path)));
        if (previous && previous.parser_version !== PARSER_VERSION)
          database.sourceCheckpoints.delete(sessionKey(root.provider, resolve(path)));
        const metadata: FileMetadata = { provider: root.provider, source_root: root.path, path: resolve(path), session_id: previous?.session_id ?? null,
          size_bytes: stat.size, mtime_ms: stat.mtimeMs, dev: String(stat.dev), inode: String(stat.ino), parser_version: PARSER_VERSION,
          capabilities_collected: collect ? 1 : 0, source_identity: previous?.source_identity, content_hash: previous?.content_hash };
        const file: FileState = { ...metadata, id: previous?.id ?? nextId++, previous, changed: true, removed: false, selected: true, session: metadata.session_id };
        state.trackFile(file);
        observed.add(file.id);
        result.discovered++;
        report();
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
        || source_file.some(file => file.provider === root.provider && file.source_root === root.path))
        throw error;
    }
  }
  for (const previous of source_file)
    if (!observed.has(previous.id)) {
      const selected = roots.some(root => root.provider === previous.provider && root.path === previous.source_root);
      const file: FileState = { ...previous, id: previous.id, previous, changed: selected && (!previous.source_missing || !retain),
        removed: selected, selected, session: previous.session_id };
      state.trackFile(file);
      if (file.changed)
        state.affect(file.provider, file.session);
    }
  for (const [key, checkpoint] of database.sourceCheckpoints)
    if (!observed.has(checkpoint.id)) database.sourceCheckpoints.delete(key);
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
    else if (entry.isFile() && (entry.name.toLowerCase().endsWith('.jsonl')
      || compressed && entry.name.toLowerCase().endsWith('.jsonl.zst')))
      yield path;
  }
}
