// Loads changed-session candidates and any parent timeline needed to verify copied history.
import type { RefreshContext } from './context';
import { inspectBatch, inspectSource } from './preparation';
import { isPreparedFile, sessionKey, type FileState } from './state';

export async function expandRelatedSources(context: RefreshContext): Promise<void> {
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
  sourcePool.prefetch(state.relatedQueue.preview(sourcePool.lookahead, file => file.selected && isAffectedSource(file)));
  let candidate: FileState | undefined;
  while ((candidate = state.relatedQueue.take()))
    if (isAffectedSource(candidate)) return candidate;
  return undefined;
}

function pendingParents({ state }: RefreshContext, lookedUp: Set<string>): Set<string> {
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
