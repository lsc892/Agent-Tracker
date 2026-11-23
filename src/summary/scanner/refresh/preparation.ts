// Worker의 파일 준비 결과를 기존 순서로 반영하고 부분 파일·원본 소실을 처리한다.
import { lstat } from 'node:fs/promises';
import { SummaryError } from '../../jsonl';
import type { SourcePreparation } from '../sourcePreparation';
import type { RefreshContext } from './context';
import { PARSER_VERSION, type FileState, type ScanState } from './state';

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
  const { state, result, scan, sourcePool, report, cancelled } = context;
  context.check();
  if (!state.ready(file)) return;
  file.attempted = true;
  if (!file.selected && !await refreshOutsideSource(context, file))
    return;
  try {
    if (!file.changed && file.selected)
      result.reused = Math.max(0, result.reused - 1);
    const preparation = await scan.measureAsync('readSources', () => sourcePool.read(file, file.selected));
    report();
    applyPreparation(context, file, preparation);
  }
  catch (error) {
    state.fail(file, error);
    if (cancelled())
      throw error;
  }
}

function applyPreparation(context: RefreshContext, file: FileState, preparation: SourcePreparation): void {
  const { state, result, check, collect } = context;
  const previousSession = file.previous?.session_id;
  if (!preparation.ok) {
    if (preparation.identity) {
      state.setSession(file, preparation.identity.sessionId);
      state.connect(file.provider, previousSession, file.session_id);
    }
    throw new SummaryError(preparation.error.code, preparation.error.offset);
  }
  check();
  result.parsed++;
  const { read, winners } = preparation;
  if (!read.rows) {
    applyEmptySource(state, file, read.partialLine);
    return;
  }
  const identity = read.identity!;
  file.parser_version = PARSER_VERSION;
  file.capabilities_collected = collect ? 1 : 0;
  state.setSession(file, identity.sessionId);
  state.setSourceIdentity(file, read.sourceIdentity);
  file.relations = { identity, childRequests: winners.evidence.childRequests };
  file.content_hash = read.contentHash;
  state.registerPrepared(file, { identity, winners, partialLine: read.partialLine });
  file.changed = needsReplacement(file, collect);
  if (!file.changed) return;
  state.affect(file.provider, file.session_id);
  state.connect(file.provider, previousSession, file.session_id);
}

function applyEmptySource(state: ScanState, file: FileState, partialLine: boolean): void {
  const previousSession = file.previous?.session_id;
  state.affect(file.provider, previousSession);
  if (partialLine && previousSession) {
    file.deferred = true;
    return;
  }
  file.content_hash = null;
  file.relations = null;
  state.setSourceIdentity(file, null);
  state.setSession(file, previousSession ?? null);
}

function needsReplacement(file: FileState, collect: boolean): boolean {
  const previous = file.previous;
  return !previous || previous.source_missing === 1 || previous.processing_status !== 'done'
    || previous.content_hash !== file.content_hash || previous.source_root !== file.source_root
    || previous.parser_version !== file.parser_version || collect && previous.capabilities_collected !== 1;
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT'
      && (retain && file.previous?.source_missing || hasPreparedReplacement(state, file))) {
      file.removed = true;
      file.changed = true;
      state.affect(file.provider, file.session_id);
      return false;
    }
    state.fail(file, new SummaryError('source-unavailable-outside-scan'));
    return false;
  }
}

function hasPreparedReplacement(state: ScanState, file: FileState): boolean {
  for (const candidate of state.matchingSources(file))
    if (candidate.prepared && !candidate.error && !candidate.removed) return true;
  return false;
}
