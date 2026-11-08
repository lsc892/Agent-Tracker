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

  add(id: string, source: SourcePlan, event: UsageEvent, ordinal: number, request: string | null): void {
    const value = score(event), previous = this.groups.get(id);
    if (!previous) {
      this.groups.set(id, { source, event: { ...event }, ordinal, request, score: value });
      return;
    }
    if (value < previous.score || value === previous.score && ordinal <= previous.ordinal) return;
    for (const name of Object.keys(previous.event)) if (!Object.hasOwn(event, name)) Reflect.deleteProperty(previous.event, name);
    Object.assign(previous.event, event);
    previous.source = source; previous.ordinal = ordinal; previous.request = request; previous.score = value;
  }

  values(): IterableIterator<Winner> { return this.groups.values(); }
}
