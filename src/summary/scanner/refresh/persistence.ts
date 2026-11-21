// 연결 묶음의 최종 변경분을 저장하고 진단과 전역 갱신 기준을 확정한다.
import { setImmediate as yieldToWorker } from 'node:timers/promises';
import type { MemoryAggregateResult } from '../../aggregation/memoryAggregate';
import type { MemoryReplacement } from '../../db/memoryStore';
import type { FileMetadata, Provider } from '../../db/types';
import { SummaryError } from '../../jsonl';
import { OrderedGroups } from '../worklist';
import type { RefreshContext } from './context';
import { sessionKey, type FileState } from './state';

const MAX_COMMIT_BATCH_COMPONENTS = 16;
const MAX_COMMIT_BATCH_SUMMARIES = 1000;

interface ComponentCommit {
  component: Set<string>;
  members: FileState[];
  aggregated: MemoryAggregateResult;
}

export async function commitComponents(context: RefreshContext, aggregated: MemoryAggregateResult): Promise<void> {
  const { files, affected, links, reconnections } = context.state;
  if (!affected.size) return;
  const memberGroups = new OrderedGroups(files.values(), file => [sessionKey(file.provider, file.session_id ?? ''),
    sessionKey(file.provider, file.previous?.session_id ?? '')]);
  const summaryGroups = new OrderedGroups(aggregated.summaries, row => [sessionKey(row.provider, row.session_id)]);
  const orphanGroups = new OrderedGroups(aggregated.orphans, row => [sessionKey(row.provider, row.session_id)]);
  const reconnectedIds = new Set(reconnections.flatMap(link => [link.old_id, link.new_id]));
  const remaining = new Set([...affected].sort());
  let batch: ComponentCommit[] = [];
  let batchSummaries = 0;
  const flush = async (): Promise<void> => {
    if (!batch.length) return;
    await commitBatch(context, batch);
    batch = [];
    batchSummaries = 0;
  };
  for (const seed of remaining) {
    const component = linkedComponent(seed, links);
    for (const session of component) remaining.delete(session);
    const entry = { component, members: memberGroups.members(component),
      aggregated: { summaries: summaryGroups.members(component), orphans: orphanGroups.members(component) } };
    if (requiresIndividualCommit(entry, reconnectedIds)) {
      await flush();
      await commitIndividual(context, entry);
      continue;
    }
    const summaries = entry.aggregated.summaries.length;
    if (batchSummaries + summaries > MAX_COMMIT_BATCH_SUMMARIES) await flush();
    batch.push(entry);
    batchSummaries += summaries;
    if (batch.length === MAX_COMMIT_BATCH_COMPONENTS || batchSummaries === MAX_COMMIT_BATCH_SUMMARIES) await flush();
  }
  await flush();
}

async function commitBatch(context: RefreshContext, batch: readonly ComponentCommit[]): Promise<void> {
  if (batch.length === 1) {
    await commitIndividual(context, batch[0]);
    return;
  }
  await yieldToWorker();
  context.check();
  try {
    const names = context.database.replaceMemoryBatch(batch.map(entry => componentReplacement(context, entry)), context.storage);
    for (const [key, name] of names) context.state.savedSessionNames.set(key, name);
  } catch {
    // Materialized summaries can be replayed after the batch transaction rolls back.
    for (const entry of batch) await commitIndividual(context, entry);
    return;
  }
  for (const entry of batch) settleFiles(entry.members);
  for (const _ of batch) context.report();
}

async function commitIndividual(context: RefreshContext, entry: ComponentCommit): Promise<void> {
  await yieldToWorker();
  context.check();
  commitComponent(context, entry);
  context.report();
}

function settleFiles(files: readonly FileState[]): void {
  for (const file of files) file.settled = true;
}

/** 연결된 세션을 기존 너비 우선 탐색 순서로 모아 하나의 원자적 저장 범위를 만든다. */
function linkedComponent(seed: string, links: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const component = new Set([seed]);
  // Set iteration also visits newly discovered sessions in insertion order.
  for (const session of component) {
    for (const linked of links.get(session) ?? [])
      component.add(linked);
  }
  return component;
}

/** 큰 성분과 보류·오류·삭제·재연결은 기존 개별 복구 경로로 처리한다. */
function requiresIndividualCommit(entry: ComponentCommit, reconnectedIds: ReadonlySet<number>): boolean {
  return entry.aggregated.summaries.length > MAX_COMMIT_BATCH_SUMMARIES || entry.aggregated.orphans.length > 0
    || entry.members.some(file => file.deferred || file.error || file.removed || reconnectedIds.has(file.id));
}

