// 연결 묶음의 통계·원본 수정 시각을 저장하고 진단과 이름을 마무리한다.
import { setImmediate as yieldToWorker } from 'node:timers/promises';
import type { MemoryReplacement } from '../../db/memoryStore';
import type { FileMetadata, Provider, TurnSummaryInput } from '../../db/types';
import { SummaryError } from '../../jsonl';
import { OrderedGroups } from '../worklist';
import type { RefreshContext } from './context';
import { sessionKey, type FileState } from './state';

const MAX_COMMIT_BATCH_COMPONENTS = 16;
const MAX_COMMIT_BATCH_SUMMARIES = 1000;

interface ComponentCommit {
  component: Set<string>;
  members: FileState[];
  summaries: TurnSummaryInput[];
}

export async function commitComponents(context: RefreshContext, summaries: readonly TurnSummaryInput[]): Promise<void> {
  const { files, affected, links } = context.state;
  if (!affected.size) return;

  // [SQL 트랜잭션 정책] 이전·현재 세션 키를 모두 색인해 이동한 원본도 양쪽 세션과 같은 트랜잭션에서 처리한다.
  const memberGroups = new OrderedGroups(files.values(), file => [sessionKey(file.provider, file.session_id ?? ''),
    sessionKey(file.provider, file.previous?.session_id ?? '')]);
  const summaryGroups = new OrderedGroups(summaries, row => [sessionKey(row.provider, row.session_id)]);
  const remaining = new Set([...affected].sort());
  let batch: ComponentCommit[] = [];
  let batchSummaries = 0;
  const flush = async (): Promise<void> => {
    if (!batch.length) return;
    await commitBatch(context, batch);
    batch = [];
    batchSummaries = 0;
  };

  // [SQL 트랜잭션 정책] 연결된 세션은 분리하지 않고 정상 묶음을 최대 16개·요약 1,000건씩 배치로 저장한다.
  for (const seed of remaining) {
    const component = linkedComponent(seed, links);
    for (const session of component) remaining.delete(session);
    const entry = { component, members: memberGroups.members(component), summaries: summaryGroups.members(component) };
    if (requiresIndividualCommit(entry)) {
      await flush();
      await commitIndividual(context, entry);
      continue;
    }
    const count = entry.summaries.length;
    if (batchSummaries + count > MAX_COMMIT_BATCH_SUMMARIES) await flush();
    batch.push(entry);
    batchSummaries += count;
    if (batch.length === MAX_COMMIT_BATCH_COMPONENTS || batchSummaries === MAX_COMMIT_BATCH_SUMMARIES) await flush();
  }
  await flush();
}

async function commitBatch(context: RefreshContext, batch: readonly ComponentCommit[]): Promise<void> {
  if (batch.length === 1) {
    await commitIndividual(context, batch[0]);
    return;
  }
  // [취소 정책] 배치를 쓰기 전에 이벤트 루프에 제어를 돌려주고 취소를 다시 검사한다.
  await yieldToWorker();
  context.check();
  try {
    const names = context.database.replaceMemoryBatch(batch.map(entry => componentReplacement(context, entry)), context.storage);
    for (const [key, name] of names) context.state.savedSessionNames.set(key, name);
  } catch {
    // [SQL 트랜잭션 정책] 배치가 롤백되면 이미 만든 요약을 사용해 연결 묶음마다 다시 저장한다.
    for (const entry of batch) await commitIndividual(context, entry);
    return;
  }
  for (const entry of batch) settleFiles(entry.members);
  for (const _ of batch) context.report();
}

async function commitIndividual(context: RefreshContext, entry: ComponentCommit): Promise<void> {
  // [취소 정책] 묶음마다 쓰기 전 취소를 확인하고 반영 후 진행량을 전달한다.
  await yieldToWorker();
  context.check();
  commitComponent(context, entry);
  context.report();
}

function settleFiles(files: readonly FileState[]): void {
  for (const file of files) {
    file.settled = true;
    file.prepared = undefined;
  }
}

/** 연결된 세션을 기존 너비 우선 탐색 순서로 모아 하나의 원자적 저장 범위를 만든다. */
function linkedComponent(seed: string, links: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const component = new Set([seed]);
  // [저장 정책] Set을 삽입 순서로 순회하며 새로 찾은 세션까지 방문해 연결 성분을 완성한다.
  for (const session of component) {
    for (const linked of links.get(session) ?? [])
      component.add(linked);
  }
  return component;
}

/** 큰 성분과 보류·오류·삭제는 개별 복구 경로로 처리한다. */
function requiresIndividualCommit(entry: ComponentCommit): boolean {
  return entry.summaries.length > MAX_COMMIT_BATCH_SUMMARIES
    || entry.members.some(file => file.deferred || file.error || file.removed);
}

/** 보류·원본 오류가 있을 때 마지막 정상 반영값을 유지한다. */
function commitComponent(context: RefreshContext, entry: ComponentCommit): void {
  const { database, storage, state } = context;
  const { members } = entry;

  // [SQL 트랜잭션 정책] 미완성 행이나 원본 오류가 있으면 묶음의 마지막 정상 집계를 보존한다.
  if (members.some(file => file.deferred)) {
    settleDeferredComponent(context, members);
    return;
  }
  const sourceError = members.find(file => file.error)?.error;
  if (sourceError) {
    for (const file of members)
      if (!file.error)
        file.error = new SummaryError(sourceError.code);
    preserveMissingSources(context, members);
    return;
  }

  // [SQL 트랜잭션 정책] 저장이 끝난 뒤에만 파일을 완료 처리하고 쓰기 실패는 진단으로 남긴다.
  try {
    const names = database.replaceMemory(componentReplacement(context, entry), storage);
    for (const [key, name] of names) state.savedSessionNames.set(key, name);
    settleFiles(members);
  }
  catch (error) {
    for (const file of members)
      state.fail(file, error instanceof SummaryError ? error : new SummaryError('session-commit-error'));
    preserveMissingSources(context, members);
  }
}

