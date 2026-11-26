// Loads changed-session candidates and any parent timeline needed to verify copied history.
import type { RefreshContext } from './context';
import { inspectBatch, inspectSource } from './preparation';
import { isPreparedFile, sessionKey, type FileState } from './state';

export async function expandRelatedSources(context: RefreshContext): Promise<void> {
  // [귀속 정책] 변경 세션의 관련 파일을 먼저 소진하고 부모를 더 확보할 수 있는 동안 반복한다.
  const lookedUp = new Set<string>();
  let storedThreads: Map<string, FileState[]> | undefined;
  for (;;) {
    let next: FileState | undefined;
    while ((next = takeRelatedSource(context))) await inspectSource(context, next);
    const needed = pendingParents(context, lookedUp);
    if (!needed.size) return;
    storedThreads ??= indexAvailableCodexThreads(context);
    const parents = new Set<FileState>();
    for (const id of needed) {
      for (const file of storedThreads.get(id) ?? []) if (context.state.ready(file)) parents.add(file);
    }
    if (!parents.size) return;
    await inspectBatch(context, [...parents]);
  }
}

function takeRelatedSource(context: RefreshContext): FileState | undefined {
  const { state, sourcePool } = context;
  const isAffectedSource = (file: FileState): boolean => state.ready(file)
    && !!file.session_id && state.affected.has(sessionKey(file.provider, file.session_id));
  // [큐 정책] 선택된 원본은 선행 읽기하고 실제 소비 시점에 영향 범위를 다시 확인한다.
  sourcePool.prefetch(state.relatedQueue.preview(sourcePool.lookahead, file => file.selected && isAffectedSource(file)));
  let candidate: FileState | undefined;
  while ((candidate = state.relatedQueue.take()))
    if (isAffectedSource(candidate)) return candidate;
  return undefined;
}

function pendingParents({ state }: RefreshContext, lookedUp: Set<string>): Set<string> {
  // [귀속 정책] 변경 세션의 레거시 이력에 필요한 부모만 찾고 이미 읽거나 검색한 스레드는 제외한다.
  const alreadyRead = new Set<string>(), needed = new Set<string>();
  for (const file of state.preparedCodexFiles) {
    if (!isPreparedFile(file)) continue;
    const { threadId, parentThreadId, sessionId, hasLegacy } = file.prepared;
    alreadyRead.add(threadId);
    if (parentThreadId && parentThreadId !== threadId && !lookedUp.has(parentThreadId)
      && hasLegacy && state.affected.has(sessionKey(file.provider, sessionId))) {
      needed.add(parentThreadId);
    }
  }
  for (const id of needed) {
    lookedUp.add(id);
    if (alreadyRead.has(id)) needed.delete(id);
  }
  return needed;
}

function indexAvailableCodexThreads({ database, state, check }: RefreshContext): Map<string, FileState[]> {
  // [색인 정책] 이전에 저장한 파일·스레드 ID로 아직 읽을 수 있는 Codex 후보를 묶는다.
  const threads = new Map<string, FileState[]>();
  const threadIds = database.codexSourceThreadIds();
  for (const file of state.files.values()) {
    check();
    if (file.provider !== 'codex' || !state.ready(file) || !file.previous) continue;
    const id = threadIds.get(file.id);
    if (!id) continue;
    const candidates = threads.get(id);
    if (candidates) candidates.push(file);
    else threads.set(id, [file]);
  }
  return threads;
}
