// Selects unique response usage and persists one summary per thread.
import { consumeThread } from '../../aggregation/threadAccounting';
import { usageScore } from '../../aggregation/winners';
import type { TurnSummaryInput } from '../../db/types';
import type { ThreadResponse } from '../../parsers/threadUsage';
import type { RefreshContext } from './context';
import { isPreparedFile, sessionKey, type PreparedFile } from './state';

interface ThreadCandidate {
  source: PreparedFile;
  copies?: PreparedFile[];
}

export function collectThreads({ state, check }: RefreshContext, names: ReadonlyMap<string, string>): TurnSummaryInput[] {
  const threads = new Map<string, ThreadCandidate>();
  const parents = new Map<string, PreparedFile>();
  for (const file of state.preparedFiles) {
    check();
    if (!isPreparedFile(file)) continue;
    const { sessionId, threadId } = file.prepared.thread;
    if (file.provider === 'codex') {
      const parent = parents.get(threadId);
      if (!parent || preferTimeline(file, parent)) parents.set(threadId, file);
    }
    if (!state.affected.has(sessionKey(file.provider, sessionId))) continue;
    const key = JSON.stringify([file.provider, sessionId, threadId]);
    const group = threads.get(key);
    if (!group) threads.set(key, { source: file });
    else if (preferTimeline(file, group.source)) {
      (group.copies ??= []).push(group.source);
      group.source = file;
    } else {
      (group.copies ??= []).push(file);
    }
  }
  const claude = selectClaudeResponses(threads.values());
  const summaries: TurnSummaryInput[] = [];
  for (const group of threads.values()) {
    check();
    const file = group.source;
    const { thread, partialLine } = file.prepared;
    const { sessionId, threadId, projectKey, projectName, startedAt, lastAt, parentThreadId } = thread;
    const parent = parentThreadId && parentThreadId !== threadId ? parents.get(parentThreadId)?.prepared.thread : undefined;
    const responses = file.provider === 'claude' ? claude.get(group) ?? [] : allResponses(group);
    const usage = consumeThread(file.provider, thread, responses, parent);
    if (!usage) continue;
    const duration = startedAt !== null && lastAt !== null && lastAt > startedAt ? lastAt - startedAt : null;
    const flags = [partialLine ? 'partial-line' : '',
      parentThreadId && !parent && thread.records.some(record => record.kind === 'legacy') ? 'missing-fork-parent' : ''].filter(Boolean);
    summaries.push({
      provider: file.provider, session_id: sessionId, session_name: names.get(sessionKey(file.provider, sessionId)),
      root_turn_id: threadId, project_key: projectKey, project_name: projectName,
      started_at_ms: startedAt, completed_at_ms: lastAt, duration_ms: duration,
      duration_quality: duration === null ? 'missing' : 'approximate',
      input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output,
      cache_read_input_tokens: usage.cacheRead, cache_write_input_tokens: usage.cacheWrite,
      // The aggregate storage uses the completed bucket as the denominator for its averages.
      status: 'completed', quality_flags: flags.join(',') || null,
      diagnostic_file_id: flags.length ? file.id : null,
      model_usage: [...usage.models.values()].filter(row => row.model || row.input_tokens || row.output_tokens),
    });
  }
  return summaries;
}

function preferTimeline(candidate: PreparedFile, previous: PreparedFile): boolean {
  const next = candidate.prepared.thread.records, before = previous.prepared.thread.records;
  const nextHasResponses = next.some(record => record.kind === 'response');
  const previousHasResponses = before.some(record => record.kind === 'response');
  if (nextHasResponses !== previousHasResponses) return nextHasResponses;
  const length = next.length - before.length;
  if (length) return length > 0;
  if (candidate.mtime_ms !== previous.mtime_ms) return candidate.mtime_ms > previous.mtime_ms;
  return candidate.path < previous.path;
}

function* allResponses(group: ThreadCandidate): IterableIterator<ThreadResponse> {
  for (const file of group.copies ?? []) {
    for (const record of file.prepared.thread.records)
      if (record.kind === 'response') yield record;
  }
  for (const record of group.source.prepared.thread.records)
    if (record.kind === 'response') yield record;
}

/** Claude can write the same response into more than one transcript in a session. */
function selectClaudeResponses(groups: IterableIterator<ThreadCandidate>): Map<ThreadCandidate, ThreadResponse[]> {
  const sources = Array.from(groups).filter(({ source }) => source.provider === 'claude');
  const requestIds = new Map<string, string | null>();
  for (const group of sources) {
    for (const response of allResponses(group)) {
      if (!response.requestId) continue;
      const key = JSON.stringify([group.source.prepared.thread.sessionId, response.responseId]);
      const prior = requestIds.get(key);
      if (prior === undefined) requestIds.set(key, response.requestId);
      else if (prior !== response.requestId) requestIds.set(key, null);
    }
  }
  const best = new Map<string, { group: ThreadCandidate; response: ThreadResponse; score: number | bigint }>();
  for (const group of sources) {
    for (const response of allResponses(group)) {
      const session = group.source.prepared.thread.sessionId;
      const request = response.requestId ?? requestIds.get(JSON.stringify([session, response.responseId]));
      const key = JSON.stringify([session, response.responseId, request ?? null]);
      const score = usageScore(response), prior = best.get(key);
      if (!prior || score >= prior.score) best.set(key, { group, response, score });
    }
  }
  const selected = new Map<ThreadCandidate, ThreadResponse[]>();
  for (const { group, response } of best.values()) {
    const records = selected.get(group);
    if (records) records.push(response);
    else selected.set(group, [response]);
  }
  return selected;
}
