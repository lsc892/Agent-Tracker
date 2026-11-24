// 파일별 winner를 요청·모델·진단 값에 반영한다.
import type { AppliedResponse } from '../db/appliedResponses';
import type { CapabilityEvent, TurnEvent } from '../types';
import { addFlag, eligible, eligibleWinner, key, prepareSources,
  type SourcePlan, type StreamingAggregateFile } from './sourceEvidence';
import { addCapability, addUsage, createRoot, materialize, max, mergeTurn,
  type MemoryAggregateResult, type Outcome, type Root } from './turns';
import { referenceWinners, type DetailedSourceWinnersSnapshot, type ReferencedWinners,
  type SourceCheck, type SourceWinnersSnapshot, type UsageWinner, type WinnerReference } from './sourceWinners';
import { isBetterUsage, usageScore } from './winners';

export type { StreamingAggregateFile } from './sourceEvidence';
export type { MaterializedTurnSummary, MemoryAggregateResult } from './turns';

interface UsageSource extends SourcePlan { usage?: ReferencedWinners }

interface SelectedWinner {
  source: SourcePlan;
  root: Root;
  reference: WinnerReference;
  tokens: UsageWinner['tokens'];
  responseKey: string;
  request: string | null;
  score: number | bigint;
  ordinal: number;
  position: number;
}

/** 파일별 winner를 세션의 응답 키 순서로 합쳐 집계한다. */
export class StreamingAggregation {
  private readonly sources = new Map<number, UsageSource>();
  private readonly requests: Map<string, string | null>;
  private readonly sessions = new Map<string, UsageSource[]>();
  private readonly roots = new Map<string, Root>();
  private readonly totals = new Map<string, { input: number; output: number }>();
  private readonly checks = new Map<string, { source: SourcePlan; rootId: string; input: number; output: number; ordinal: number }>();
  private readonly capabilities = new Set<string>();

  constructor(files: readonly StreamingAggregateFile[], private readonly collectCapabilities = true,
    private readonly onApplied?: (response: AppliedResponse) => void) {
    const prepared = prepareSources(files);
    this.requests = prepared.requests;
    for (const source of prepared.sources) {
      this.sources.set(source.file.id, source);
      const id = key(source.file.provider, source.file.session_id);
      let files = this.sessions.get(id);
      if (!files) this.sessions.set(id, files = []);
      files.push(source);
    }
    for (const files of this.sessions.values()) files.sort((a, b) => a.file.id - b.file.id);
  }

  /** 파싱 중 접은 요청 상태와 파일별 winner를 등록한다. */
  addSource(fileId: number, prepared: SourceWinnersSnapshot | DetailedSourceWinnersSnapshot): void {
    const source = this.sources.get(fileId)!, file = source.file;
    const parentRootId = file.identity.parentRootId;
    const outcomes = new Map<string, Outcome>();
    for (const state of prepared.roots.values()) {
      const inherited = source.inheritedRoots.has(state.rootId);
      const rootId = parentRootId ?? state.rootId;
      if (!inherited) {
        if (state.usageOffset !== null) this.observeRequest(file, parentRootId || state.rootId, state.usageOffset);
        if (state.checkOffset !== null) this.observeRequest(file, rootId, state.checkOffset);
        for (const [isMain, turn] of state.turns) {
          if (!file.identity.isMain && !file.identity.standaloneSubagent) continue;
          const target = this.observeRequest(file, rootId, turn.offset);
          if (!isMain && !file.identity.standaloneSubagent) continue;
          mergeTurn(target, turn, source.base);
          if (turn.outcome) this.recordOutcome(outcomes, target, turn.outcome.event,
            source.base + turn.outcome.ordinal, turn.outcome.orderingAt);
        }
        const checkRootId = parentRootId || state.rootId;
        for (const check of state.checks.values()) {
          // The folded offset already covers each check when both target the same root.
          if (checkRootId !== rootId || state.checkOffset === null) this.observeRequest(file, checkRootId, check.offset);
          this.recordCheck(source, checkRootId, check);
        }
      }
      for (const { event, positions } of state.capabilities.values()) {
        for (const position of positions) {
          if (!eligible(source, event, position.index)) continue;
          const observed = this.observeRequest(file, rootId, position.offset);
          // An empty parent ID preserves the original event's target.
          const capabilityRootId = parentRootId || event.rootId;
          const root = capabilityRootId === rootId ? observed : this.observeRequest(file, capabilityRootId, position.offset);
          this.recordCapability(root, event);
          break;
        }
      }
    }
    if (!file.evidence.current) {
      for (const { rootId, index, offset } of file.evidence.legacy) {
        if (index > source.legacyCutoff && !source.inheritedRoots.has(rootId))
          this.observeRequest(file, parentRootId || rootId, offset);
      }
    }
    const { winners, references } = 'references' in prepared ? prepared : referenceWinners(prepared.winners);
    source.usage = { winners, references };
  }

