// 한 번의 읽기에서 토큰 DTO 없이 포맷·복사 접두사·request 귀속 근거를 수집한다.
import { createHash } from 'node:crypto';
import type { ParseEvent, ParsedIdentity, Provider, UsageEvent } from '../types';

export interface StreamingAggregateFile {
  id: number;
  provider: Provider;
  session_id: string;
  identity: ParsedIdentity;
  evidence: SourceEvidenceData;
  flags?: readonly { rootId: string; flag: string }[];
}

export const text = (value: string): string => /[\ud800-\udfff]/.test(value) ? Buffer.from(value).toString('utf8') : value;
export const key = (...values: unknown[]): string => JSON.stringify(values);
export const capabilityKey = (event: Extract<ParseEvent, { kind: 'capability' }>): string =>
  key(event.rootId, event.eventId, event.category, event.name);

/** SQLite TEXT의 UTF-8 변환과 같은 문자열로 맞추되 정상 입력은 복사하지 않는다. */
export function normalizedEvent(event: ParseEvent): ParseEvent {
  // [파싱 정책] 최상위 문자열 필드를 훑고 값이 처음 바뀔 때 이벤트를 얕게 복사한다.
  let result = event;
  const fields = event as ParseEvent & Record<string, unknown>;
  for (const name in fields) {
    if (!Object.hasOwn(fields, name)) continue;
    const value = fields[name];
    if (typeof value !== 'string') continue;
    const normalized = text(value);
    if (normalized === value) continue;
    if (result === event) result = { ...event };
    Reflect.set(result, name, normalized);
  }

  // [진단 정책] 플래그 배열도 값이 바뀌는 경우에만 정규화한 새 배열로 바꾼다.
  if ('flags' in event && event.flags?.some(flag => text(flag) !== flag)) {
    if (result === event) result = { ...event };
    if ('flags' in result) result.flags = event.flags.map(text);
  }
  return result;
}

const legacySignature = (event: UsageEvent): string => createHash('sha256').update(key(event.rootId, event.turnId,
  event.responseId, event.tokens.input, event.tokens.output, event.tokens.cacheRead, event.tokens.cacheWrite,
  event.tokens.reasoning)).digest('hex');

export function addFlag(flags: Map<string, Set<string>>, rootId: string, flag: string): void {
  // [진단 정책] 요청별 Set에 넣어 같은 진단을 한 번만 남긴다.
  let values = flags.get(rootId);
  if (!values) flags.set(rootId, values = new Set());
  values.add(flag);
}

/** 원본을 읽으며 사용량 값 대신 비교·제외 규칙의 작은 근거를 남긴다. */
export class SourceEvidence {
  eventCount = 0;
  current = false;
  legacyPrefix?: UsageEvent['legacyPrefix'];
  readonly flags = new Map<string, Set<string>>();
  readonly legacy: { index: number; rootId: string; signature: string; offset: number; responseId: string }[] = [];
  readonly nonLegacyRoots = new Set<string>();
  readonly startedRoots = new Set<string>();
  readonly capabilities = new Map<string, number>();
  readonly requests = new Map<string, string | null>();
  readonly legacyRequests = new Map<string, string | null>();
  readonly childRequests = new Map<string, string | null>();

  /** 생성 결과의 thread ID·agent path를 호출 당시 부모 요청에 연결한다. */
  child(reference: string, rootId: string): void {
    // [귀속 정책] 자식 식별자에 서로 다른 부모가 관측되면 null로 표시해 귀속을 보류한다.
    reference = text(reference); rootId = text(rootId);
    if (!this.childRequests.has(reference)) this.childRequests.set(reference, rootId);
    else if (this.childRequests.get(reference) !== rootId) this.childRequests.set(reference, null);
  }

