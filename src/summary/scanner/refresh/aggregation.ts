// 준비된 원본 winner를 기존 순서로 최종 집계기에 전달한다.
import { StreamingAggregation, type StreamingAggregateFile, type MemoryAggregateResult } from '../../aggregation/memoryAggregate';
import type { AppliedResponse } from '../../db/appliedResponses';
import type { RefreshContext } from './context';
import { isPreparedFile, sessionKey, type FileState, type PreparedFile, type ScanState } from './state';

type AggregateSource = PreparedFile & { session_id: string };

export interface ScanAggregation extends MemoryAggregateResult {
  appliedResponses: AppliedResponse[];
}

export function collectWinners(context: RefreshContext, names: Map<string, string>): ScanAggregation {
  const { state, collect, check, persistAppliedResponses } = context;
  const sources = state.preparedFiles.filter(file => isAffectedSource(state, file));
  const appliedResponses: AppliedResponse[] = [];
  if (!sources.length) return { summaries: [], orphans: [], appliedResponses };
  sources.sort(compareSourceOrder);
  const inputs: StreamingAggregateFile[] = sources.map(file => {
    const { identity, winners } = file.prepared;
    const sessionName = names.get(sessionKey(file.provider, file.session_id)) ?? identity.sessionName;
    return { id: file.id, provider: file.provider, session_id: file.session_id,
      identity: { ...identity, sessionName, parentRootId: file.prepared.parentRootId },
      evidence: winners.evidence, flags: sourceFlags(state, file) };
  });
  const aggregation = new StreamingAggregation(inputs, collect,
    persistAppliedResponses ? response => { appliedResponses.push(response); } : undefined);
  for (const file of sources) {
    check();
    aggregation.addSource(file.id, file.prepared.winners);
  }
  return { ...aggregation.finish(), appliedResponses };
}

function isAffectedSource(state: ScanState, file: FileState): file is AggregateSource {
  return isPreparedFile(file) && !!file.session_id && state.affected.has(sessionKey(file.provider, file.session_id));
}

function compareSourceOrder(a: FileState, b: FileState): number {
  if (a.selected !== b.selected) return a.selected ? -1 : 1;
  // The stable sort leaves files read outside the selected roots in preparation order.
  if (!a.selected) return 0;
  return Number(b.changed) - Number(a.changed) || a.id - b.id;
}

function sourceFlags(state: ScanState, file: PreparedFile): { rootId: string; flag: string }[] {
  const flags: { rootId: string; flag: string }[] = [];
  if (file.prepared.partialLine)
    flags.push({ rootId: '*', flag: 'partial-line' });
  if (state.missingParents.has(file.id))
    flags.push({ rootId: '*', flag: 'missing-parent-agent' });
  return flags;
}
