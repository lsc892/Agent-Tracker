// Merges prepared response winners and keeps the timeline needed to verify Codex usage.
import { accumulateThreadUsage, consumeCodexThread, type CodexThreadEvidence, type ThreadUsage } from '../../aggregation/threadAccounting';
import { usageScore } from '../../aggregation/winners';
import type { TurnSummaryInput } from '../../db/types';
import { responseKey, type ThreadCheckpointInterval, type ThreadLog, type ThreadResponse } from '../../parsers/threadUsage';
import type { FileState } from './state';

interface SourceOrder {
  copyOrder?: number;
}

interface SummarySource {
  file: FileState;
  thread: Omit<ThreadLog, 'responses' | 'checkpoints' | 'legacy' | 'leadingLegacyCount' | 'firstResponse'>;
  partialLine: boolean;
  hasResponses: boolean;
  order: SourceOrder;
  codex?: CodexThreadEvidence;
}

interface CodexResponses {
  winners: Map<string, ThreadResponse>;
  // Used only when copies can compete with the canonical file on an equal score.
  canonicalKeys?: Set<string>;
}

interface ThreadCandidate {
  source: SummarySource;
  session: string;
  order: number;
  codex?: CodexResponses;
}

interface ClaudeWinner {
  group: ThreadCandidate;
  source: SourceOrder;
  response: ThreadResponse;
}

export class ThreadAggregation {
  private readonly threads = new Map<string, ThreadCandidate>();
  private readonly parents = new Map<string, SummarySource>();
  private readonly claude = new Map<string, Map<string | undefined, ClaudeWinner>>();
  private sourceOrder = 0;

  add(file: FileState, session: string, log: ThreadLog, partialLine: boolean): void {
    const { responses, checkpoints, legacy, leadingLegacyCount, firstResponse, ...thread } = log;
    const source: SummarySource = { file, thread, partialLine, hasResponses: responses.length > 0, order: {} };
    const key = JSON.stringify([session, thread.threadId]);
    const previous = this.threads.get(key);
    const preferred = !previous || preferTimeline(source, previous.source);
    const group = previous ?? { source, session, order: this.threads.size,
      codex: file.provider === 'codex' ? { winners: new Map<string, ThreadResponse>() } : undefined };
    const order = this.sourceOrder++;
    if (previous) {
      if (preferred) {
        group.source.order.copyOrder = order;
        group.source = source;
      } else source.order.copyOrder = order;
    } else this.threads.set(key, group);

    if (!group.codex) {
      this.addClaude(group, source.order, responses);
      return;
    }
    const intervals = preferred ? checkpoints.map(interval => ({ ...interval, responseKeys: [] as string[] })) : [];
    mergeCodexResponses(group.codex, responses, preferred, !!previous, intervals);
    if (preferred) {
      source.codex = { checkpoints: intervals, legacy, leadingLegacyCount, firstResponse, responseCount: responses.length };
      const parent = this.parents.get(thread.threadId);
      if (!parent || preferTimeline(source, parent)) this.parents.set(thread.threadId, source);
    }
  }