/** 보류 → 원본 오류 → 고아 요청 → 실제 쓰기 순으로 검사해 앞선 보존·복구 정책을 우선한다. */
function commitComponent(context: RefreshContext, entry: ComponentCommit): void {
  const { database, storage, state, retain } = context;
  const { members, aggregated } = entry;
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
  const missing = members.some(file => file.removed);
  const orphan = !retain || !missing ? aggregated.orphans[0] : undefined;
  if (orphan) {
    const file = state.files.get(orphan.fileId)!;
    state.fail(file, new SummaryError('missing-root-turn', orphan.offset));
    for (const sibling of members)
      if (!sibling.error)
        sibling.error = file.error;
    preserveMissingSources(context, members);
    return;
  }
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

/** 성분별 보존·이동 범위를 합치지 않고 기존 snapshot 계약을 그대로 만든다. */
function componentReplacement(context: RefreshContext, { component, members, aggregated }: ComponentCommit): MemoryReplacement {
  const { state, collect, retain } = context;
  const sessions = [...component].map(value => {
    const [provider, session_id] = JSON.parse(value) as [Provider, string];
    return { provider, session_id };
  });
  const files = [], removedFileIds = new Set<number>();
  for (const file of members) {
    if (file.removed) removedFileIds.add(file.id);
    else files.push(finalFile(file));
  }
  const summaries = retain && removedFileIds.size ? aggregated.summaries.filter(row => row.hasMain) : aggregated.summaries;
  return { sessions, summaries, files, removedFileIds,
    reconnectedFiles: state.reconnections.filter(link => removedFileIds.has(link.old_id)),
    preserveCapabilities: !collect, retainDeletedSourceUsage: retain };
}

function settleDeferredComponent(context: RefreshContext, members: FileState[]): void {
  const { database } = context;
  database.transaction(() => {
    const markDeferred = database.connection.prepare(`UPDATE source_file SET processing_status='done',
      processing_position='partial-line: waiting for newline',recorded_at=?,last_error=NULL WHERE id=?`);
    for (const file of members)
      if (file.deferred) markDeferred.run(new Date().toISOString(), file.id);
  });
  settleFiles(members);
}

export function finishScan(context: RefreshContext, names: Map<string, string>, scope: string, startedMs: number): void {
  const hasDeferredFiles = finishSourceRows(context);
  context.check();
  context.database.transaction(() => {
    persistNames(context, names);
    // Commit the scan's starting time so writes after discovery remain eligible next time.
    if (!context.result.failed && !hasDeferredFiles)
      context.database.connection.prepare(`INSERT INTO summary_refresh(id,scope,started_ms) VALUES(1,?,?)
        ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,started_ms=excluded.started_ms`).run(scope, startedMs);
  });
}

/** 세션이 담당하지 않는 원본 행과 실패를 반영하고 보류 원본을 확인한다. */
function finishSourceRows(context: RefreshContext): boolean {
  const { database, state, storage, retain } = context;
  const files = [], removedFileIds = [], failures: FileState[] = [];
  let hasDeferredFiles = false;
  for (const file of state.files.values()) {
    if (file.removed) {
      if (file.previous?.session_id === null) removedFileIds.push(file.id);
    } else if (file.selected && file.attempted && !file.settled && !file.error && file.session_id === null) {
      files.push(finalFile(file));
    }
    if (file.error) failures.push(file);
    if (file.deferred) hasDeferredFiles = true;
  }
  // Persist allocated IDs before recording new failures through SQLite-assigned IDs.
  if (files.length) database.replaceMemory({ sessions: [], summaries: [], files }, storage);
  if (removedFileIds.length)
    database.replaceMemory({ sessions: [], summaries: [], files: [], removedFileIds, retainDeletedSourceUsage: retain }, storage);
  for (const file of failures) recordFailure(context, file);
  return hasDeferredFiles;
}

function persistNames(context: RefreshContext, names: ReadonlyMap<string, string>): void {
  const update = context.database.connection.prepare('UPDATE sessions SET session_name=? WHERE provider=? AND session_id=? AND session_name IS NOT ?');
  for (const [key, name] of names) {
    if (context.state.savedSessionNames.get(key) === name) continue;
    const [provider, session] = JSON.parse(key) as [Provider, string];
    update.run(name, provider, session, name);
  }
}

function finalFile(file: FileState): FileMetadata & { id: number } {
  return { id: file.id, provider: file.provider, source_root: file.source_root, path: file.path,
    session_id: file.session_id, size_bytes: file.size_bytes, mtime_ms: file.mtime_ms, dev: file.dev, inode: file.inode,
    parser_version: file.parser_version, capabilities_collected: file.capabilities_collected,
    source_identity: file.source_identity, content_hash: file.content_hash };
}

export function recordFailure(context: RefreshContext, file: FileState): void {
  const { database } = context;
  const { code, offset } = file.error!;
  const source = database.findSourceFile(file.provider, file.path) ?? database.observeFile(file);
  database.setSourceDiagnostic(source.id, code === 'interrupted' ? 'interrupted' : 'error', `parse: byte=${offset}`, code, offset);
}

function preserveMissingSources(context: RefreshContext, members: FileState[]): void {
  const { database, storage, retain } = context;
  const removed = members.filter(file => file.removed);
  if (removed.length && retain)
    database.replaceMemory({ sessions: removed.filter(file => file.session_id).map(file => ({ provider: file.provider, session_id: file.session_id! })),
      summaries: [], files: [], removedFileIds: removed.map(file => file.id), retainDeletedSourceUsage: true }, storage);
}
