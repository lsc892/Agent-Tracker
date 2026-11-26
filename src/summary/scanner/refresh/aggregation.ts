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

  add(file: FileState, session: string, log: ThreadLog): void {
    // [Winner 정책] 같은 스레드의 복사본 중 응답 유무, 많은 기록, 최신 수정 시각, 경로 오름차순으로 대표를 고른다.
    const { responses, checkpoints, legacy, leadingLegacyCount, firstResponse, ...thread } = log;
    const source: SummarySource = { file, thread, hasResponses: responses.length > 0, order: {} };
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

    // [Winner 정책] Claude는 세션·메시지·요청 ID로, Codex는 스레드 안에서 턴·응답 ID로 비교한다.
    if (!group.codex) {
      this.addClaude(group, source.order, responses);
      return;
    }
    const intervals = preferred ? checkpoints.map(interval => ({ ...interval, responseKeys: [] as string[] })) : [];
    mergeCodexResponses(group.codex, responses, preferred, !!previous, intervals);

    // [집계 정책] 대표 원본의 누계 구간과 레거시 기록을 부모 이력 비교에 쓸 수 있도록 색인한다.
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
      const { file, thread, codex } = group.source;
      const { sessionId, threadId, projectKey, projectName, startedAt, lastAt, parentThreadId } = thread;

      // [집계 정책] Claude는 확정 응답을 합산하고 Codex는 부모 이력과 누계 검증까지 반영한다.
      const parent = parentThreadId && parentThreadId !== threadId ? this.parents.get(parentThreadId) : undefined;
      const usage = codex && group.codex ? consumeCodexThread(codex, group.codex.winners, parent?.codex) : claude.get(group);
      if (!usage) continue;

      // [DTO 정책] 스레드 ID를 요청 키에 넣고 토큰·모델 합계와 최초·최종 시각 차이를 담는다.
      const duration = startedAt !== null && lastAt !== null && lastAt > startedAt ? lastAt - startedAt : null;
      summaries.push({
        provider: file.provider, session_id: sessionId, session_name: names.get(group.session),
        root_turn_id: threadId, project_key: projectKey, project_name: projectName,
        started_at_ms: startedAt, duration_ms: duration,
        duration_quality: duration === null ? 'missing' : 'approximate',
        input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output,
        cache_read_input_tokens: usage.cacheRead, cache_write_input_tokens: usage.cacheWrite,
        // The aggregate storage uses the completed bucket as the denominator for its averages.
        status: 'completed',
        model_usage: [...usage.models.values()].filter(row => row.model || row.input_tokens || row.output_tokens),
      });
    }
    this.threads.clear();
    this.parents.clear();
    return summaries;
  }

  private addClaude(group: ThreadCandidate, source: SourceOrder, responses: readonly ThreadResponse[]): void {
    // [Winner 정책] 세션·응답·요청 조합마다 비교 결과가 더 좋은 Claude 응답 하나만 남긴다.
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
      // [Winner 정책] 같은 메시지 ID에 확인된 요청 ID가 하나일 때만 요청 ID 없는 후보와 비교한다.
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
  // [Winner 정책] 동점은 스레드 그룹, 원본, 행 순으로 나중 후보를 택하며 그룹 안에서 대표 원본을 마지막에 둔다.
  if (candidate.group !== previous.group) return candidate.group.order > previous.group.order;
  if (candidate.source !== previous.source)
    return (candidate.source.copyOrder ?? Infinity) > (previous.source.copyOrder ?? Infinity);
  return (candidate.response.order ?? 0) > (previous.response.order ?? 0);
}

function mergeCodexResponses(target: CodexResponses, responses: readonly ThreadResponse[], preferred: boolean,
  hasPrevious: boolean, intervals: readonly (ThreadCheckpointInterval & { responseKeys: string[] })[]): void {
  // [Winner 정책] 동점 판별용 대표 원본 키는 처음 복사본을 비교할 때부터 따로 관리한다.
  if (hasPrevious) {
    if (preferred) target.canonicalKeys = new Set();
    else target.canonicalKeys ??= new Set(target.winners.keys());
  }
  const { winners, canonicalKeys } = target;
  let intervalIndex = 0;
  for (let responseIndex = 0; responseIndex < responses.length; responseIndex++) {
    const response = responses[responseIndex];
    const key = responseKey(response), prior = winners.get(key);
    // [집계 정책] 대표 원본의 응답 키를 누계 구간에 붙이고 인접한 두 구간의 경계 키는 공유한다.
    for (let interval = intervals[intervalIndex]; interval && interval.start.responseIndex <= responseIndex; interval = intervals[++intervalIndex]) {
      interval.responseKeys.push(key);
      if (interval.end.responseIndex > responseIndex) break;
    }

    // [Winner 정책] 입력+출력 토큰 합이 큰 응답을 택하고 동점이면 대표 원본을 우선한다.
    if (prior) {
      const score = usageScore(response), previousScore = usageScore(prior);
      if (score < previousScore || score === previousScore && !preferred && canonicalKeys?.has(key)) continue;
    }
    winners.set(key, response);
    if (preferred) canonicalKeys?.add(key);
    else canonicalKeys?.delete(key);
  }
}
