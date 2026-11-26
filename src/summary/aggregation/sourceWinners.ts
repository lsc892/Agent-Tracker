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
  // [DTO 정책] 파일 winner와 대체 후보에서 비교·귀속·토큰 집계에 쓰는 필드만 복사한다.
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
  // [DTO 정책] 이벤트 인덱스로 메타데이터와 토큰을 연결하고 대체 후보에도 같은 구조를 적용한다.
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
  // [DTO 정책] 후보 순서를 유지하며 모든 메타데이터를 하나의 참조 Map에 모은다.
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
    // [DTO 정책] 파일의 귀속 근거와 요청 상태에 상세 winner 목록을 묶는다.
    return { evidence: this.evidence, roots: this.roots, winners: Array.from(this.selected(), snapshotWinner) };
  }

  preparedSnapshot(): SourceWinnersSnapshot {
    // [DTO 정책] 파일의 귀속 근거와 요청 상태에 인덱스로 연결된 winner 목록과 참조를 묶는다.
    return { evidence: this.evidence, roots: this.roots, ...referenceWinners(this.selected()) };
  }

  private *selected(): IterableIterator<ParsedUsageWinner> {
    // [Winner 정책] 현행 포맷 사용량이 하나라도 있는 파일은 레거시 winner를 제외한다.
    for (const winner of this.winners.values()) {
      if (!this.evidence.current || winner.event.schema !== 'legacy') yield winner;
    }
  }

  values(): IterableIterator<ParsedUsageWinner> { return this.winners.values(); }

  private addUsage(event: UsageEvent, index: number): void {
    // [Winner 정책] 응답·포맷에 Claude 요청 ID 또는 Codex 스레드·턴 ID를 더하고 레거시는 루트 요청도 구분한다.
    const legacy = event.schema === 'legacy';
    const id = key(event.responseId, this.provider === 'claude' ? event.requestId : event.threadId,
      this.provider === 'claude' ? '' : event.turnId, event.schema, legacy ? event.rootId : undefined);

    // [Winner 정책] 토큰 점수·이벤트 순서에서 이긴 후보로 교체하되 키가 처음 등록된 순서를 유지한다.
    const score = usageScore(event), previous = this.winners.get(id);
    if (!previous) { this.winners.set(id, { event: { ...event }, index, score }); return; }
    if (isBetterUsage(score, index, previous.score, previous.index)) {
      for (const field of Object.keys(previous.event)) if (!Object.hasOwn(event, field)) Reflect.deleteProperty(previous.event, field);
      Object.assign(previous.event, event);
      previous.index = index;
      previous.score = score;
      delete previous.later;
    } else if (legacy) {
      // [Winner 정책] 복사 구간 뒤에 남을 대체 후보를 쌓고 새 후보에 밀리는 앞 후보는 제거한다.
      const later = previous.later ??= [];
      while (later.length && isBetterUsage(score, index, later.at(-1)!.score, later.at(-1)!.index)) later.pop();
      later.push({ event, index, score });
    }
  }

  add(raw: ParseEvent, index: number): void {
    // [파싱 정책] 문자열을 정규화하고 같은 순회에서 포맷·계보·진단 근거를 수집한다.
    const event = normalizedEvent(raw);
    this.evidence.add(event, index);

    // [귀속 정책] 레거시 사용량은 복사 여부가 정해질 때까지 winner 후보로만 보관한다.
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
        // [Winner 정책] 요청의 최소 사용량 위치를 남기고 토큰 후보는 파일 내 응답 키로 비교한다.
        root.usageOffset = root.usageOffset === null ? event.offset : Math.min(root.usageOffset, event.offset);
        this.addUsage(event, index);
        return;
      case 'turn': {
        // [집계 정책] 메인 여부별로 상태를 합치고 상태 이벤트는 마지막 관측값과 최대 시각을 함께 보관한다.
        let state = root.turns.get(event.isMain);
        if (!state) root.turns.set(event.isMain, state = createTurnState());
        addTurn(state, event, index);
        if (event.status !== undefined) state.outcome = { event, ordinal: index,
          orderingAt: max(state.outcome?.orderingAt ?? null, event.statusAt) };
        return;
      }
      case 'check': {
        // [진단 정책] 요청의 최소 검사 위치와 스레드·턴별 최신 누계값을 따로 보존한다.
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
        // [집계 정책] 도구 이벤트별로 위치를 모으고 뒤 이벤트의 오프셋이 같거나 더 작으면 앞 위치를 버린다.
        const id = key(event.threadId, event.eventId, event.category, event.name);
        let previous = root.capabilities.get(id);
        if (!previous) root.capabilities.set(id, previous = { event, positions: [] });
        while (previous.positions.length && previous.positions.at(-1)!.offset >= event.offset) previous.positions.pop();
        previous.positions.push({ index, offset: event.offset });
      }
    }
  }
}
