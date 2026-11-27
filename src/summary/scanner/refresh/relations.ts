// 관련 원본을 읽고 부모 세션·요청의 귀속을 확정한다.
import { groupParents } from '../../aggregation/parentGroups';
import { SummaryError } from '../../jsonl';
import type { RefreshContext } from './context';
import { inspectBatch, inspectSource } from './preparation';
import { isPreparedFile, sessionKey, type FileState, type PreparedFile, type ScanState } from './state';

export async function expandRelatedSources(context: RefreshContext): Promise<void> {
  let storedThreads: ReadonlyMap<number, string> | undefined;
  while (true) {
    resolveLineage(context.state);
    const references = context.state.pendingReferences;
    if (references.size) storedThreads ??= context.database.codexSourceThreadIds();
    const parents = takeParentSources(context, storedThreads);
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

function takeParentSources({ state }: RefreshContext, storedThreads: ReadonlyMap<number, string> | undefined): FileState[] {
  if (!state.pendingReferences.size) return [];
  const references = new Set(state.pendingReferences);
  state.pendingReferences.clear();
  return state.codexFiles.filter(file => {
    if (!state.ready(file)) return false;
    const threadId = storedThreads?.get(file.id);
    if (threadId !== undefined) return references.has(threadId);
    for (const reference of references) if (file.path.includes(reference)) return true;
    return false;
  }).sort((a, b) => a.id - b.id);
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
    if (!file.session_id || !state.affected.has(sessionKey(file.provider, file.session_id))
      || !identity.rootlessSubagent || winners.evidence.eventCount === 0) continue;
    const root = resolve(file);
    if (root === null || state.missingParents.has(file.id)) state.fail(file, new SummaryError('missing-root-turn'));
    else file.prepared.parentRootId = root;
  }
}

/** Claude's structured tool result can bind child logs that have their own prompt IDs. */
export function resolveClaudeParentRequests(state: ScanState): void {
  const sources = state.preparedFiles.filter((file): file is PreparedFile => isPreparedFile(file) && file.provider === 'claude');
  const bindings = new Map<string, { parent: PreparedFile; root: string | null }[]>();
  const mainRoots = new Map<string, Set<string>>();
  for (const file of sources) {
    if (file.prepared.identity.isMain && file.session_id) {
      let roots = mainRoots.get(file.session_id);
      if (!roots) mainRoots.set(file.session_id, roots = new Set());
      for (const rootId of file.prepared.winners.roots.keys()) roots.add(rootId);
    }
    for (const [child, root] of file.prepared.winners.evidence.childRequests) {
      const key = JSON.stringify([file.session_id, child]);
      let candidates = bindings.get(key);
      if (!candidates) bindings.set(key, candidates = []);
      candidates.push({ parent: file, root });
    }
  }
  const resolved = new Map<string, string | null>(), visiting = new Set<string>();
  const resolve = (file: PreparedFile): string | null => {
    const key = JSON.stringify([file.session_id, file.prepared.identity.threadId]);
    if (resolved.has(key)) return resolved.get(key)!;
    if (visiting.has(key)) return null;
    visiting.add(key);
    const roots = new Set<string | null>();
    for (const { parent, root } of bindings.get(key) ?? []) {
      const knownRoot = root && file.session_id && mainRoots.get(file.session_id)?.has(root);
      roots.add(root && (parent.prepared.identity.isMain || knownRoot) ? root : root && resolve(parent));
    }
    const target = roots.size === 1 ? roots.values().next().value! : null;
    visiting.delete(key);
    resolved.set(key, target);
    return target;
  };
  for (const file of sources) {
    if (file.prepared.identity.isMain) continue;
    const root = resolve(file);
    if (root !== null) file.prepared.parentRootId = root;
  }
}
