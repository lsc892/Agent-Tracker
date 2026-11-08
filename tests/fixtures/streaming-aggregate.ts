// 합성 이벤트를 제품과 같은 단일 읽기·패자 폐기·최종 그룹 병합 순서로 전달한다.
import { StreamingAggregation, type StreamingAggregateFile } from '../../src/summary/aggregation/memoryAggregate';
import { SourceWinners } from '../../src/summary/aggregation/sourceWinners';
import type { ParseEvent } from '../../src/summary/types';

export interface MemoryAggregateFile extends Omit<StreamingAggregateFile, 'evidence'> { events: readonly ParseEvent[] }

export function aggregateMemory(files: readonly MemoryAggregateFile[], collectCapabilities = true) {
  const selected = files.map(({ events, ...file }) => {
    const winners = new SourceWinners(file.provider);
    events.forEach((event, index) => winners.add(event, index));
    return { ...file, evidence: winners.evidence, winners };
  });
  const aggregation = new StreamingAggregation(selected, collectCapabilities);
  for (const file of selected) {
    for (const root of file.winners.roots) aggregation.observeRoot(file.id, root);
    for (const { event, index } of file.winners.events()) aggregation.add(file.id, event, index);
  }
  return aggregation.finish();
}
