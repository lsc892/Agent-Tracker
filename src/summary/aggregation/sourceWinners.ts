// 원본을 한 번 읽는 동안 그룹 winner DTO만 갱신하고 패자의 숫자 벡터를 버린다.
import type { ParseEvent, Provider, UsageEvent } from '../types';
import { key, normalizedEvent, SourceEvidence } from './sourceEvidence';

interface Candidate { event: UsageEvent; index: number; score: number | bigint }
export interface ObservedRoot { rootId: string; offset: number; index: number; schema?: UsageEvent['schema'] }
export interface SourceWinnersSnapshot {
  evidence: Omit<SourceEvidence, 'add' | 'child'>;
  roots: ObservedRoot[];
  winners: Map<string, Candidate>;
  metadata: { event: Exclude<ParseEvent, UsageEvent>; index: number }[];
}

/** 파일의 최종 귀속이 정해지기 전에도 원본별 그룹의 패자 DTO를 보관하지 않는다. */
export class SourceWinners {
  readonly evidence: SourceEvidence;
  readonly roots: ObservedRoot[];
  private readonly winners: Map<string, Candidate>;
  private readonly metadata: { event: Exclude<ParseEvent, UsageEvent>; index: number }[];

  constructor(private readonly provider: Provider, snapshot?: SourceWinnersSnapshot) {
    this.evidence = snapshot ? Object.assign(new SourceEvidence(), snapshot.evidence) : new SourceEvidence();
    this.roots = snapshot?.roots ?? [];
    this.winners = snapshot?.winners ?? new Map();
    this.metadata = snapshot?.metadata ?? [];
  }

  /** 원문·패자 DTO 없이 파일별 준비 결과만 Worker 메시지로 전달한다. */
  snapshot(): SourceWinnersSnapshot {
    return { evidence: this.evidence, roots: this.roots, winners: this.winners, metadata: this.metadata };
  }

  add(raw: ParseEvent, index: number): void {
    const event = normalizedEvent(raw);
    this.evidence.add(event, index);
    if (event.kind !== 'usage') { this.metadata.push({ event, index }); return; }
    this.roots.push({ rootId: event.rootId, offset: event.offset, index, schema: event.schema });
    const id = key(event.responseId, this.provider === 'claude' ? event.requestId : event.threadId,
      this.provider === 'claude' ? '' : event.turnId, event.schema);
    const score = Number.isSafeInteger(event.tokens.input + event.tokens.output)
      ? event.tokens.input + event.tokens.output : BigInt(event.tokens.input) + BigInt(event.tokens.output);
    const previous = this.winners.get(id);
    if (!previous) { this.winners.set(id, { event: { ...event }, index, score }); return; }
    if (score < previous.score || score === previous.score && index <= previous.index) return;
    for (const field of Object.keys(previous.event)) if (!Object.hasOwn(event, field)) Reflect.deleteProperty(previous.event, field);
    Object.assign(previous.event, event);
    previous.index = index; previous.score = score;
  }

  *events(): IterableIterator<{ event: ParseEvent; index: number }> {
    yield* [...this.metadata, ...this.winners.values()].sort((a, b) => a.index - b.index);
  }
}
