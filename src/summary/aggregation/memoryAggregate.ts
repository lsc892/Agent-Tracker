// 재사용한 파일 DTO를 메모리에서 검증·중복 제거하고 영속 저장용 요청 결과를 만든다.
import type { BillingMode, CapabilityUsageInput, ModelUsageInput, TurnSummaryInput } from '../db/types';
import type { ParseEvent, ParsedIdentity, Provider, TurnEvent, UsageEvent } from '../types';

export interface MemoryAggregateFile {
  id: number;
  provider: Provider;
  session_id: string;
  identity: ParsedIdentity;
  events: readonly ParseEvent[];
  flags?: readonly { rootId: string; flag: string }[];
}

export interface MaterializedTurnSummary extends TurnSummaryInput {
  model_usage: ModelUsageInput[];
  capability_usage?: CapabilityUsageInput[];
  hasMain: boolean;
}

export interface MemoryAggregateResult {
  summaries: MaterializedTurnSummary[];
  orphans: { fileId: number; offset: number; provider: Provider; session_id: string; rootId: string }[];
}

interface Source {
  file: MemoryAggregateFile;
  base: number;
  current: boolean;
  legacy: number[];
  inherited: Set<number>;
  inheritedRoots: Set<string>;
  copiedCapabilities: Set<number>;
  flags: Map<string, Set<string>>;
}

interface Outcome { event: TurnEvent; ordinal: number; orderingAt: number | null }
interface Winner { source: Source; event: UsageEvent; ordinal: number; request: string | null; score: number | bigint }
interface Root {
  provider: Provider;
  session: string;
  rootId: string;
  firstFile: MemoryAggregateFile;
  offset: number;
  hasMain: boolean;
  started: number | null;
  completedAt: number | null;
  lastAssistant: number | null;
  completed: boolean;
  explicitDuration: number | null;
  lifecycle: boolean;
  title: string | null;
  outcome?: Outcome;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  billing: Set<BillingMode>;
  models: Map<string, ModelUsageInput>;
  capabilities: Map<string, CapabilityUsageInput>;
}

const key = (...values: unknown[]): string => JSON.stringify(values);
const text = (value: string): string => /[\ud800-\udfff]/.test(value) ? Buffer.from(value).toString('utf8') : value;
const compareText = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const min = (a: number | null, b: number | null | undefined): number | null => b == null ? a : a === null ? b : Math.min(a, b);
const max = (a: number | null, b: number | null | undefined): number | null => b == null ? a : a === null ? b : Math.max(a, b);
const usageScore = (event: UsageEvent): number | bigint => Number.isSafeInteger(event.tokens.input + event.tokens.output)
  ? event.tokens.input + event.tokens.output : BigInt(event.tokens.input) + BigInt(event.tokens.output);
const capabilityKey = (event: Extract<ParseEvent, { kind: 'capability' }>): string =>
  key(event.rootId, event.eventId, event.category, event.name);
const legacySignature = (event: UsageEvent): string => key(event.rootId, event.turnId, event.responseId,
  event.tokens.input, event.tokens.output, event.tokens.cacheRead, event.tokens.cacheWrite, event.tokens.reasoning);

/** SQLite TEXT와 같은 UTF-8 문자열로 맞추되 정상 DTO는 복사하지 않는다. */
function normalizedEvent(event: ParseEvent): ParseEvent {
  let result = event;
  for (const [name, value] of Object.entries(event)) {
    if (typeof value !== 'string') continue;
    const normalized = text(value);
    if (normalized === value) continue;
    if (result === event) result = { ...event };
    Reflect.set(result, name, normalized);
  }
  if ('flags' in event && event.flags?.some(flag => text(flag) !== flag)) {
    if (result === event) result = { ...event };
    if ('flags' in result) result.flags = event.flags.map(text);
  }
  return result;
}

function normalizedFile(file: MemoryAggregateFile): MemoryAggregateFile {
  const identity = { ...file.identity };
  for (const [name, value] of Object.entries(identity)) if (typeof value === 'string') Reflect.set(identity, name, text(value));
  return { ...file, session_id: text(file.session_id), identity, events: file.events.map(normalizedEvent) };
}

function addFlag(source: Source, rootId: string, flag: string): void {
  let flags = source.flags.get(rootId);
  if (!flags) source.flags.set(rootId, flags = new Set());
  flags.add(flag);
}