  /** 호출자가 원본 수집 경계에서 정규화한 이벤트를 같은 순회에서 관측한다. */
  add(event: ParseEvent, index: number): void {
    // [진단 정책] 원본의 이벤트 순번 범위와 요청별 플래그를 기록한다.
    this.eventCount = Math.max(this.eventCount, index + 1);
    if ('flags' in event) for (const flag of event.flags ?? []) addFlag(this.flags, event.rootId, flag);
    if (event.kind === 'turn' && event.startedAt !== undefined) this.startedRoots.add(event.rootId);

    // [집계 정책] 동일 도구 이벤트는 처음 관측한 인덱스만 남겨 복사 구간 판정에 쓴다.
    if (event.kind === 'capability') {
      const id = capabilityKey(event);
      if (!this.capabilities.has(id)) this.capabilities.set(id, index);
      return;
    }
    if (event.kind !== 'usage') return;

    // [귀속 정책] 현행 포맷의 존재를 표시하고 레거시 사용량은 복사 이력 비교용 서명을 남긴다.
    if (event.schema === 'current' && !this.current) {
      this.current = true;
      this.legacyPrefix = event.legacyPrefix;
    }
    if (event.schema === 'legacy') this.legacy.push({ index, rootId: event.rootId, signature: legacySignature(event),
      offset: event.offset, responseId: event.responseId });
    else this.nonLegacyRoots.add(event.rootId);

    // [귀속 정책] 포맷별로 응답 ID와 요청 ID를 연결하고 서로 다른 요청이 관측되면 미확정으로 둔다.
    if (event.requestId === null) return;
    const requests = event.schema === 'legacy' ? this.legacyRequests : this.requests;
    if (!requests.has(event.responseId)) requests.set(event.responseId, event.requestId);
    else if (requests.get(event.responseId) !== event.requestId) requests.set(event.responseId, null);
  }
}

export type SourceEvidenceData = Omit<SourceEvidence, 'add' | 'child'>;

export interface SourcePlan {
  file: StreamingAggregateFile;
  base: number;
  flags: Map<string, Set<string>>;
  inheritedRoots: Set<string>;
  copiedLegacyIndices?: ReadonlySet<number>;
  copiedCapabilities: Set<string>;
  legacyCutoff: number;
}

