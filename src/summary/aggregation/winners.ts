// 그룹마다 winner DTO 한 개만 보유하고 더 좋은 후보의 전체 값을 같은 DTO에 반영한다.
import type { UsageEvent } from '../types';
import type { SourcePlan } from './sourceEvidence';

export interface Winner {
  source: SourcePlan;
  event: UsageEvent;
  ordinal: number;
  request: string | null;
  score: number | bigint;
}

const score = (event: UsageEvent): number | bigint => Number.isSafeInteger(event.tokens.input + event.tokens.output)
  ? event.tokens.input + event.tokens.output : BigInt(event.tokens.input) + BigInt(event.tokens.output);

/** 첫 winner만 생성하고 이후 교체에는 동일한 DTO를 재사용한다. */
export class Winners {
  private readonly groups = new Map<string, Winner>();

  constructor(private readonly apply?: (winner: Winner, direction: 1 | -1) => void) {}

  add(id: string, source: SourcePlan, event: UsageEvent, ordinal: number, request: string | null): void {
    const value = score(event);
    let winner = this.groups.get(id);
    if (winner) {
      if (value < winner.score || value === winner.score && ordinal <= winner.ordinal) return;
      this.apply?.(winner, -1);
      for (const name of Object.keys(winner.event)) if (!Object.hasOwn(event, name)) Reflect.deleteProperty(winner.event, name);
      Object.assign(winner.event, event);
      winner.source = source; winner.ordinal = ordinal; winner.request = request; winner.score = value;
    } else {
      winner = { source, event: { ...event }, ordinal, request, score: value };
      this.groups.set(id, winner);
    }
    this.apply?.(winner, 1);
  }

  values(): IterableIterator<Winner> { return this.groups.values(); }
}
