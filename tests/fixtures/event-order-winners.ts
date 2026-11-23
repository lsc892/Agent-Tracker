// 이전 이벤트 순서 기준 집계를 대조하기 위한 winner 교체 구현이다.
import type { SourcePlan } from '../../src/summary/aggregation/sourceEvidence';
import { usageScore } from '../../src/summary/aggregation/winners';
import type { UsageEvent } from '../../src/summary/types';

export interface Winner {
  source: SourcePlan;
  event: UsageEvent;
  ordinal: number;
  request: string | null;
  score: number | bigint;
}

export class Winners {
  private readonly groups = new Map<string, Winner>();

  constructor(private readonly apply?: (winner: Winner, direction: 1 | -1) => void) {}

  add(id: string, source: SourcePlan, event: UsageEvent, ordinal: number, request: string | null, value = usageScore(event)): void {
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
