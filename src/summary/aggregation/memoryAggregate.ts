// 단일 읽기에서 남은 원본별 winner를 최종 그룹·요청·모델·진단 값으로 병합한다.
import type { ParseEvent } from '../types';
import { addFlag, eligible, key, normalizedEvent, prepareSources,
  type SourcePlan, type StreamingAggregateFile } from './sourceEvidence';
import { addCapability, addTurn, addWinner, createRoot, materialize, max,
  type MemoryAggregateResult, type Outcome, type Root } from './turns';
import { Winners, type Winner } from './winners';
import type { ObservedRoot } from './sourceWinners';

export { SourceEvidence } from './sourceEvidence';
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
  private readonly checks = new Map<string, { source: SourcePlan; event: Extract<ParseEvent, { kind: 'check' }>; ordinal: number }>();
  private readonly sourceOutcomes = new Map<string, { root: Root; outcome: Outcome }>();
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

  add(fileId: number, raw: ParseEvent, index: number): void {
    const source = this.sources.get(fileId);
    if (!source) throw new Error('Unknown streaming source');
    let event = normalizedEvent(raw);
    if (!eligible(source, event, index)) return;
    if (event.kind === 'turn' && !source.file.identity.isMain && !source.file.identity.standaloneSubagent) return;
    if (source.file.identity.parentRootId) event = { ...event, rootId: source.file.identity.parentRootId };
    const file = source.file, ordinal = source.base + index;
    const root = this.observeRequest(file, event.rootId, event.offset);
    switch (event.kind) {
      case 'turn': {
        if (!event.isMain && !file.identity.standaloneSubagent) return;
        addTurn(root, event);
        if (event.status === undefined) return;
        const id = key(file.id, event.rootId), before = this.sourceOutcomes.get(id)?.outcome;
        this.sourceOutcomes.set(id, { root, outcome: { event, ordinal, orderingAt: max(before?.orderingAt ?? null, event.statusAt) } });
        return;
      }
      case 'usage': {
        const request = file.provider === 'claude' && event.requestId === null
          ? this.requests.get(key(file.session_id, event.responseId)) ?? null : event.requestId;
        const id = key(file.provider, file.session_id, event.responseId,
          file.provider === 'claude' ? request ?? 'no-req' : event.threadId, file.provider === 'claude' ? '' : event.turnId);
        this.winners.add(id, source, event, ordinal, request);
        return;
      }
      case 'check': {
        const id = key(file.provider, file.session_id, event.threadId, event.turnId), previous = this.checks.get(id);
        if (!previous || ordinal > previous.ordinal) this.checks.set(id, { source, event, ordinal });
        return;
      }
      case 'capability': {
        if (!this.collectCapabilities) return;
        const id = key(file.provider, file.session_id, event.rootId, event.threadId, event.eventId, event.category, event.name);
        if (!this.capabilities.has(id)) { this.capabilities.add(id); addCapability(root, event.category, event.name); }
      }
    }
  }

  /** 패자의 숫자 DTO 없이도 기존 root·최소 진단 위치를 보존한다. */
  observeRoot(fileId: number, observed: ObservedRoot): void {
    const source = this.sources.get(fileId);
    if (!source) throw new Error('Unknown streaming source');
    const event = { kind: 'usage', rootId: observed.rootId, schema: observed.schema } as ParseEvent;
    if (!eligible(source, event, observed.index)) return;
    const file = source.file, rootId = file.identity.parentRootId ?? observed.rootId;
    this.observeRequest(file, rootId, observed.offset);
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
    for (const { root, outcome } of this.sourceOutcomes.values()) {
      const before = root.outcome;
      if (!before || outcome.orderingAt !== null && (before.orderingAt === null || outcome.orderingAt > before.orderingAt)
        || outcome.orderingAt === before.orderingAt && outcome.ordinal > before.ordinal) root.outcome = outcome;
    }
    for (const { source, rootId, count } of this.missingRequests.values())
      if (count > 0) addFlag(source.flags, rootId, 'missing-request-id');
    for (const [id, { source, event }] of this.checks) {
      const sum = this.totals.get(id);
      if (event.tokens.input !== (sum?.input ?? 0) || event.tokens.output !== (sum?.output ?? 0)) addFlag(source.flags, event.rootId, 'token-total-mismatch');
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
