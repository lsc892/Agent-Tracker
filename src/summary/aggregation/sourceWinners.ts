// 읽는 동안 요청 상태·최신 검증·도구 중복·usage winner를 함께 누적한다.
import type { ParseEvent, Provider, UsageEvent } from '../types';
import { key, normalizedEvent, SourceEvidence } from './sourceEvidence';
import { addTurn, createTurnState, max, type TurnState } from './turns';
import { usageScore } from './winners';

export interface Candidate { event: UsageEvent; index: number; score: number | bigint }
interface Indexed<E> { event: E; index: number }
type Check = Extract<ParseEvent, { kind: 'check' }>;
type Capability = Extract<ParseEvent, { kind: 'capability' }>;
export interface SourceRoot {
  rootId: string;
  checkOffset: number | null;
  usageOffset: number | null;
  // Fork 접두사는 다른 파일을 확인한 뒤 정해지므로 legacy 위치만 경계별로 남긴다.
  legacy: { index: number; offset: number }[];
  turns: Map<boolean, TurnState>;
  checks: Map<string, Indexed<Check>>;
  capabilities: Map<string, { event: Capability; positions: { index: number; offset: number }[] }>;
}
export interface SourceWinnersSnapshot {
  evidence: Omit<SourceEvidence, 'add' | 'child'>;
  roots: Map<string, SourceRoot>;
  winners: Map<string, Candidate>;
}

/** 원문과 metadata 이벤트 목록을 보관하지 않고 요청별 상태와 winner만 전달한다. */
export class SourceWinners {
  readonly evidence: SourceEvidence;
  readonly roots: Map<string, SourceRoot>;
  private readonly winners: Map<string, Candidate>;

  constructor(private readonly provider: Provider, snapshot?: SourceWinnersSnapshot) {
    this.evidence = snapshot ? Object.assign(new SourceEvidence(), snapshot.evidence) : new SourceEvidence();
    this.roots = snapshot?.roots ?? new Map();
    this.winners = snapshot?.winners ?? new Map();
  }

  snapshot(): SourceWinnersSnapshot { return { evidence: this.evidence, roots: this.roots, winners: this.winners }; }

  add(raw: ParseEvent, index: number): void {
    const event = normalizedEvent(raw);
    this.evidence.add(event, index);
    let root = this.roots.get(event.rootId);
    if (!root) {
      root = { rootId: event.rootId, checkOffset: null, usageOffset: null, legacy: [],
        turns: new Map(), checks: new Map(), capabilities: new Map() };
      this.roots.set(event.rootId, root);
    }
    if (event.kind === 'usage') {
      if (event.schema === 'legacy') root.legacy.push({ index, offset: event.offset });
      else root.usageOffset = root.usageOffset === null ? event.offset : Math.min(root.usageOffset, event.offset);
      const id = key(event.responseId, this.provider === 'claude' ? event.requestId : event.threadId,
        this.provider === 'claude' ? '' : event.turnId, event.schema);
      const score = usageScore(event), previous = this.winners.get(id);
      if (!previous) { this.winners.set(id, { event: { ...event }, index, score }); return; }
      if (score < previous.score || score === previous.score && index <= previous.index) return;
      for (const field of Object.keys(previous.event)) if (!Object.hasOwn(event, field)) Reflect.deleteProperty(previous.event, field);
      Object.assign(previous.event, event);
      previous.index = index; previous.score = score;
      return;
    }
    switch (event.kind) {
      case 'turn': {
        let state = root.turns.get(event.isMain);
        if (!state) root.turns.set(event.isMain, state = createTurnState());
        addTurn(state, event, index);
        if (event.status !== undefined) state.outcome = { event, ordinal: index,
          orderingAt: max(state.outcome?.orderingAt ?? null, event.statusAt) };
        return;
      }
      case 'check': {
        root.checkOffset = root.checkOffset === null ? event.offset : Math.min(root.checkOffset, event.offset);
        const id = key(event.threadId, event.turnId), previous = root.checks.get(id);
        if (!previous || index > previous.index) root.checks.set(id, { event, index });
        return;
      }
      case 'capability': {
        const id = key(event.threadId, event.eventId, event.category, event.name);
        let previous = root.capabilities.get(id);
        if (!previous) root.capabilities.set(id, previous = { event, positions: [] });
        // 이후 cutoff에서 최소 offset을 정할 수 없는 이전 위치만 버린다.
        while (previous.positions.length && previous.positions.at(-1)!.offset >= event.offset) previous.positions.pop();
        previous.positions.push({ index, offset: event.offset });
      }
    }
  }

  values(): IterableIterator<Candidate> { return this.winners.values(); }
}
