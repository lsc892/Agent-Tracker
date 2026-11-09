// 한 번의 읽기에서 토큰 DTO 없이 포맷·복사 접두사·request 귀속 근거를 수집한다.
import { createHash } from 'node:crypto';
import type { ParseEvent, ParsedIdentity, Provider, UsageEvent } from '../types';

export interface StreamingAggregateFile {
  id: number;
  provider: Provider;
  session_id: string;
  identity: ParsedIdentity;
  evidence: SourceEvidence;
  flags?: readonly { rootId: string; flag: string }[];
}

export const text = (value: string): string => /[\ud800-\udfff]/.test(value) ? Buffer.from(value).toString('utf8') : value;
export const key = (...values: unknown[]): string => JSON.stringify(values);
export const capabilityKey = (event: Extract<ParseEvent, { kind: 'capability' }>): string =>
  key(event.rootId, event.eventId, event.category, event.name);

/** SQLite TEXT의 UTF-8 변환과 같은 문자열로 맞추되 정상 입력은 복사하지 않는다. */
export function normalizedEvent(event: ParseEvent): ParseEvent {
  let result = event;
  for (const [name, value] of Object.entries(event)) {
    if (typeof value !== 'string' || text(value) === value) continue;
    if (result === event) result = { ...event };
    Reflect.set(result, name, text(value));
  }
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
  let values = flags.get(rootId);
  if (!values) flags.set(rootId, values = new Set());
  values.add(flag);
}

/** 원본을 읽으며 사용량 값 대신 비교·제외 규칙의 작은 근거를 남긴다. */
export class SourceEvidence {
  eventCount = 0;
  current = false;
  readonly flags = new Map<string, Set<string>>();
  readonly legacy: { index: number; rootId: string; signature: string }[] = [];
  readonly nonLegacyRoots = new Set<string>();
  readonly capabilities = new Map<string, number>();
  readonly requests = new Map<string, string | null>();
  readonly legacyRequests = new Map<string, string | null>();
  readonly childRequests = new Map<string, string | null>();

  /** 생성 결과의 thread ID·agent path를 호출 당시 부모 요청에 연결한다. */
  child(reference: string, rootId: string): void {
    reference = text(reference); rootId = text(rootId);
    if (!this.childRequests.has(reference)) this.childRequests.set(reference, rootId);
    else if (this.childRequests.get(reference) !== rootId) this.childRequests.set(reference, null);
  }

  add(raw: ParseEvent, index: number): void {
    const event = normalizedEvent(raw);
    this.eventCount = Math.max(this.eventCount, index + 1);
    if ('flags' in event) for (const flag of event.flags ?? []) addFlag(this.flags, event.rootId, flag);
    if (event.kind === 'capability') {
      const id = capabilityKey(event);
      if (!this.capabilities.has(id)) this.capabilities.set(id, index);
      return;
    }
    if (event.kind !== 'usage') return;
    if (event.schema === 'current') this.current = true;
    if (event.schema === 'legacy') this.legacy.push({ index, rootId: event.rootId, signature: legacySignature(event) });
    else this.nonLegacyRoots.add(event.rootId);
    if (event.requestId === null) return;
    const requests = event.schema === 'legacy' ? this.legacyRequests : this.requests;
    if (!requests.has(event.responseId)) requests.set(event.responseId, event.requestId);
    else if (requests.get(event.responseId) !== event.requestId) requests.set(event.responseId, null);
  }
}

export interface SourcePlan {
  file: StreamingAggregateFile;
  base: number;
  flags: Map<string, Set<string>>;
  inheritedRoots: Set<string>;
  copiedCapabilities: Set<string>;
  legacyCutoff: number;
}

/** 원본 재읽기 없이 수집된 근거로 남은 winner의 유효성과 Claude request 그룹을 확정한다. */
export function prepareSources(files: readonly StreamingAggregateFile[]): {
  sources: SourcePlan[]; requests: Map<string, string | null>;
} {
  let ordinal = 0;
  const sources = files.map(raw => {
    const identity = { ...raw.identity };
    for (const [name, value] of Object.entries(identity)) if (typeof value === 'string') Reflect.set(identity, name, text(value));
    const file = { ...raw, session_id: text(raw.session_id), identity };
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
    const childRows = source.file.evidence.current ? [] : source.file.evidence.legacy;
    const parentRows = parent.file.evidence.current ? [] : parent.file.evidence.legacy;
    let parentCutoff = -1;
    for (let index = 0; index < Math.min(childRows.length, parentRows.length); index++) {
      const child = childRows[index], ancestor = parentRows[index];
      if (child.signature !== ancestor.signature) break;
      source.legacyCutoff = child.index; parentCutoff = ancestor.index;
      source.inheritedRoots.add(child.rootId);
    }
    if (source.legacyCutoff < 0) continue;
    for (const event of childRows) if (event.index > source.legacyCutoff) source.inheritedRoots.delete(event.rootId);
    for (const rootId of source.file.evidence.nonLegacyRoots) source.inheritedRoots.delete(rootId);
    for (const [id, index] of source.file.evidence.capabilities) {
      if (index > source.legacyCutoff) continue;
      const match = parent.file.evidence.capabilities.get(id);
      if (match !== undefined && match <= parentCutoff) source.copiedCapabilities.add(id);
    }
  }
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

export function eligible(source: SourcePlan, event: ParseEvent, index: number): boolean {
  if (event.kind === 'usage' && event.schema === 'legacy'
    && (source.file.evidence.current || index <= source.legacyCutoff)) return false;
  if (event.kind === 'capability' && index <= source.legacyCutoff && source.copiedCapabilities.has(capabilityKey(event))) return false;
  return !(event.kind !== 'capability' && source.inheritedRoots.has(event.rootId));
}
