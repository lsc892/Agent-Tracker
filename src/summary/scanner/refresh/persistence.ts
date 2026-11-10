// 연결 묶음의 최종 변경분을 저장하고 소실 보존·관측·실패 진단을 마무리한다.
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
  const { state, check, report } = context;
  const { files, affected, links } = state;
  if (!affected.size) return;
  const memberGroups = new OrderedGroups(files.values(), file => [sessionKey(file.provider, file.session ?? ''),
    sessionKey(file.provider, file.previous?.session_id ?? '')]);
  const summaryGroups = new OrderedGroups(aggregated.summaries, row => [sessionKey(row.provider, row.session_id)]);
  const orphanGroups = new OrderedGroups(aggregated.orphans, row => [sessionKey(row.provider, row.session_id)]);
  const reconnectedIds = new Set(state.reconnections.flatMap(link => [link.old_id, link.new_id]));
  const queued = new Set<string>();
  let batch: ComponentCommit[] = [], batchSummaries = 0;
  const finish = ({ component }: ComponentCommit): void => {
    for (const value of component) affected.delete(value);
    report();
  };
  const flush = async (): Promise<void> => {
    if (!batch.length) return;
    const pendingBatch = batch;
    batch = [];
    batchSummaries = 0;
    queued.clear();
    await yieldToWorker();
    check();
    if (pendingBatch.length === 1) {
      const entry = pendingBatch[0];
      commitComponent(context, entry.component, entry.members, entry.aggregated);
      finish(entry);
      return;
    }
    try {
      const names = context.database.replaceMemoryBatch(pendingBatch.map(entry =>
        componentReplacement(context, entry.component, entry.members, entry.aggregated)), context.storage);
      for (const [key, name] of names) state.savedSessionNames.set(key, name);
    } catch {
      // Scanner summaries contain arrays, so rollback can safely retry each original component.
      for (const entry of pendingBatch) {
        await yieldToWorker();
        check();
        commitComponent(context, entry.component, entry.members, entry.aggregated);
        finish(entry);
      }
      return;
    }
    // A failed COMMIT must leave every member unsettled for the individual retry path.
    for (const entry of pendingBatch)
      for (const file of entry.members) file.settled = true;
    for (const entry of pendingBatch) finish(entry);
  };
  for (const seed of [...affected].sort()) {
    if (!affected.has(seed) || queued.has(seed))
      continue;
    const component = new Set([seed]), pending = [seed];
    for (let index = 0; index < pending.length; index++)
      for (const linked of links.get(pending[index]) ?? [])
        if (!component.has(linked)) {
          component.add(linked);
          pending.push(linked);
        }
    const members = memberGroups.members(component);
    const grouped = { summaries: summaryGroups.members(component), orphans: orphanGroups.members(component) };
    const entry = { component, members, aggregated: grouped };
    const special = grouped.summaries.length > MAX_COMMIT_BATCH_SUMMARIES || grouped.orphans.length > 0
      || members.some(file => file.deferred || file.error || file.removed || reconnectedIds.has(file.id));
    if (special) {
      await flush();
      await yieldToWorker();
      check();
      commitComponent(context, component, members, grouped);
      finish(entry);
      continue;
    }
    if (batchSummaries + grouped.summaries.length > MAX_COMMIT_BATCH_SUMMARIES) await flush();
    batch.push(entry);
    batchSummaries += grouped.summaries.length;
    for (const value of component) queued.add(value);
    if (batch.length === MAX_COMMIT_BATCH_COMPONENTS || batchSummaries === MAX_COMMIT_BATCH_SUMMARIES) await flush();
  }
  await flush();
}

function commitComponent(context: RefreshContext, component: Set<string>, members: FileState[], aggregated: MemoryAggregateResult): void {
  const { database, result, storage, state, collect, retain } = context;
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
    const names = database.replaceMemory(componentReplacement(context, component, members, aggregated), storage);
    for (const [key, name] of names) state.savedSessionNames.set(key, name);
    for (const file of members)
      file.settled = true;
  }
  catch (error) {
    for (const file of members)
      state.fail(file, error instanceof SummaryError ? error : new SummaryError('session-commit-error'));
    preserveMissingSources(context, members);
  }
}

