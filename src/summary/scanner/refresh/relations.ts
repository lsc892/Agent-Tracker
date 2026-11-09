// 부모·세션 관계를 해소하고 관련 원본의 준비 범위와 이동 연결을 확정한다.
import { groupParents } from '../../aggregation/parentGroups';
import { SummaryError } from '../../jsonl';
import { includesSourceSnapshot } from '../sourceFingerprint';
import type { RefreshContext } from './context';
import { inspectBatch, inspectSource } from './preparation';
import { sessionKey, type FileState } from './state';

export async function expandRelatedSources(context: RefreshContext): Promise<void> {
  const { state, sourcePool } = context;
  const isAffectedSource = (file: FileState): boolean => state.ready(file) && state.affected.has(sessionKey(file.provider, file.session ?? ''));
  while (true) {
    resolveLineage(context);
    enqueueParents(context);
    const parents: FileState[] = [];
    let candidate: FileState | undefined;
    while ((candidate = state.parentQueue.take())) {
      const reasons = state.parentReasons.get(candidate);
      state.parentReasons.delete(candidate);
      if (state.ready(candidate) && reasons && [...reasons].some(reference => state.missingReferences.has(reference)))
        parents.push(candidate);
    }
    if (parents.length) {
      // 새 참조가 생겨도 이번 반복 시작에 확정한 부모 batch의 id 순서를 먼저 보존한다.
      await inspectBatch(context, parents);
      continue;
    }
    const candidates = state.relatedQueue.preview(sourcePool.lookahead, file => file.selected && isAffectedSource(file));
    sourcePool.prefetch(candidates);
    let next: FileState | undefined;
    while ((candidate = state.relatedQueue.take()))
      if (isAffectedSource(candidate)) {
        next = candidate;
        break;
      }
    if (!next) break;
    await inspectSource(context, next);
  }
}

function resolveLineage(context: RefreshContext): void {
  const state = context.state;
  if (!state.lineageDirty) return;
  state.lineageDirty = false;
  state.missingParents.clear();
  const candidates = [...state.preparedCodex].filter(file => !file.removed && !file.error)
    .sort((a, b) => state.fileOrder.get(a)! - state.fileOrder.get(b)!);
  const { groups, unresolved } = groupParents(candidates.map(file => ({ id: file.prepared!.identity.threadId,
    parentId: file.prepared!.identity.parentThreadId, value: file })));
  const sessions = new Map<string, string | null>();
  for (const file of candidates) {
    const identity = file.prepared!.identity, group = groups.get(identity.threadId)!;
    if (!sessions.has(group.rootId)) {
      const targets = new Set(group.members.get(group.rootId)!.map(parent => parent.prepared!.identity.sessionId));
      sessions.set(group.rootId, targets.size === 1 ? targets.values().next().value! : null);
    }
    const target = sessions.get(group.rootId)!;
    const resolved = !unresolved.has(identity.threadId) && target !== null;
    if (!resolved)
      state.missingParents.add(file.id);
    const session = resolved ? target : identity.sessionId;
    if (file.session !== session) {
      state.connect(file.provider, file.session, session);
      state.setSession(file, session);
    }
  }
}

function enqueueParents(context: RefreshContext): void {
  const state = context.state;
  for (const reference of state.unsearchedReferences) {
    if (!state.missingReferences.has(reference)) continue;
    // manifest에 thread가 없으므로 새 미해결 참조마다 기존 substring 후보를 한 번 찾는다.
    for (const candidate of state.codexFiles) {
      if (!state.ready(candidate) || !candidate.path.includes(reference)) continue;
      let reasons = state.parentReasons.get(candidate);
      if (!reasons) state.parentReasons.set(candidate, reasons = new Set());
      reasons.add(reference);
      state.parentQueue.add(candidate);
    }
  }
  state.unsearchedReferences.clear();
}

/** 자식 자체 요청 행 대신 검증된 생성 호출의 부모 요청에 사용량을 붙인다. */
export function resolveParentRequests(context: RefreshContext): void {
  const state = context.state;
  const sources = [...state.preparedCodex].filter(file => !file.error && !file.removed)
    .sort((a, b) => state.fileOrder.get(a)! - state.fileOrder.get(b)!);
  const threads = new Map<string, FileState[]>();
  for (const file of sources) {
    const id = file.prepared!.identity.threadId, previous = threads.get(id);
    if (previous) previous.push(file); else threads.set(id, [file]);
  }
  const memo = new Map<number, string | null>(), visiting = new Set<number>();
  const resolve = (file: FileState): string | null => {
    if (memo.has(file.id)) return memo.get(file.id)!;
    if (visiting.has(file.id)) return null;
    visiting.add(file.id);
    const identity = file.prepared!.identity;
    const parents = threads.get(identity.parentThreadId ?? '') ?? [];
    const references = identity.agentPath ? [identity.threadId, identity.agentPath] : [identity.threadId];
    const roots = new Set<string | null>();
    for (const parent of parents) {
      const prepared = parent.prepared!;
      if (prepared.identity.rootlessSubagent) { roots.add(resolve(parent)); continue; }
      for (const reference of references)
        if (reference && prepared.evidence.childRequests.has(reference)) roots.add(prepared.evidence.childRequests.get(reference)!);
    }
    const target = roots.size === 1 ? roots.values().next().value! : null;
    visiting.delete(file.id); memo.set(file.id, target);
    return target;
  };
  for (const file of sources) {
    if (!file.prepared!.identity.rootlessSubagent) continue;
    if (file.prepared!.evidence.eventCount === 0) continue;
    const root = resolve(file);
    if (root === null || state.missingParents.has(file.id)) state.fail(file, new SummaryError('missing-root-turn'));
    else file.prepared!.identity.parentRootId = root;
  }
}

export async function reconnectSources(context: RefreshContext): Promise<void> {
  const { state, check, result, report, cancelled } = context;
  for (const file of state.files.values()) {
    if (!file.prepared || file.error || file.removed)
      continue;
    const matching = [...state.identityFiles.get(JSON.stringify([file.provider, file.source_identity])) ?? []]
      .sort((a, b) => state.fileOrder.get(a)! - state.fileOrder.get(b)!);
    const active = matching.filter(item => !item.removed && !item.error);
    if (active.length !== 1)
      continue;
    for (const old of matching) {
      if (!old.removed || old.session !== file.session || !old.content_hash || !(old.size_bytes > 0))
        continue;
      try {
        if (await includesSourceSnapshot(file, old, { check, onBytes: bytes => { result.bodyBytes += bytes; report(); } }))
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
