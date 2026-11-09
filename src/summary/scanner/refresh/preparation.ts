// Worker의 파일 준비 결과를 기존 순서로 반영하고 부분 파일·원본 소실을 처리한다.
import { lstat } from 'node:fs/promises';
import { SourceWinners } from '../../aggregation/sourceWinners';
import { SummaryError } from '../../jsonl';
import type { RefreshContext } from './context';
import type { FileState } from './state';

export async function prepareChanged(context: RefreshContext): Promise<void> {
  const changed = [...context.state.files.values()].filter(file => file.changed && !file.removed).sort((a, b) => a.id - b.id);
  await inspectBatch(context, changed);
}

export async function inspectBatch(context: RefreshContext, batch: readonly FileState[]): Promise<void> {
  const { state, sourcePool } = context;
  for (let index = 0; index < batch.length; index++) {
    const candidates = batch.slice(index, index + sourcePool.lookahead).filter(file => file.selected && state.ready(file));
    sourcePool.prefetch(candidates);
    await inspectSource(context, batch[index]);
  }
}

export async function inspectSource(context: RefreshContext, file: FileState): Promise<void> {
  const { state, result, scan, sourcePool, check, report, cancelled } = context;
  check();
  if (file.attempted || file.prepared || file.error || file.removed)
    return;
  file.attempted = true;
  file.sequence = ++state.sequence;
  if (!file.changed && file.selected)
    result.reused = Math.max(0, result.reused - 1);
  if (!file.selected && !await refreshOutsideSource(context, file))
    return;
  try {
    const preparation = await scan.measureAsync('readSources', () => sourcePool.read(file));
    report();
    if (!preparation.ok) {
      if (preparation.identity) {
        state.setSession(file, preparation.identity.sessionId);
        state.connect(file.provider, file.previous?.session_id, file.session);
      }
      throw new SummaryError(preparation.error.code, preparation.error.offset);
    }
    check();
    const read = preparation.read, winners = new SourceWinners(file.provider, preparation.winners), evidence = winners.evidence;
    result.parsed++;
    if (!read.rows) {
      if (read.partialLine && file.previous?.session_id) {
        file.deferred = true;
        return;
      }
      file.content_hash = null;
      state.setSourceIdentity(file, null);
      state.setSession(file, file.previous?.session_id ?? null);
      return;
    }
    state.setSession(file, read.identity!.sessionId);
    file.prepared = { identity: read.identity!, evidence, winners, partialLine: read.partialLine, sourceIdentity: read.sourceIdentity!, contentHash: read.contentHash };
    state.setSourceIdentity(file, read.sourceIdentity);
    file.content_hash = read.contentHash;
    state.registerPrepared(file);
    state.affect(file.provider, file.session);
    state.connect(file.provider, file.previous?.session_id, file.session);
  }
  catch (error) {
    state.fail(file, error);
    if (cancelled())
      throw error;
  }
}

async function refreshOutsideSource(context: RefreshContext, file: FileState): Promise<boolean> {
  const { state, retain } = context;
  try {
    const stat = await lstat(file.path);
    file.size_bytes = stat.size;
    file.mtime_ms = stat.mtimeMs;
    file.dev = String(stat.dev);
    file.inode = String(stat.ino);
    return true;
  }
  catch (error) {
    const replacement = [...state.identityFiles.get(JSON.stringify([file.provider, file.source_identity])) ?? []]
      .some(candidate => candidate.prepared && !candidate.error && !candidate.removed);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (replacement || retain && file.previous?.source_missing)) {
      file.removed = true;
      file.changed = true;
      state.affect(file.provider, file.session);
      return false;
    }
    state.fail(file, new SummaryError('source-unavailable-outside-scan'));
    return false;
  }
}