  summarize(affected: ReadonlySet<string>, names: ReadonlyMap<string, string>, check: () => void): TurnSummaryInput[] {
    const claude = this.summarizeClaude(affected);
    const summaries: TurnSummaryInput[] = [];
    for (const group of this.threads.values()) {
      check();
      if (!affected.has(group.session)) continue;
      const { file, thread, partialLine, codex } = group.source;
      const { sessionId, threadId, projectKey, projectName, startedAt, lastAt, parentThreadId } = thread;
      const parent = parentThreadId && parentThreadId !== threadId ? this.parents.get(parentThreadId) : undefined;
      const usage = codex && group.codex ? consumeCodexThread(codex, group.codex.winners, parent?.codex) : claude.get(group);
      if (!usage) continue;
      const duration = startedAt !== null && lastAt !== null && lastAt > startedAt ? lastAt - startedAt : null;
      const flags = [partialLine ? 'partial-line' : '',
        parentThreadId && !parent && codex?.legacy.length ? 'missing-fork-parent' : ''].filter(Boolean);
      summaries.push({
        provider: file.provider, session_id: sessionId, session_name: names.get(group.session),
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
    this.threads.clear();
    this.parents.clear();
    return summaries;
  }

  private addClaude(group: ThreadCandidate, source: SourceOrder, responses: readonly ThreadResponse[]): void {
    for (const response of responses) {
      const key = JSON.stringify([group.session, response.responseId]);
      let requests = this.claude.get(key);
      if (!requests) this.claude.set(key, requests = new Map());
      const request = response.requestId || undefined;
      const previous = requests.get(request);
      const winner = { group, source, response };
      if (!previous || betterClaude(winner, previous)) requests.set(request, winner);
    }
  }

  private summarizeClaude(affected: ReadonlySet<string>): Map<ThreadCandidate, ThreadUsage> {
    const usage = new Map<ThreadCandidate, ThreadUsage>();
    for (const requests of this.claude.values()) {
      // Resolve an unidentified request only when exactly one known request used this response ID.
      const anonymous = requests.size === 2 ? requests.get(undefined) : undefined;
      for (const entry of requests.values()) {
        if (entry === anonymous) continue;
        const { group, response } = anonymous && betterClaude(anonymous, entry) ? anonymous : entry;
        if (affected.has(group.session)) usage.set(group, accumulateThreadUsage(usage.get(group), response.tokens, response.model));
      }
    }
    this.claude.clear();
    return usage;
  }
}

function preferTimeline(candidate: SummarySource, previous: SummarySource): boolean {
  if (candidate.hasResponses !== previous.hasResponses) return candidate.hasResponses;
  if (candidate.thread.recordCount !== previous.thread.recordCount) return candidate.thread.recordCount > previous.thread.recordCount;
  if (candidate.file.mtime_ms !== previous.file.mtime_ms) return candidate.file.mtime_ms > previous.file.mtime_ms;
  return candidate.file.path < previous.file.path;
}

function betterClaude(candidate: ClaudeWinner, previous: ClaudeWinner): boolean {
  const score = usageScore(candidate.response), previousScore = usageScore(previous.response);
  if (score !== previousScore) return score > previousScore;
  // Equal usage keeps the last transcript within the original group order. Canonical comes after all copies.
  if (candidate.group !== previous.group) return candidate.group.order > previous.group.order;
  if (candidate.source !== previous.source)
    return (candidate.source.copyOrder ?? Infinity) > (previous.source.copyOrder ?? Infinity);
  return candidate.response.order > previous.response.order;
}

function mergeCodexResponses(target: CodexResponses, responses: readonly ThreadResponse[], preferred: boolean,
  hasPrevious: boolean, intervals: readonly (ThreadCheckpointInterval & { responseKeys: string[] })[]): void {
  if (hasPrevious) {
    if (preferred) target.canonicalKeys = new Set();
    else target.canonicalKeys ??= new Set(target.winners.keys());
  }
  const { winners, canonicalKeys } = target;
  let intervalIndex = 0;
  for (let responseIndex = 0; responseIndex < responses.length; responseIndex++) {
    const response = responses[responseIndex];
    const key = responseKey(response), prior = winners.get(key);
    for (let interval = intervals[intervalIndex]; interval && interval.start.responseIndex <= responseIndex; interval = intervals[++intervalIndex]) {
      interval.responseKeys.push(key);
      // Adjacent intervals share their boundary response.
      if (interval.end.responseIndex > responseIndex) break;
    }
    if (prior) {
      const score = usageScore(response), previousScore = usageScore(prior);
      if (score < previousScore || score === previousScore && !preferred && canonicalKeys?.has(key)) continue;
    }
    winners.set(key, response);
    if (preferred) canonicalKeys?.add(key);
    else canonicalKeys?.delete(key);
  }
}