  private selectUsage(source: SourcePlan, winner: UsageWinner, reference: WinnerReference, position: number): SelectedWinner {
    const { file } = source, { rootId, requestId, responseId, threadId, turnId } = reference;
    // addSource already registered every eligible usage's request and diagnostic offset.
    const root = this.roots.get(key(file.provider, file.session_id, file.identity.parentRootId || rootId))!;
    const request = file.provider === 'claude' && requestId === null
      ? this.requests.get(key(file.session_id, responseId)) ?? null : requestId;
    const responseKey = file.provider === 'claude' ? key(responseId, request ?? 'no-req') : key(responseId, threadId, turnId);
    return { source, root, reference, tokens: winner.tokens, responseKey, request,
      score: usageScore(winner), ordinal: source.base + winner.referenceId, position };
  }

  private applySessionUsage(sources: readonly UsageSource[]): void {
    const candidates: SelectedWinner[] = [];
    for (const source of sources.slice().sort((a, b) => a.base - b.base)) {
      if (!source.usage) continue;
      const { winners, references } = source.usage;
      for (const entry of winners) {
        const reference = references.get(entry.referenceId)!;
        if (eligibleWinner(source, reference.rootId, entry.referenceId)) {
          candidates.push(this.selectUsage(source, entry, reference, candidates.length));
          continue;
        }
        const winner = reference.later?.find(item => eligibleWinner(source, references.get(item.referenceId)!.rootId, item.referenceId));
        if (winner) candidates.push(this.selectUsage(source, winner, references.get(winner.referenceId)!, candidates.length));
      }
      source.usage = undefined;
    }
    candidates.sort((a, b) => a.responseKey < b.responseKey ? -1 : Number(a.responseKey > b.responseKey));
    // 그룹에서 처음 본 위치를 보존해 요청별 반영과 진단 순서를 유지한다.
    const selected: (SelectedWinner | undefined)[] = [];
    for (let index = 0; index < candidates.length;) {
      const first = candidates[index++];
      let winner = first;
      while (index < candidates.length && candidates[index].responseKey === first.responseKey) {
        const candidate = candidates[index++];
        if (isBetterUsage(candidate.score, candidate.ordinal, winner.score, winner.ordinal)) winner = candidate;
      }
      selected[first.position] = winner;
    }
    for (const winner of selected) if (winner) this.applyUsage(winner);
  }

  private recordCapability(root: Root, event: CapabilityEvent): void {
    if (!this.collectCapabilities) return;
    const id = key(root.provider, root.session, root.rootId, event.threadId, event.eventId, event.category, event.name);
    if (!this.capabilities.has(id)) { this.capabilities.add(id); addCapability(root, event.category, event.name); }
  }

  private recordCheck(source: SourcePlan, rootId: string, check: SourceCheck): void {
    const { file } = source, ordinal = source.base + check.index;
    const id = key(file.provider, file.session_id, check.threadId, check.turnId), previous = this.checks.get(id);
    if (!previous || ordinal > previous.ordinal)
      this.checks.set(id, { source, rootId, input: check.input, output: check.output, ordinal });
  }

  private recordOutcome(outcomes: Map<string, Outcome>, root: Root, event: TurnEvent,
    ordinal: number, orderingAt: number | null): void {
    let outcome = outcomes.get(root.rootId);
    if (!outcome) {
      outcome = { event, ordinal, orderingAt };
      outcomes.set(root.rootId, outcome);
    } else {
      outcome.orderingAt = max(outcome.orderingAt, orderingAt);
      if (ordinal > outcome.ordinal) { outcome.event = event; outcome.ordinal = ordinal; }
    }
    const before = root.outcome;
    if (!before || outcome.orderingAt !== null && (before.orderingAt === null || outcome.orderingAt > before.orderingAt)
      || outcome.orderingAt === before.orderingAt && outcome.ordinal > before.ordinal) root.outcome = outcome;
  }

  private observeRequest(file: StreamingAggregateFile, rootId: string, offset: number): Root {
    const id = key(file.provider, file.session_id, rootId);
    let root = this.roots.get(id);
    if (!root) this.roots.set(id, root = createRoot(file, rootId, offset));
    if (file.id < root.firstFile.id) root.firstFile = file;
    root.offset = Math.min(root.offset, offset); root.hasMain ||= file.identity.isMain;
    return root;
  }

  finish(check?: () => void): MemoryAggregateResult {
    for (const sources of this.sessions.values()) {
      check?.();
      this.applySessionUsage(sources);
    }
    for (const [id, { source, rootId, input, output }] of this.checks) {
      const sum = this.totals.get(id);
      if (input !== (sum?.input ?? 0) || output !== (sum?.output ?? 0)) addFlag(source.flags, rootId, 'token-total-mismatch');
    }
    return materialize(this.roots.values(), this.sessions, this.collectCapabilities);
  }

  private applyUsage({ source, root, reference, tokens, responseKey, request }: SelectedWinner): void {
    const { file } = source, { model, billingMode, threadId, turnId } = reference;
    addUsage(root, { model, billingMode, tokens }, this.collectCapabilities);
    this.onApplied?.({ provider: file.provider, sessionId: file.session_id, rootId: root.rootId, responseKey, tokens });
    const id = key(file.provider, file.session_id, threadId, turnId);
    let sum = this.totals.get(id);
    if (!sum) this.totals.set(id, sum = { input: 0, output: 0 });
    sum.input += tokens.input; sum.output += tokens.output;
    if (file.provider === 'claude' && request === null) addFlag(source.flags, root.rootId, 'missing-request-id');
  }
}
