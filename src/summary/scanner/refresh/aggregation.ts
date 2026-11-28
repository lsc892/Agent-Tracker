// 준비된 파일별 winner를 기존 순서로 최종 집계기에 전달한다.
import { StreamingAggregation, type StreamingAggregateFile, type MemoryAggregateResult } from '../../aggregation/memoryAggregate';
import type { RefreshContext } from './context';
import { isPreparedFile, sessionKey, type FileState, type PreparedFile, type ScanState } from './state';

type AggregateSource = PreparedFile & { session_id: string };

/** 준비된 원본의 응답과 관계 근거로 영향받은 세션의 대화 합계를 만든다. */
export function collectWinners(context: RefreshContext, names: ReadonlyMap<string, string>): MemoryAggregateResult {
  const { state, collect, check } = context;
  const sources = state.preparedFiles.filter((file): file is AggregateSource => isPreparedFile(file) && !!file.session_id);
  if (!sources.length) return { summaries: [], orphans: [] };
  sources.sort(compareSourceOrder);
  // 세션 이름과 부모 요청 정보를 합치고 관계 근거와 진단 플래그를 집계기에 전달한다.
  const inputs: StreamingAggregateFile[] = sources.map(file => {
    const { identity, winners } = file.prepared;
    const sessionName = names.get(sessionKey(file.provider, file.session_id)) ?? identity.sessionName;
    return { id: file.id, provider: file.provider, session_id: file.session_id,
      identity: { ...identity, sessionName, parentRootId: file.prepared.parentRootId },
      evidence: winners.evidence, flags: sourceFlags(state, file) };
  });
  const aggregation = new StreamingAggregation(inputs, collect);
  // 영향받은 세션의 응답만 집계하고 파일별 준비 결과의 참조를 해제한다.
  for (const file of sources) {
    check();
    if (state.affected.has(sessionKey(file.provider, file.session_id))) aggregation.addSource(file.id, file.prepared.winners);
    (file as FileState).prepared = undefined;
  }
  return aggregation.finish(check, true);
}

/** 선택한 루트의 파일을 앞에 두고, 그 안에서는 변경 파일을 우선한 뒤 파일 ID 오름차순으로 정렬한다. */
function compareSourceOrder(a: FileState, b: FileState): number {
  if (a.selected !== b.selected) return a.selected ? -1 : 1;
  // 선택한 루트 밖의 파일은 안정 정렬로 준비 순서를 유지한다.
  if (!a.selected) return 0;
  return Number(b.changed) - Number(a.changed) || a.id - b.id;
}

/** 미완성 행과 부모 미확정 상태를 원본 전체에 적용하는 플래그로 변환한다. */
function sourceFlags(state: ScanState, file: PreparedFile): { rootId: string; flag: string }[] {
  const flags: { rootId: string; flag: string }[] = [];
  if (file.prepared.partialLine)
    flags.push({ rootId: '*', flag: 'partial-line' });
  if (state.missingParents.has(file.id))
    flags.push({ rootId: '*', flag: 'missing-parent-agent' });
  return flags;
}
