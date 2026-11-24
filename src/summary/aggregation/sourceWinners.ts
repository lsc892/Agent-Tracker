// 원본을 읽으면서 응답 키별 winner와 요청·누계·도구의 상태를 접는다.
import type { CheckEvent, ParseEvent, Provider, UsageEvent } from '../types';
import { key, normalizedEvent, SourceEvidence, type SourceEvidenceData } from './sourceEvidence';
import { addTurn, createTurnState, max, type TurnState, type UsageContribution } from './turns';
import { isBetterUsage, usageScore } from './winners';

type WinnerUsage = Pick<UsageEvent, 'responseId' | 'requestId' | 'threadId' | 'turnId' | 'rootId' | 'schema' | 'offset'>
  & UsageContribution;

export interface UsageWinner {
  referenceId: number;
  tokens: UsageContribution['tokens'];
}

export interface WinnerReference extends Omit<WinnerUsage, 'tokens' | 'schema' | 'offset'> {
  later?: UsageWinner[];
}

interface DetailedUsageWinner {
  event: WinnerUsage;
  index: number;
  score: number | bigint;
  // 복사 접두사 뒤에서만 살아남을 수 있는 legacy 후보를 점수 내림차순으로 보존한다.
  later?: DetailedUsageWinner[];
}

interface ParsedUsageWinner extends DetailedUsageWinner {
  event: UsageEvent;
  later?: ParsedUsageWinner[];
}

function snapshotWinner({ event, index, score, later }: ParsedUsageWinner): DetailedUsageWinner {
  const { responseId, requestId, threadId, turnId, rootId, schema, offset, model, billingMode } = event;
  const { input, output, cacheRead, cacheWrite } = event.tokens;
  const winner: DetailedUsageWinner = {
    event: { responseId, requestId, threadId, turnId, rootId, schema, offset, model, billingMode,
      tokens: { input, output, cacheRead, cacheWrite } },
    index, score,
  };
  if (later) winner.later = later.map(snapshotWinner);
  return winner;
}

function referenceWinner({ event, index, later }: DetailedUsageWinner, references: Map<number, WinnerReference>): UsageWinner {
  const { responseId, requestId, threadId, turnId, rootId, model, billingMode } = event;
  const reference: WinnerReference = { responseId, requestId, threadId, turnId, rootId, model, billingMode };
  references.set(index, reference);
  if (later) reference.later = later.map(winner => referenceWinner(winner, references));
  const { input, output, cacheRead, cacheWrite } = event.tokens;
  return { referenceId: index, tokens: { input, output, cacheRead, cacheWrite } };
}

export interface ReferencedWinners {
  winners: readonly UsageWinner[];
  references: ReadonlyMap<number, WinnerReference>;
}

export function referenceWinners(entries: Iterable<DetailedUsageWinner>): ReferencedWinners {
  const references = new Map<number, WinnerReference>();
  const winners = Array.from(entries, winner => referenceWinner(winner, references));
  return { winners, references };
}

export interface SourceCheck extends Omit<CheckEvent, 'kind' | 'rootId'> { index: number }
type Capability = Extract<ParseEvent, { kind: 'capability' }>;
interface SourceRoot {
  rootId: string;
  usageOffset: number | null;
  checkOffset: number | null;
  turns: Map<boolean, TurnState>;
  checks: Map<string, SourceCheck>;
  capabilities: Map<string, { event: Capability; positions: { index: number; offset: number }[] }>;
}

interface SourceState {
  evidence: SourceEvidenceData;
  roots: Map<string, SourceRoot>;
}

export interface SourceWinnersSnapshot extends SourceState, ReferencedWinners {}

export interface DetailedSourceWinnersSnapshot extends SourceState {
  winners: readonly DetailedUsageWinner[];
}

export class SourceWinners {
  readonly evidence = new SourceEvidence();
  readonly roots = new Map<string, SourceRoot>();
  private readonly winners = new Map<string, ParsedUsageWinner>();

  constructor(private readonly provider: Provider) {}

  snapshot(): DetailedSourceWinnersSnapshot {
    return { evidence: this.evidence, roots: this.roots, winners: Array.from(this.selected(), snapshotWinner) };
  }

  preparedSnapshot(): SourceWinnersSnapshot {
    return { evidence: this.evidence, roots: this.roots, ...referenceWinners(this.selected()) };
  }

  private *selected(): IterableIterator<ParsedUsageWinner> {
    for (const winner of this.winners.values()) {
      if (!this.evidence.current || winner.event.schema !== 'legacy') yield winner;
    }
  }

  values(): IterableIterator<ParsedUsageWinner> { return this.winners.values(); }

  private addUsage(event: UsageEvent, index: number): void {
    const legacy = event.schema === 'legacy';
    const id = key(event.responseId, this.provider === 'claude' ? event.requestId : event.threadId,
      this.provider === 'claude' ? '' : event.turnId, event.schema, legacy ? event.rootId : undefined);
    const score = usageScore(event), previous = this.winners.get(id);
    if (!previous) { this.winners.set(id, { event: { ...event }, index, score }); return; }
    if (isBetterUsage(score, index, previous.score, previous.index)) {
      for (const field of Object.keys(previous.event)) if (!Object.hasOwn(event, field)) Reflect.deleteProperty(previous.event, field);
      Object.assign(previous.event, event);
      previous.index = index;
      previous.score = score;
      delete previous.later;
    } else if (legacy) {
      const later = previous.later ??= [];
      while (later.length && isBetterUsage(score, index, later.at(-1)!.score, later.at(-1)!.index)) later.pop();
      later.push({ event, index, score });
    }
  }

  add(raw: ParseEvent, index: number): void {
    const event = normalizedEvent(raw);
    this.evidence.add(event, index);
    if (event.kind === 'usage' && event.schema === 'legacy') {
      this.addUsage(event, index);
      return;
    }
    let root = this.roots.get(event.rootId);
    if (!root) {
      root = { rootId: event.rootId, usageOffset: null, checkOffset: null,
        turns: new Map(), checks: new Map(), capabilities: new Map() };
      this.roots.set(event.rootId, root);
    }
    switch (event.kind) {
      case 'usage':
        root.usageOffset = root.usageOffset === null ? event.offset : Math.min(root.usageOffset, event.offset);
        this.addUsage(event, index);
        return;
      case 'turn': {
        let state = root.turns.get(event.isMain);
        if (!state) root.turns.set(event.isMain, state = createTurnState());
        addTurn(state, event, index);
        if (event.status !== undefined) state.outcome = { event, ordinal: index,
          orderingAt: max(state.outcome?.orderingAt ?? null, event.statusAt) };
        return;
      }
      case 'check': {
        const { threadId, turnId, offset, input, output } = event;
        root.checkOffset = root.checkOffset === null ? offset : Math.min(root.checkOffset, offset);
        const id = key(threadId, turnId), previous = root.checks.get(id);
        if (!previous) root.checks.set(id, { threadId, turnId, input, output, offset, index });
        else if (index > previous.index) {
          previous.input = input;
          previous.output = output;
          previous.offset = offset;
          previous.index = index;
        }
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
}
