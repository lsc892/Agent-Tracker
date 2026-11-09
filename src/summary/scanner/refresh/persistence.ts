// 연결 묶음의 최종 변경분을 저장하고 소실 보존·관측·실패 진단을 마무리한다.
import { setImmediate as yieldToWorker } from 'node:timers/promises';
import type { MemoryAggregateResult } from '../../aggregation/memoryAggregate';
import type { FileMetadata, Provider } from '../../db/types';
import { SummaryError } from '../../jsonl';
import { OrderedGroups } from '../worklist';
import type { RefreshContext } from './context';
import { sessionKey, type FileState } from './state';

export async function commitComponents(context: RefreshContext, aggregated: MemoryAggregateResult): Promise<void> {
  const { state, check, report } = context;
  const { files, affected, links } = state;
  if (!affected.size) return;
  const memberGroups = new OrderedGroups(files.values(), file => [sessionKey(file.provider, file.session ?? ''),
    sessionKey(file.provider, file.previous?.session_id ?? '')]);
  const summaryGroups = new OrderedGroups(aggregated.summaries, row => [sessionKey(row.provider, row.session_id)]);
  const orphanGroups = new OrderedGroups(aggregated.orphans, row => [sessionKey(row.provider, row.session_id)]);
  for (const seed of [...affected].sort()) {
    if (!affected.has(seed))
      continue;
    const component = new Set([seed]), pending = [seed];
    for (let index = 0; index < pending.length; index++)
      for (const linked of links.get(pending[index]) ?? [])
        if (!component.has(linked)) {
          component.add(linked);
          pending.push(linked);
        }
    const members = memberGroups.members(component);
    await yieldToWorker();
    check();
    commitComponent(context, component, members, { summaries: summaryGroups.members(component), orphans: orphanGroups.members(component) });
    for (const value of component)
      affected.delete(value);
    report();
  }
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
    const summaries = aggregated.summaries.filter(row => !retain || !missing || row.hasMain);
    const memberIds = new Set(members.map(file => file.id));
    const sessions = [...component].map(value => {
      const [provider, session_id] = JSON.parse(value) as [Provider, string];
      return { provider, session_id };
    });
    database.replaceMemory({ sessions, summaries, files: members.filter(file => !file.removed).map(finalFile),
      removedFileIds: members.filter(file => file.removed).map(file => file.id),
      reconnectedFiles: state.reconnections.filter(link => memberIds.has(link.old_id)),
      preserveCapabilities: !collect, retainDeletedSourceUsage: retain, scanId: result.scanId }, storage);
    for (const file of members)
      file.settled = true;
  }
  catch (error) {
    for (const file of members)
      state.fail(file, error instanceof SummaryError ? error : new SummaryError('session-commit-error'));
    preserveMissingSources(context, members);
  }
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