/** 성분별 보존·이동 범위를 합치지 않고 기존 snapshot 계약을 그대로 만든다. */
function componentReplacement(
  context: RefreshContext, component: Set<string>, members: FileState[], aggregated: MemoryAggregateResult,
): MemoryReplacement {
  const { state, result, collect, retain } = context;
  const missing = members.some(file => file.removed);
  const memberIds = new Set(members.map(file => file.id));
  const sessions = [...component].map(value => {
    const [provider, session_id] = JSON.parse(value) as [Provider, string];
    return { provider, session_id };
  });
  return { sessions, summaries: aggregated.summaries.filter(row => !retain || !missing || row.hasMain),
    files: members.filter(file => !file.removed).map(finalFile),
    removedFileIds: members.filter(file => file.removed).map(file => file.id),
    reconnectedFiles: state.reconnections.filter(link => memberIds.has(link.old_id)),
    preserveCapabilities: !collect, retainDeletedSourceUsage: retain, scanId: result.scanId };
}

function settleDeferredComponent(context: RefreshContext, members: FileState[]): void {
  const { database } = context;
  database.transaction(() => {
    for (const file of members) {
      file.settled = true;
      if (file.deferred)
        database.connection.prepare(`UPDATE manifest SET processing_status='done',
            processing_position='partial-line: waiting for newline',recorded_at=?,last_error=NULL WHERE id=?`)
          .run(new Date().toISOString(), file.id);
    }
  });
}

export function finishScan(context: RefreshContext, names: Map<string, string>): void {
  const { database, result, storage, retain } = context;
  const { files } = context.state;
  const unsettled = [...files.values()].filter(file => file.selected && file.attempted
    && !file.settled && !file.error && !file.removed && file.session === null);
  if (unsettled.length)
    database.replaceMemory({ sessions: [], summaries: [], files: unsettled.map(finalFile), scanId: result.scanId }, storage);
  const removedEmpty = [...files.values()].filter(file => file.removed && file.previous?.session_id === null);
  if (removedEmpty.length)
    database.replaceMemory({ sessions: [], summaries: [], files: [], removedFileIds: removedEmpty.map(file => file.id),
      retainDeletedSourceUsage: retain, scanId: result.scanId }, storage);
  database.transaction(() => {
    const update = database.connection.prepare('UPDATE sessions SET session_name=? WHERE provider=? AND session_id=? AND session_name IS NOT ?');
    for (const [value, name] of names) {
      if (context.state.savedSessionNames.get(value) === name) continue;
      const [provider, session] = JSON.parse(value) as [Provider, string];
      update.run(name, provider, session, name);
    }
    const seen = database.connection.prepare('UPDATE manifest SET last_seen_scan_id=? WHERE id=?');
    for (const file of files.values())
      if (file.selected && file.previous)
        seen.run(result.scanId, file.id);
  });
  for (const file of files.values())
    if (file.error)
      recordFailure(context, file);
}

function finalFile(file: FileState): FileMetadata & { id: number } {
  return { id: file.id, provider: file.provider, source_root: file.source_root, path: file.path,
    session_id: file.session, size_bytes: file.size_bytes, mtime_ms: file.mtime_ms, dev: file.dev, inode: file.inode,
    parser_version: file.parser_version, capabilities_collected: file.capabilities_collected,
    source_identity: file.prepared?.sourceIdentity ?? file.source_identity, content_hash: file.prepared?.contentHash ?? file.content_hash };
}

export function recordFailure(context: RefreshContext, file: FileState): void {
  const { database, result } = context;
  let previous = database.findManifest(file.provider, file.path);
  if (!previous) {
    previous = database.observeFile(file, result.scanId);
    file.id = previous.id;
  }
  database.setManifestDiagnostic(previous.id, file.error!.code === 'interrupted' ? 'interrupted' : 'error', `parse: byte=${file.error!.offset}`, file.error!.code, file.error!.offset);
}

function preserveMissingSources(context: RefreshContext, members: FileState[]): void {
  const { database, result, storage, retain } = context;
  const removed = members.filter(file => file.removed);
  if (removed.length && retain)
    database.replaceMemory({ sessions: removed.filter(file => file.session).map(file => ({ provider: file.provider, session_id: file.session! })),
      summaries: [], files: [], removedFileIds: removed.map(file => file.id), retainDeletedSourceUsage: true, scanId: result.scanId }, storage);
}
