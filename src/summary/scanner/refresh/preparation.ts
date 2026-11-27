// Worker의 파일 준비 결과를 기존 순서로 반영하고 부분 파일·원본 소실을 처리한다.
import { lstat } from 'node:fs/promises';
import { SummaryError } from '../../jsonl';
import type { SourcePreparation } from '../sourcePreparation';
import type { RefreshContext } from './context';
import { needsSourceRead, PARSER_VERSION, type FileState, type ScanState } from './state';

export async function prepareChanged(context: RefreshContext): Promise<void> {
  // [큐 정책] 변경되었고 소실되지 않은 파일을 ID 순서로 준비한다.
  const changed = [...context.state.files.values()].filter(file => file.changed && !file.removed).sort((a, b) => a.id - b.id);
  await inspectBatch(context, changed);
}

export async function inspectBatch(context: RefreshContext, batch: readonly FileState[]): Promise<void> {
  // [병렬 처리 정책] 준비는 제한된 구간에서 앞서 진행해도 파일 결과는 입력 순서로 적용한다.
  const { state, sourcePool } = context;
  for (let index = 0; index < batch.length; index++) {
    const candidates = batch.slice(index, index + sourcePool.lookahead).filter(file => file.selected && state.ready(file));
    sourcePool.prefetch(candidates);
    await inspectSource(context, batch[index]);
  }
}

export async function inspectSource(context: RefreshContext, file: FileState): Promise<void> {
  const { state, result, scan, sourcePool, report, cancelled } = context;
  // [재수집 정책] 이미 시도한 파일을 건너뛰고 선택 범위 밖 파일은 관측값을 다시 얻어 읽는다.
  context.check();
  if (!state.ready(file)) return;
  file.attempted = true;
  if (!file.selected && !await refreshOutsideSource(context, file))
    return;
  // [진행 정책] 재사용 예정 파일을 실제로 읽으면 재사용 건수를 조정한다.
  try {
    if (!file.changed && file.selected)
      result.reused = Math.max(0, result.reused - 1);
    const preparation = await scan.measureAsync('readSources', () => sourcePool.read(file));
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
  const { state, result, check } = context;
  const previousSession = file.previous?.session_id;
  // [진단 정책] 읽기에 실패해도 세션 식별자가 있으면 이전 귀속과 연결한 뒤 원본 오류를 전달한다.
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
  file.parser_version = PARSER_VERSION;
  if (!read.identity) {
    applyEmptySource(state, file, read.partialLine);
    return;
  }
  const { identity } = read;
  state.setSession(file, identity.sessionId);
  file.relations = { identity: { threadId: identity.threadId }, threadUsage: true };
  state.registerPrepared(file, { identity, winners, partialLine: read.partialLine });
  file.changed ||= needsSourceRead(file, file.previous);
  if (!file.changed) return;
  state.affect(file.provider, file.session_id);
  state.connect(file.provider, previousSession, file.session_id);
}

function applyEmptySource(state: ScanState, file: FileState, partialLine: boolean): void {
  // [저장 정책] 이전 세션이 있고 미완성 행만 남았으면 교체를 보류한다.
  const previousSession = file.previous?.session_id;
  state.affect(file.provider, previousSession);
  if (partialLine && previousSession) {
    file.deferred = true;
    return;
  }
  file.relations = null;
  state.setSession(file, previousSession ?? null);
}

async function refreshOutsideSource(context: RefreshContext, file: FileState): Promise<boolean> {
  const { state, retain } = context;
  try {
    const stat = await lstat(file.path);
    file.size_bytes = stat.size;
    file.mtime_ms = stat.mtimeMs;
    return true;
  }
  catch (error) {
    // [소실 처리 정책] 보존 중인 원본의 경로가 여전히 없으면 소실로 등록하고 다른 읽기 실패는 진단으로 남긴다.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && retain && file.previous?.source_missing) {
      file.removed = true;
      file.changed = true;
      state.affect(file.provider, file.session_id);
      return false;
    }
    state.fail(file, new SummaryError('source-unavailable-outside-scan'));
    return false;
  }
}
