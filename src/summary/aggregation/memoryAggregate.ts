// 단일 읽기에서 남은 원본별 winner를 최종 그룹·요청·모델·진단 값으로 병합한다.
import type { CapabilityEvent, TurnEvent, UsageEvent } from '../types';
import { addFlag, eligible, key, prepareSources,
  type SourcePlan, type StreamingAggregateFile } from './sourceEvidence';
import { addCapability, addWinner, createRoot, materialize, max, mergeTurn,
  type MemoryAggregateResult, type Outcome, type Root } from './turns';
import { Winners, type Winner } from './winners';
import type { SourceCheck, SourceWinnersSnapshot } from './sourceWinners';

export type { StreamingAggregateFile } from './sourceEvidence';
export type { MaterializedTurnSummary, MemoryAggregateResult } from './turns';

/** 같은 읽기에서 모은 귀속 근거와 원본별 winner를 최종 세션·요청 그룹으로 병합한다. */
export class StreamingAggregation {
  private readonly sources = new Map<number, SourcePlan>();
  private readonly requests: Map<string, string | null>;
  private readonly sessions = new Map<string, SourcePlan[]>();
  private readonly roots = new Map<string, Root>();
  private readonly winners = new Winners((winner, direction) => this.applyWinner(winner, direction));
  private readonly totals = new Map<string, { input: number; output: number }>();
  private readonly missingRequests = new Map<string, { source: SourcePlan; rootId: string; count: number }>();
  private readonly checks = new Map<string, { source: SourcePlan; rootId: string; input: number; output: number; ordinal: number }>();
  private readonly capabilities = new Set<string>();

  constructor(files: readonly StreamingAggregateFile[], private readonly collectCapabilities = true) {
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

  /** 읽는 동안 접은 요청 상태를 한 번 병합하고 남은 winner만 바로 합계에 반영한다. */
  addSource(fileId: number, prepared: SourceWinnersSnapshot): void {
    const source = this.sources.get(fileId)!, file = source.file;
    const parentRootId = file.identity.parentRootId;
    const outcomes = new Map<string, Outcome>();
    for (const state of prepared.roots.values()) {
      const inherited = source.inheritedRoots.has(state.rootId);
      const rootId = parentRootId ?? state.rootId;
      if (!inherited) {
        if (state.usageOffset !== null) this.observeRequest(file, rootId, state.usageOffset);
        if (!file.evidence.current) for (const observed of state.legacy)
          if (observed.index > source.legacyCutoff) this.observeRequest(file, rootId, observed.offset);
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
    for (const { event, index, score } of prepared.winners.values()) this.recordUsage(source, event, index, score);
  }

  private recordUsage(source: SourcePlan, raw: UsageEvent, index: number, score: number | bigint): void {
    if (!eligible(source, raw, index)) return;
    const parentRootId = source.file.identity.parentRootId;
    const event = parentRootId && parentRootId !== raw.rootId ? { ...raw, rootId: parentRootId } : raw;
    const file = source.file, ordinal = source.base + index;
    this.observeRequest(file, event.rootId, event.offset);
    const request = file.provider === 'claude' && event.requestId === null
      ? this.requests.get(key(file.session_id, event.responseId)) ?? null : event.requestId;
    const id = key(file.provider, file.session_id, event.responseId,
      file.provider === 'claude' ? request ?? 'no-req' : event.threadId, file.provider === 'claude' ? '' : event.turnId);
    this.winners.add(id, source, event, ordinal, request, score);
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

  finish(): MemoryAggregateResult {
    for (const { source, rootId, count } of this.missingRequests.values())
      if (count > 0) addFlag(source.flags, rootId, 'missing-request-id');
    for (const [id, { source, rootId, input, output }] of this.checks) {
      const sum = this.totals.get(id);
      if (input !== (sum?.input ?? 0) || output !== (sum?.output ?? 0)) addFlag(source.flags, rootId, 'token-total-mismatch');
    }
    return materialize(this.roots.values(), this.sessions, this.collectCapabilities);
  }

  private applyWinner(winner: Winner, direction: 1 | -1): void {
    const { source, event, request } = winner, file = source.file;
    addWinner(this.roots.get(key(file.provider, file.session_id, event.rootId))!, winner, this.collectCapabilities, direction);
    const id = key(file.provider, file.session_id, event.threadId, event.turnId);
    let sum = this.totals.get(id);
    if (!sum) this.totals.set(id, sum = { input: 0, output: 0 });
    sum.input += direction * event.tokens.input; sum.output += direction * event.tokens.output;
    if (file.provider === 'claude' && request === null) {
      const id = key(file.id, event.rootId);
      let missing = this.missingRequests.get(id);
      if (!missing) this.missingRequests.set(id, missing = { source, rootId: event.rootId, count: 0 });
      missing.count += direction;
    }
  }
}