/** 연결 성분의 대화 합계와 정상 반영할 파일 버전을 묶는다. */
function componentReplacement(context: RefreshContext, { component, members, summaries }: ComponentCommit): MemoryReplacement {
  const { retain, collect } = context;
  // [DTO 정책] 연결된 세션 키를 풀고 대화 요약, 저장할 파일 버전, 삭제된 파일 ID를 묶는다.
  const sessions = [...component].map(value => {
    const [provider, session_id] = JSON.parse(value) as [Provider, string];
    return { provider, session_id };
  });
  const files = [], removedFileIds = new Set<number>();
  for (const file of members) {
    if (file.removed) {
      removedFileIds.add(file.id);
      continue;
    }
    files.push(finalFile(file));
  }
  return { sessions, summaries, files, removedFileIds, retainDeletedSourceUsage: retain, preserveCapabilities: !collect };
}

function settleDeferredComponent(context: RefreshContext, members: FileState[]): void {
  // [진단 정책] 미완성 행은 기존 집계를 유지한 채 개행을 기다리는 상태만 기록한다.
  const { database } = context;
  database.transaction(() => {
    const markDeferred = database.connection.prepare(`UPDATE source_file SET processing_status='done',
      processing_position='partial-line: waiting for newline',recorded_at=?,last_error=NULL WHERE id=?`);
    for (const file of members)
      if (file.deferred) markDeferred.run(new Date().toISOString(), file.id);
  });
  settleFiles(members);
}

export function finishScan(context: RefreshContext, names: Map<string, string>): void {
  finishSourceRows(context);
  context.check();
  context.database.transaction(() => persistNames(context, names));
}

/** 세션이 담당하지 않는 원본 행과 실패를 반영한다. */
function finishSourceRows(context: RefreshContext): void {
  // [저장 정책] 세션 교체에 포함되지 않은 신규·소실 파일과 스캔 오류를 따로 수집한다.
  const { database, state, storage, retain } = context;
  const files = [], removedFileIds = [], failures: FileState[] = [];
  for (const file of state.files.values()) {
    if (file.removed) {
      if (file.previous?.session_id === null) removedFileIds.push(file.id);
    } else if (file.selected && file.attempted && !file.settled && !file.error && file.session_id === null) {
      files.push(finalFile(file));
    }
    if (file.error) failures.push(file);
  }
  // [저장 정책] 새 실패 행의 ID를 SQLite가 배정하기 전에 스캔에서 할당한 원본 ID를 먼저 반영한다.
  if (files.length) database.replaceMemory({ sessions: [], summaries: [], files }, storage);
  if (removedFileIds.length)
    database.replaceMemory({ sessions: [], summaries: [], files: [], removedFileIds, retainDeletedSourceUsage: retain }, storage);
  for (const file of failures) recordFailure(context, file);
}

function persistNames(context: RefreshContext, names: ReadonlyMap<string, string>): void {
  // [이름 정책] 이미 저장한 이름과 같은 재시도는 생략하고 DB에서도 값이 다른 세션만 갱신한다.
  const update = context.database.connection.prepare('UPDATE sessions SET session_name=? WHERE provider=? AND session_id=? AND session_name IS NOT ?');
  for (const [key, name] of names) {
    if (context.state.savedSessionNames.get(key) === name) continue;
    const [provider, session] = JSON.parse(key) as [Provider, string];
    update.run(name, provider, session, name);
  }
}

function finalFile(file: FileState): FileMetadata & { id: number } {
  return { id: file.id, provider: file.provider, source_root: file.source_root, path: file.path,
    session_id: file.session_id, mtime_ms: file.mtime_ms, parser_version: file.parser_version,
    capabilities_collected: file.capabilities_collected, relations: file.relations };
}

export function recordFailure(context: RefreshContext, file: FileState): void {
  // [진단 정책] 원본 행을 확보해 취소와 실패를 구분하고 파싱 바이트 위치를 기록한다.
  const { database } = context;
  const { code, offset } = file.error!;
  const source = database.findSourceFile(file.provider, file.path) ?? database.observeFile(file);
  database.setSourceDiagnostic(source.id, code === 'interrupted' ? 'interrupted' : 'error', `parse: byte=${offset}`, code, offset);
}

function preserveMissingSources(context: RefreshContext, members: FileState[]): void {
  // [보존 정책] 삭제 원본 보존이 켜져 있으면 기존 집계를 두고 아직 표시하지 않은 소실 상태만 기록한다.
  const { database, retain } = context;
  const removed = members.filter(file => file.removed);
  if (!removed.length || !retain) return;
  database.transaction(() => {
    const markMissing = database.connection.prepare('UPDATE source_file SET source_missing=1,recorded_at=? WHERE id=? AND source_missing=0');
    const now = new Date().toISOString();
    for (const file of removed) markMissing.run(now, file.id);
  });
}