function sourcesFor(files: readonly MemoryAggregateFile[]): Source[] {
  let ordinal = 0;
  const sources = files.map(raw => {
    const file = normalizedFile(raw);
    const source: Source = { file, base: ordinal, current: false, legacy: [], inherited: new Set(),
      inheritedRoots: new Set(), copiedCapabilities: new Set(), flags: new Map() };
    ordinal += file.events.length;
    file.events.forEach((event, index) => {
      if ('flags' in event) for (const flag of event.flags ?? []) addFlag(source, event.rootId, flag);
      if (event.kind === 'usage') {
        if (event.schema === 'current') source.current = true;
        if (event.schema === 'legacy') source.legacy.push(index);
      }
    });
    for (const flag of file.flags ?? []) addFlag(source, text(flag.rootId), text(flag.flag));
    if (file.identity.standaloneSubagent) addFlag(source, '*', 'standalone-subagent');
    return source;
  });
  for (const source of sources) if (source.current) source.legacy.length = 0;
  const codex = sources.filter(source => source.file.provider === 'codex').sort((a, b) => a.file.id - b.file.id);
  const capabilities = new Map<number, Map<string, number>>();
  for (const source of codex) {
    const values = new Map<string, number>();
    source.file.events.forEach((event, index) => {
      if (event.kind === 'capability' && !values.has(capabilityKey(event))) values.set(capabilityKey(event), index);
    });
    capabilities.set(source.file.id, values);
  }
  // Compare complete legacy sequences before selecting a maximum, so later valid lower values survive.
  for (const source of codex) {
    const identity = source.file.identity, reference = identity.forkedFromId ?? identity.parentThreadId;
    if (reference == null) continue;
    const parent = codex.find(candidate => candidate.file.id !== source.file.id && candidate.file.identity.threadId === reference);
    if (!parent) continue;
    for (const flags of source.flags.values()) flags.delete('missing-parent');
    let childCutoff = -1, parentCutoff = -1;
    for (let index = 0; index < Math.min(source.legacy.length, parent.legacy.length); index++) {
      const childIndex = source.legacy[index], parentIndex = parent.legacy[index];
      const childEvent = source.file.events[childIndex] as UsageEvent, parentEvent = parent.file.events[parentIndex] as UsageEvent;
      if (legacySignature(childEvent) !== legacySignature(parentEvent)) break;
      source.inherited.add(childIndex); childCutoff = childIndex; parentCutoff = parentIndex;
      source.inheritedRoots.add(childEvent.rootId);
    }
    if (childCutoff < 0) continue;
    source.file.events.forEach((event, index) => {
      if (event.kind === 'usage' && !source.inherited.has(index) && !(source.current && event.schema === 'legacy')) {
        source.inheritedRoots.delete(event.rootId);
      }
      if (event.kind !== 'capability' || index > childCutoff) return;
      const match = capabilities.get(parent.file.id)?.get(capabilityKey(event));
      if (match !== undefined && match <= parentCutoff) source.copiedCapabilities.add(index);
    });
  }
  return sources;
}

function eligible(source: Source, event: ParseEvent, index: number): boolean {
  return !(event.kind === 'usage' && event.schema === 'legacy' && source.current)
    && !source.inherited.has(index) && !source.copiedCapabilities.has(index)
    && !(event.kind !== 'capability' && source.inheritedRoots.has(event.rootId));
}

function timing(root: Root): { status: TurnSummaryInput['status']; completedAt: number | null;
  duration: number | null; quality: TurnSummaryInput['duration_quality'] } {
  const latest = root.outcome?.event;
  const status = latest?.status === 'aborted' ? 'in_progress' : latest?.status ?? (root.completed ? 'completed' : 'in_progress');
  const completedAt = status === 'in_progress' ? null : latest ? latest.statusAt ?? null : root.completedAt;
  if (status !== 'in_progress' && root.explicitDuration !== null) {
    return { status, completedAt, duration: root.explicitDuration, quality: 'exact' };
  }
  if (root.started !== null && completedAt !== null && completedAt >= root.started) {
    const lifecycle = latest ? latest.durationQuality === 'derived' : root.lifecycle;
    return { status, completedAt, duration: completedAt - root.started,
      quality: status === 'completed' && lifecycle ? 'derived' : 'approximate' };
  }
  if (status === 'completed' && root.started !== null && root.lastAssistant !== null && root.lastAssistant >= root.started) {
    return { status, completedAt, duration: root.lastAssistant - root.started, quality: 'approximate' };
  }
  return { status, completedAt, duration: null, quality: 'missing' };
}

function addCapability(root: Root, category: CapabilityUsageInput['category'], name: string): void {
  const id = key(category, name), previous = root.capabilities.get(id);
  if (previous) previous.usage_count++;
  else root.capabilities.set(id, { category, name, usage_count: 1 });
}