/** 원본 재읽기 없이 수집된 근거로 남은 winner의 유효성과 Claude request 그룹을 확정한다. */
export function prepareSources(files: readonly StreamingAggregateFile[]): {
  sources: SourcePlan[]; requests: Map<string, string | null>;
} {
  // [집계 정책] 파일별 이벤트 수를 누적해 전체 비교 순번의 기준을 만들고 식별자를 정규화한다.
  let ordinal = 0;
  const sources = files.map(raw => {
    const identity = { ...raw.identity };
    for (const [name, value] of Object.entries(identity)) if (typeof value === 'string') Reflect.set(identity, name, text(value));
    const file = { ...raw, session_id: text(raw.session_id), identity };

    // [진단 정책] 부모 요청이 있으면 진단을 그 요청에 모으고 독립 서브에이전트는 파일 전체에 표시한다.
    const flags = new Map<string, Set<string>>();
    const targetRoot = (rootId: string): string => file.identity.parentRootId ?? rootId;
    for (const [rootId, values] of file.evidence.flags)
      for (const flag of values) addFlag(flags, targetRoot(rootId), flag);
    for (const flag of file.flags ?? []) addFlag(flags, targetRoot(text(flag.rootId)), text(flag.flag));
    if (identity.standaloneSubagent) addFlag(flags, '*', 'standalone-subagent');
    const source: SourcePlan = { file, base: ordinal, flags, inheritedRoots: new Set(), copiedCapabilities: new Set(), legacyCutoff: -1 };
    ordinal += file.evidence.eventCount;
    return source;
  });

  // [귀속 정책] Codex 파일을 ID 순으로 스레드별 색인하고 fork 부모를 우선해 다른 파일에서 대조할 원본을 찾는다.
  const codex = sources.filter(source => source.file.provider === 'codex').sort((a, b) => a.file.id - b.file.id);
  const threads = new Map<string, SourcePlan[]>();
  for (const source of codex) {
    const id = source.file.identity.threadId;
    let matches = threads.get(id);
    if (!matches) threads.set(id, matches = []);
    matches.push(source);
  }
  for (const source of codex) {
    const identity = source.file.identity, reference = identity.forkedFromId ?? identity.parentThreadId;
    if (reference == null) continue;
    const parent = threads.get(reference)?.find(candidate => candidate.file.id !== source.file.id);
    if (!parent) continue;
    for (const flags of source.flags.values()) flags.delete('missing-parent');

    // [귀속 정책] 부모와 자식의 레거시 사용량 서명을 처음부터 비교해 일치하는 접두사의 끝을 구한다.
    const childRows = source.file.evidence.legacy;
    const parentRows = parent.file.evidence.legacy;
    let parentCutoff = -1;
    for (let index = 0; index < Math.min(childRows.length, parentRows.length); index++) {
      const child = childRows[index], ancestor = parentRows[index];
      if (child.signature !== ancestor.signature) break;
      source.legacyCutoff = child.index; parentCutoff = ancestor.index;
      source.inheritedRoots.add(child.rootId);
    }
    // [귀속 정책] 복사된 행을 표시하고 접두사 이후 사용량이나 새 포맷 사용량이 있는 요청은 계속 집계한다.
    const copiedLegacyIndices = new Set<number>();
    for (const { index, rootId } of childRows) {
      if (index > source.legacyCutoff) source.inheritedRoots.delete(rootId);
      else copiedLegacyIndices.add(index);
    }
    if (copiedLegacyIndices.size) source.copiedLegacyIndices = copiedLegacyIndices;
    if (identity.forkedFromId) {
      for (const root of source.file.evidence.startedRoots) {
        if (parent.file.evidence.startedRoots.has(root)) source.inheritedRoots.add(root);
      }
    }
    for (const rootId of source.file.evidence.nonLegacyRoots) source.inheritedRoots.delete(rootId);

    // [집계 정책] 양쪽 복사 구간에 같은 키가 있는 도구 이벤트를 복제본으로 표시한다.
    for (const [id, index] of source.file.evidence.capabilities) {
      const match = parent.file.evidence.capabilities.get(id);
      if (match !== undefined && (identity.forkedFromId || index <= source.legacyCutoff && match <= parentCutoff))
        source.copiedCapabilities.add(id);
    }
  }

  // [귀속 정책] Claude 응답별 요청 ID를 세션 단위로 합치고, 현행 포맷이 있으면 그 파일의 레거시 근거를 제외한다.
  const requests = new Map<string, string | null>();
  for (const source of sources) {
    if (source.file.provider !== 'claude') continue;
    const evidence = source.file.evidence;
    const observed = evidence.current ? [evidence.requests] : [evidence.requests, evidence.legacyRequests];
    for (const values of observed) for (const [responseId, requestId] of values) {
      const id = key(source.file.session_id, responseId);
      if (!requests.has(id)) requests.set(id, requestId);
      else if (requests.get(id) !== requestId) requests.set(id, null);
    }
  }
  return { sources, requests };
}

export function eligibleUsage(source: SourcePlan, event: Pick<UsageEvent, 'schema' | 'rootId'>, index: number): boolean {
  // [귀속 정책] 상속된 요청을 제외하고 레거시는 현행 포맷이 없는 파일의 복사 접두사 이후만 허용한다.
  return !source.inheritedRoots.has(event.rootId)
    && (event.schema !== 'legacy' || (!source.file.evidence.current || source.file.evidence.legacyPrefix !== undefined)
      && index > source.legacyCutoff);
}

export function eligibleWinner(source: SourcePlan, rootId: string, referenceId: number): boolean {
  // [Winner 정책] 상속된 요청이나 복사된 레거시 행을 가리키는 후보를 제외한다.
  return !source.inheritedRoots.has(rootId) && !source.copiedLegacyIndices?.has(referenceId);
}

export function eligible(source: SourcePlan, event: ParseEvent, index: number): boolean {
  // [집계 정책] 도구는 복제된 호출만 제외하고 나머지 이벤트는 요청의 상속 여부를 확인한다.
  if (event.kind === 'usage') return eligibleUsage(source, event, index);
  if (event.kind === 'capability' && source.copiedCapabilities.has(capabilityKey(event))) return false;
  return !(event.kind !== 'capability' && source.inheritedRoots.has(event.rootId));
}
