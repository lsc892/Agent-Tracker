// 준비된 원본 winner를 기존 순서로 최종 집계기에 전달한다.
import { StreamingAggregation, type StreamingAggregateFile, type MemoryAggregateResult } from '../../aggregation/memoryAggregate';
import type { RefreshContext } from './context';
import { sessionKey, type FileState } from './state';

export async function collectWinners(context: RefreshContext, names: Map<string, string>): Promise<MemoryAggregateResult> {
  const { state, collect, check } = context;
  const sources = [...state.files.values()].filter(file => !file.removed && !file.error && file.prepared && file.session)
    .sort((a, b) => a.sequence! - b.sequence!);
  const inputs: StreamingAggregateFile[] = sources.map(file => ({ id: file.id, provider: file.provider, session_id: file.session!,
    identity: { ...file.prepared!.identity, sessionName: names.get(sessionKey(file.provider, file.session!)) ?? file.prepared!.identity.sessionName },
    evidence: file.prepared!.evidence, flags: sourceFlags(context, file) }));
  const aggregation = new StreamingAggregation(inputs, collect);
  for (const file of sources) {
    check();
    aggregation.addSource(file.id, file.prepared!.winners);
  }
  return aggregation.finish();
}

function sourceFlags(context: RefreshContext, file: FileState): { rootId: string; flag: string }[] {
  const flags: { rootId: string; flag: string }[] = [];
  if (file.prepared?.partialLine)
    flags.push({ rootId: '*', flag: 'partial-line' });
  if (file.prepared?.identity.standaloneSubagent)
    flags.push({ rootId: '*', flag: 'standalone-subagent' });
  if (context.state.missingParents.has(file.id))
    flags.push({ rootId: '*', flag: 'missing-parent-agent' });
  return flags;
}
