// 부모·세션 관계를 해소하고 관련 원본의 준비 범위와 이동 연결을 확정한다.
import { groupParents } from '../../aggregation/parentGroups';
import { SummaryError } from '../../jsonl';
import { includesSourceSnapshot } from '../sourceFingerprint';
import type { RefreshContext } from './context';
import { inspectBatch, inspectSource } from './preparation';
import { isPreparedFile, sessionKey, type FileState, type PreparedFile, type ScanState } from './state';

export async function expandRelatedSources(context: RefreshContext): Promise<void> {
  while (true) {
    resolveLineage(context.state);
    const parents = takeParentSources(context.state);
    if (parents.length) {
      await inspectBatch(context, parents);
      continue;
    }
    const next = takeRelatedSource(context);
    if (!next) return;
    await inspectSource(context, next);
  }
}

function takeRelatedSource(context: RefreshContext): FileState | undefined {
  const { state, sourcePool } = context;
  const isAffectedSource = (file: FileState): boolean => state.ready(file)
    && !!file.session_id && state.affected.has(sessionKey(file.provider, file.session_id));
  sourcePool.prefetch(state.relatedQueue.preview(sourcePool.lookahead, file => file.selected && isAffectedSource(file)));
  let candidate: FileState | undefined;
  while ((candidate = state.relatedQueue.take()))
    if (isAffectedSource(candidate)) return candidate;
  return undefined;
}

function resolveLineage(state: ScanState): void {
  if (!state.lineageDirty) return;
  state.lineageDirty = false;
  state.missingParents.clear();
  const candidates = state.preparedCodexFiles();
  const { groups, unresolved } = groupParents(candidates.map(file => ({ id: file.prepared.identity.threadId,
    parentId: file.prepared.identity.parentThreadId, value: file })));
  const sessions = new Map<string, string | null>();
  for (const file of candidates) {
    const identity = file.prepared.identity, group = groups.get(identity.threadId)!;
    if (!sessions.has(group.rootId)) {
      const targets = new Set(group.members.get(group.rootId)!.map(parent => parent.prepared.identity.sessionId));
      sessions.set(group.rootId, targets.size === 1 ? targets.values().next().value! : null);
    }
    const target = sessions.get(group.rootId)!;
    const resolved = !unresolved.has(identity.threadId) && target !== null;
    if (!resolved)
      state.missingParents.add(file.id);
    const session = resolved ? target : identity.sessionId;
    if (file.session_id !== session) {
      state.connect(file.provider, file.session_id, session);
      state.setSession(file, session);
    }
  }
}

function takeParentSources(state: ScanState): FileState[] {
  if (!state.pendingReferences.size) return [];
  const references = [...state.pendingReferences];
  state.pendingReferences.clear();
  // 파싱된 thread를 얻기 전에는 경로에서만 부모 후보를 좁힐 수 있다.
  return state.codexFiles.filter(file => state.ready(file) && references.some(reference => file.path.includes(reference)))
    .sort((a, b) => a.id - b.id);
}

/** 자식 자체 요청 행 대신 검증된 생성 호출의 부모 요청에 사용량을 붙인다. */
export function resolveParentRequests(context: RefreshContext): void {
  const state = context.state;
  const sources = state.preparedCodexFiles();
  const threads = new Map<string, PreparedFile[]>();
  for (const file of sources) {
    const id = file.prepared.identity.threadId, previous = threads.get(id);
    if (previous) previous.push(file); else threads.set(id, [file]);
  }
  const memo = new Map<number, string | null>(), visiting = new Set<number>();
  const resolve = (file: PreparedFile): string | null => {
    if (memo.has(file.id)) return memo.get(file.id)!;
    if (visiting.has(file.id)) return null;
    visiting.add(file.id);
    const identity = file.prepared.identity;
    const parents = threads.get(identity.parentThreadId ?? '') ?? [];
    const references = identity.agentPath ? [identity.threadId, identity.agentPath] : [identity.threadId];
    const roots = new Set<string | null>();
    for (const parent of parents) {
      const prepared = parent.prepared;
      if (prepared.identity.rootlessSubagent) { roots.add(resolve(parent)); continue; }
      const requests = prepared.winners.evidence.childRequests;
      for (const reference of references)
        if (reference && requests.has(reference)) roots.add(requests.get(reference)!);
    }
    const target = roots.size === 1 ? roots.values().next().value! : null;
    visiting.delete(file.id); memo.set(file.id, target);
    return target;
  };
  for (const file of sources) {
    const { identity, winners } = file.prepared;
    if (!identity.rootlessSubagent || winners.evidence.eventCount === 0) continue;
    const root = resolve(file);
    if (root === null || state.missingParents.has(file.id)) state.fail(file, new SummaryError('missing-root-turn'));
    else identity.parentRootId = root;
  }
}

export async function reconnectSources(context: RefreshContext): Promise<void> {
  const { state, check, onBytes, cancelled } = context;
  if (!state.preparedFiles.length) return;
  for (const file of state.files.values()) {
    if (!isPreparedFile(file)) continue;
    for (const old of removedPredecessors(state, file)) {
      try {
        if (await includesSourceSnapshot(file, old, { check, onBytes }))
          state.reconnections.push({ old_id: old.id, new_id: file.id });
      }
      catch (error) {
        state.fail(file, error);
        if (cancelled())
          throw error;
        break;
      }
    }
  }
}

function removedPredecessors(state: ScanState, file: FileState): FileState[] {
  const removed: FileState[] = [];
  for (const candidate of state.matchingSources(file)) {
    if (candidate === file) continue;
    if (!candidate.removed) {
      if (!candidate.error) return [];
    } else if (candidate.session_id === file.session_id && candidate.content_hash && candidate.size_bytes > 0) {
      removed.push(candidate);
    }
  }
  return removed.sort((a, b) => a.discoveryOrder - b.discoveryOrder);
}
