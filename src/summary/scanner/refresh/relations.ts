// 관련 원본을 읽고 부모 세션·요청의 귀속을 확정한다.
import { groupParents } from '../../aggregation/parentGroups';
import { SummaryError } from '../../jsonl';
import type { RefreshContext } from './context';
import { inspectBatch, inspectSource } from './preparation';
import { isPreparedFile, sessionKey, type FileState, type PreparedFile, type ScanState } from './state';

/** 영향받은 세션과 그 부모·복사 원본을 찾는 데 필요한 파일을 추가로 읽는다. */
export async function expandRelatedSources(context: RefreshContext): Promise<void> {
  let storedThreads: ReadonlyMap<number, string> | undefined;
  while (true) {
    resolveLineage(context.state);
    // 새 계보 참조가 있을 때만 DB의 스레드 ID를 불러오고 부모 후보부터 처리한다.
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

/** 영향받은 세션에 속한 미처리 원본을 파일 ID 순으로 하나 꺼낸다. */
function takeRelatedSource(context: RefreshContext): FileState | undefined {
  const { state, sourcePool } = context;
  const isAffectedSource = (file: FileState): boolean => state.ready(file)
    && !!file.session_id && state.affected.has(sessionKey(file.provider, file.session_id));
  // 큐의 순서를 유지하며 선택 범위 안의 후보만 미리 읽도록 요청한다.
  sourcePool.prefetch(state.relatedQueue.preview(sourcePool.lookahead, file => file.selected && isAffectedSource(file)));
  let candidate: FileState | undefined;
  while ((candidate = state.relatedQueue.take()))
    if (isAffectedSource(candidate)) return candidate;
  return undefined;
}

/** 준비된 Codex 파일의 계보를 따라 귀속 세션을 결정한다. */
function resolveLineage(state: ScanState): void {
  if (!state.lineageDirty) return;
  state.lineageDirty = false;
  state.missingParents.clear();
  const candidates = state.preparedCodexFiles();
  const { groups, unresolved } = groupParents(candidates.map(file => ({ id: file.prepared.identity.threadId,
    parentId: file.prepared.identity.parentThreadId, value: file })));
  // 최상위 스레드의 세션 ID가 하나로 확정될 때만 계보 전체에 같은 세션을 적용한다.
  const sessions = new Map<string, string | null>();
  for (const file of candidates) {
    const identity = file.prepared.identity, group = groups.get(identity.threadId)!;
    if (!sessions.has(group.rootId)) {
      const targets = new Set(group.members.get(group.rootId)!.map(parent => parent.prepared.identity.sessionId));
      sessions.set(group.rootId, targets.size === 1 ? targets.values().next().value! : null);
    }
    const target = sessions.get(group.rootId)!;
    const resolved = !unresolved.has(identity.threadId) && target !== null;
    // 계보가 확정되지 않으면 원래 세션을 쓰고 부모 미확정 상태를 기록한다.
    if (!resolved)
      state.missingParents.add(file.id);
    const session = resolved ? target : identity.sessionId;
    if (file.session_id !== session) {
      state.connect(file.provider, file.session_id, session);
      state.setSession(file, session);
    }
  }
}

/** 대기 중인 계보 참조에 해당할 수 있는 Codex 원본을 모은다. */
function takeParentSources({ state }: RefreshContext, storedThreads: ReadonlyMap<number, string> | undefined): FileState[] {
  if (!state.pendingReferences.size) return [];
  const references = new Set(state.pendingReferences);
  state.pendingReferences.clear();
  return state.codexFiles.filter(file => {
    if (!state.ready(file)) return false;
    // 저장된 스레드 ID를 우선 비교하고 ID가 없으면 파일 경로에서 참조를 찾는다.
    const threadId = storedThreads?.get(file.id);
    if (threadId !== undefined) return references.has(threadId);
    for (const reference of references) if (file.path.includes(reference)) return true;
    return false;
  }).sort((a, b) => a.id - b.id);
}

/** Codex 자식 로그의 사용량을 생성 호출이 속한 부모 요청에 귀속한다. */
export function resolveParentRequests(context: RefreshContext): void {
  const state = context.state;
  const sources = state.preparedCodexFiles();
  const threads = new Map<string, PreparedFile[]>();
  for (const file of sources) {
    const id = file.prepared.identity.threadId, previous = threads.get(id);
    if (previous) previous.push(file); else threads.set(id, [file]);
  }
  const memo = new Map<number, string | null>(), visiting = new Set<number>();
  // 부모 생성 호출을 따라 요청 ID를 찾고, 방문 기록으로 순환을 막으며 계산 결과를 재사용한다.
  const resolve = (file: PreparedFile): string | null => {
    if (memo.has(file.id)) return memo.get(file.id)!;
    if (visiting.has(file.id)) return null;
    visiting.add(file.id);
    const identity = file.prepared.identity;
    const parents = threads.get(identity.parentThreadId ?? '') ?? [];
    const references = identity.agentPath ? [identity.threadId, identity.agentPath] : [identity.threadId];
    const roots = new Set<string | null>();
    // 자체 루트 요청이 없는 부모라면 조상의 요청까지 추적하고, 다른 부모는 자식 참조와 대조한다.
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
  // 이벤트가 있는 자식의 부모나 요청이 확정되지 않으면 해당 파일에 오류를 남긴다.
  for (const file of sources) {
    const { identity, winners } = file.prepared;
    if (!file.session_id || !state.affected.has(sessionKey(file.provider, file.session_id))
      || !identity.rootlessSubagent || winners.evidence.eventCount === 0) continue;
    const root = resolve(file);
    if (root === null || state.missingParents.has(file.id)) state.fail(file, new SummaryError('missing-root-turn'));
    else file.prepared.parentRootId = root;
  }
}

/** Claude 도구 결과의 자식 참조로 자식 로그를 부모 요청에 연결한다. */
export function resolveClaudeParentRequests(state: ScanState): void {
  const sources = state.preparedFiles.filter((file): file is PreparedFile => isPreparedFile(file) && file.provider === 'claude');
  // 세션별 메인 요청 ID와 각 자식 스레드를 실행한 부모의 기록을 모은다.
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
  // 부모를 따라 메인 요청을 찾고 순환이나 후보 충돌은 귀속 미확정으로 처리한다.
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