/** 파일의 최종 귀속과 원본 순서를 받아 SQL 중간 적재 없이 최종 요청·모델·도구 집계를 만든다. */
export function aggregateMemory(files: readonly MemoryAggregateFile[], collectCapabilities = true): MemoryAggregateResult {
  const sources = sourcesFor(files), roots = new Map<string, Root>(), requests = new Map<string, string | null>();
  const sessions = new Map<string, Source[]>();
  for (const source of sources) {
    const file = source.file, id = key(file.provider, file.session_id);
    let sessionFiles = sessions.get(id);
    if (!sessionFiles) sessions.set(id, sessionFiles = []);
    sessionFiles.push(source);
    if (file.provider !== 'claude') continue;
    file.events.forEach((event, index) => {
      if (!eligible(source, event, index) || event.kind !== 'usage' || event.requestId === null) return;
      const response = key(file.session_id, event.responseId);
      if (!requests.has(response)) requests.set(response, event.requestId);
      else if (requests.get(response) !== event.requestId) requests.set(response, null);
    });
  }
  const winners = new Map<string, Winner>(), checks = new Map<string, { source: Source; event: Extract<ParseEvent, { kind: 'check' }>; ordinal: number }>();
  const sourceOutcomes = new Map<string, { root: Root; outcome: Outcome }>(), capabilities = new Set<string>();
  for (const source of sources) source.file.events.forEach((event, index) => {
    if (!eligible(source, event, index)) return;
    const file = source.file, ordinal = source.base + index, rootKey = key(file.provider, file.session_id, event.rootId);
    let root = roots.get(rootKey);
    if (!root) roots.set(rootKey, root = { provider: file.provider, session: file.session_id, rootId: event.rootId,
      firstFile: file, offset: event.offset, hasMain: false, started: null, completedAt: null, lastAssistant: null,
      completed: false, explicitDuration: null, lifecycle: false, title: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      billing: new Set(), models: new Map(), capabilities: new Map() });
    if (file.id < root.firstFile.id) root.firstFile = file;
    root.offset = Math.min(root.offset, event.offset); root.hasMain ||= file.identity.isMain;
    switch (event.kind) {
      case 'turn': {
        if (!event.isMain && !file.identity.standaloneSubagent) break;
        root.started = min(root.started, event.startedAt); root.lastAssistant = max(root.lastAssistant, event.lastAssistantAt);
        root.completed ||= Boolean(event.completed);
        if (event.completed) root.completedAt = max(root.completedAt, event.completedAt);
        if (event.durationQuality === 'exact') root.explicitDuration = max(root.explicitDuration, event.duration);
        if (event.completed && event.durationQuality === 'derived') root.lifecycle = true;
        if (root.title === null && event.title !== undefined) root.title = event.title;
        if (event.status !== undefined) {
          const id = key(file.id, event.rootId), before = sourceOutcomes.get(id)?.outcome;
          sourceOutcomes.set(id, { root, outcome: { event, ordinal, orderingAt: max(before?.orderingAt ?? null, event.statusAt) } });
        }
        break;
      }
      case 'usage': {
        const request = file.provider === 'claude' && event.requestId === null
          ? requests.get(key(file.session_id, event.responseId)) ?? null : event.requestId;
        const id = key(file.provider, file.session_id, event.responseId,
          file.provider === 'claude' ? request ?? 'no-req' : event.threadId, file.provider === 'claude' ? '' : event.turnId);
        const score = usageScore(event), previous = winners.get(id);
        if (!previous || score > previous.score || score === previous.score && ordinal > previous.ordinal) {
          winners.set(id, { source, event, ordinal, request, score });
        }
        break;
      }
      case 'check': {
        const id = key(file.provider, file.session_id, event.threadId, event.turnId), previous = checks.get(id);
        if (!previous || ordinal > previous.ordinal) checks.set(id, { source, event, ordinal });
        break;
      }
      case 'capability': {
        if (!collectCapabilities) break;
        const id = key(file.provider, file.session_id, event.rootId, event.threadId, event.eventId, event.category, event.name);
        if (!capabilities.has(id)) { capabilities.add(id); addCapability(root, event.category, event.name); }
        break;
      }
    }
  });
  for (const { root, outcome } of sourceOutcomes.values()) {
    const before = root.outcome;
    if (!before || outcome.orderingAt !== null && (before.orderingAt === null || outcome.orderingAt > before.orderingAt)
      || outcome.orderingAt === before.orderingAt && outcome.ordinal > before.ordinal) root.outcome = outcome;
  }
  const turnTotals = new Map<string, { input: number; output: number }>();
  for (const { source, event, request } of winners.values()) {
    const file = source.file, root = roots.get(key(file.provider, file.session_id, event.rootId))!, tokens = event.tokens;
    root.input += tokens.input; root.output += tokens.output;
    const cacheRead = Math.min(tokens.input, tokens.cacheRead), cacheWrite = Math.min(Math.max(0, tokens.input - tokens.cacheRead), tokens.cacheWrite);
    root.cacheRead += cacheRead; root.cacheWrite += cacheWrite; root.billing.add(event.billingMode ?? 'unknown');
    const model = event.model ?? '', previous = root.models.get(model);
    if (previous) {
      previous.input_tokens += tokens.input; previous.output_tokens += tokens.output;
      previous.cache_read_input_tokens! += cacheRead; previous.cache_write_input_tokens! += cacheWrite;
    } else root.models.set(model, { model, input_tokens: tokens.input, output_tokens: tokens.output,
      cache_read_input_tokens: cacheRead, cache_write_input_tokens: cacheWrite });
    if (collectCapabilities && (model !== '' || tokens.input + tokens.output > 0)) addCapability(root, 'model', model);
    if (file.provider === 'claude' && request === null) addFlag(source, event.rootId, 'missing-request-id');
    const id = key(file.provider, file.session_id, event.threadId, event.turnId), sum = turnTotals.get(id);
    if (sum) { sum.input += tokens.input; sum.output += tokens.output; }
    else turnTotals.set(id, { input: tokens.input, output: tokens.output });
  }
  for (const [id, { source, event }] of checks) {
    const totals = turnTotals.get(id);
    if (event.tokens.input !== (totals?.input ?? 0) || event.tokens.output !== (totals?.output ?? 0)) {
      addFlag(source, event.rootId, 'token-total-mismatch');
    }
  }
  const result: MemoryAggregateResult = { summaries: [], orphans: [] };
  for (const root of roots.values()) {
    if (root.outcome?.event.status === 'aborted') continue;
    const sessionFiles = sessions.get(key(root.provider, root.session))!.slice().sort((a, b) => a.file.id - b.file.id);
    const main = sessionFiles.find(source => source.file.identity.isMain)?.file ?? root.firstFile;
    const name = sessionFiles.filter(source => source.file.identity.isMain && source.file.identity.sessionName != null).at(-1)?.file.identity.sessionName ?? null;
    const flags = new Set<string>();
    for (const source of sessionFiles) {
      for (const [rootId, sourceFlags] of [...source.flags].sort(([a], [b]) => compareText(a, b))) {
        if (rootId !== '*' && rootId !== root.rootId) continue;
        for (const flag of [...sourceFlags].sort(compareText)) flags.add(flag);
      }
    }
    const { status, completedAt, duration, quality } = timing(root);
    if (quality === 'missing') flags.add('duration-missing');
    if (quality === 'approximate') flags.add('duration-approximate');
    if (!root.hasMain) {
      flags.add('missing-root-turn');
      result.orphans.push({ fileId: root.firstFile.id, offset: root.offset, provider: root.provider, session_id: root.session, rootId: root.rootId });
    }
    result.summaries.push({ provider: root.provider, project_key: main.identity.projectKey, project_name: main.identity.projectName,
      session_id: root.session, session_name: name, root_turn_id: root.rootId, request_title: root.title,
      started_at_ms: root.started, completed_at_ms: completedAt, duration_ms: duration, duration_quality: quality,
      input_tokens: root.input, output_tokens: root.output, cache_read_input_tokens: root.cacheRead, cache_write_input_tokens: root.cacheWrite,
      total_tokens: root.input + root.output, status, quality_flags: [...flags].join(',') || null,
      diagnostic_file_id: flags.size ? root.firstFile.id : null, diagnostic_offset: flags.size ? root.offset : null,
      model_usage: [...root.models.values()].filter(model => model.model !== '' || model.input_tokens + model.output_tokens > 0)
        .sort((a, b) => compareText(a.model, b.model)),
      capability_usage: collectCapabilities ? [...root.capabilities.values()].sort((a, b) => compareText(a.category, b.category) || compareText(a.name, b.name)) : undefined,
      billing: root.billing.size === 1 ? root.billing.values().next().value! : 'unknown', hasMain: root.hasMain });
  }
  result.summaries.sort((a, b) => compareText(a.provider, b.provider) || compareText(a.session_id, b.session_id) || compareText(a.root_turn_id, b.root_turn_id));
  return result;
}
