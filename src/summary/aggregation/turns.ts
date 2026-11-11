// 유효한 원본의 요청 상태와 최종 winner를 조회용 요청·모델·도구 값으로 만든다.
import type { BillingMode, CapabilityUsageInput, ModelUsageInput, TurnSummaryInput } from '../db/types';
import type { TurnEvent } from '../types';
import { key, type SourcePlan, type StreamingAggregateFile } from './sourceEvidence';
import type { Winner } from './winners';

export interface MaterializedTurnSummary extends TurnSummaryInput {
  model_usage: ModelUsageInput[];
  capability_usage?: CapabilityUsageInput[];
  hasMain: boolean;
}

export interface MemoryAggregateResult {
  summaries: MaterializedTurnSummary[];
  orphans: { fileId: number; offset: number; provider: StreamingAggregateFile['provider']; session_id: string; rootId: string }[];
}

export interface Outcome { event: TurnEvent; ordinal: number; orderingAt: number | null }
export interface TurnState {
  started: number | null; completedAt: number | null; lastAssistant: number | null;
  completed: boolean; explicitDuration: number | null; lifecycle: boolean; title: string | null;
  titleOrdinal: number; outcome?: Outcome;
  offset: number;
}
export interface Root {
  provider: StreamingAggregateFile['provider']; session: string; rootId: string; firstFile: StreamingAggregateFile;
  offset: number; hasMain: boolean; started: number | null; completedAt: number | null; lastAssistant: number | null;
  completed: boolean; explicitDuration: number | null; lifecycle: boolean; title: string | null; titleOrdinal: number; outcome?: Outcome;
  input: number; output: number; cacheRead: number; cacheWrite: number; billing: Map<BillingMode, number>;
  models: Map<string, { usage: ModelUsageInput; count: number }>; capabilities: Map<string, CapabilityUsageInput>;
}

export const compareText = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const min = (a: number | null, b: number | null | undefined): number | null => b == null ? a : a === null ? b : Math.min(a, b);
export const max = (a: number | null, b: number | null | undefined): number | null => b == null ? a : a === null ? b : Math.max(a, b);

export function createTurnState(): TurnState {
  return { started: null, completedAt: null, lastAssistant: null, completed: false,
    explicitDuration: null, lifecycle: false, title: null, titleOrdinal: Infinity, offset: Infinity };
}

export function createRoot(file: StreamingAggregateFile, rootId: string, offset: number): Root {
  return { provider: file.provider, session: file.session_id, rootId, firstFile: file, offset, hasMain: false,
    started: null, completedAt: null, lastAssistant: null, completed: false, explicitDuration: null, lifecycle: false,
    title: null, titleOrdinal: Infinity, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, billing: new Map(), models: new Map(), capabilities: new Map() };
}

export function addTurn(root: TurnState, event: TurnEvent, ordinal: number): void {
  root.offset = Math.min(root.offset, event.offset);
  root.started = min(root.started, event.startedAt); root.lastAssistant = max(root.lastAssistant, event.lastAssistantAt);
  root.completed ||= Boolean(event.completed);
  if (event.completed) root.completedAt = max(root.completedAt, event.completedAt);
  if (event.durationQuality === 'exact') root.explicitDuration = max(root.explicitDuration, event.duration);
  if (event.completed && event.durationQuality === 'derived') root.lifecycle = true;
  if (event.title !== undefined && ordinal < root.titleOrdinal) { root.title = event.title; root.titleOrdinal = ordinal; }
}

/** 원본 이벤트를 재생하지 않고 최소·최대·첫 제목 상태를 병합한다. */
export function mergeTurn(root: TurnState, state: TurnState, base: number): void {
  root.started = min(root.started, state.started); root.lastAssistant = max(root.lastAssistant, state.lastAssistant);
  root.completed ||= state.completed; root.completedAt = max(root.completedAt, state.completedAt);
  root.explicitDuration = max(root.explicitDuration, state.explicitDuration); root.lifecycle ||= state.lifecycle;
  if (state.title !== null && base + state.titleOrdinal < root.titleOrdinal) {
    root.title = state.title; root.titleOrdinal = base + state.titleOrdinal;
  }
}

export function addCapability(root: Root, category: CapabilityUsageInput['category'], name: string, direction: 1 | -1 = 1): void {
  const id = key(category, name), previous = root.capabilities.get(id);
  const count = (previous?.usage_count ?? 0) + direction;
  if (count === 0) root.capabilities.delete(id);
  else if (previous) previous.usage_count = count;
  else root.capabilities.set(id, { category, name, usage_count: count });
}

/** 교체 전 기여를 빼고 새 기여를 더해 winner 전체를 다시 합산하지 않는다. */
export function addWinner(root: Root, winner: Winner, collectCapabilities: boolean, direction: 1 | -1 = 1): void {
  const event = winner.event, tokens = event.tokens;
  root.input += direction * tokens.input; root.output += direction * tokens.output;
  const cacheRead = Math.min(tokens.input, tokens.cacheRead), cacheWrite = Math.min(Math.max(0, tokens.input - tokens.cacheRead), tokens.cacheWrite);
  root.cacheRead += direction * cacheRead; root.cacheWrite += direction * cacheWrite;
  const billing = event.billingMode ?? 'unknown', billingCount = (root.billing.get(billing) ?? 0) + direction;
  if (billingCount === 0) root.billing.delete(billing); else root.billing.set(billing, billingCount);
  const model = event.model ?? '', previous = root.models.get(model);
  const count = (previous?.count ?? 0) + direction;
  if (count === 0) root.models.delete(model);
  else if (previous) {
    previous.count = count;
    const usage = previous.usage;
    usage.input_tokens += direction * tokens.input; usage.output_tokens += direction * tokens.output;
    usage.cache_read_input_tokens! += direction * cacheRead; usage.cache_write_input_tokens! += direction * cacheWrite;
  } else root.models.set(model, { count, usage: { model, input_tokens: tokens.input, output_tokens: tokens.output,
    cache_read_input_tokens: cacheRead, cache_write_input_tokens: cacheWrite } });
  if (collectCapabilities && (model !== '' || tokens.input + tokens.output > 0)) addCapability(root, 'model', model, direction);
}

function timing(root: Root): { status: TurnSummaryInput['status']; completedAt: number | null;
  duration: number | null; quality: TurnSummaryInput['duration_quality'] } {
  const latest = root.outcome?.event;
  const status = latest?.status === 'aborted' ? 'in_progress' : latest?.status ?? (root.completed ? 'completed' : 'in_progress');
  const completedAt = status === 'in_progress' ? null : latest ? latest.statusAt ?? null : root.completedAt;
  if (status !== 'in_progress' && root.explicitDuration !== null) return { status, completedAt, duration: root.explicitDuration, quality: 'exact' };
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

export function materialize(roots: Iterable<Root>, sessions: Map<string, SourcePlan[]>, collectCapabilities: boolean): MemoryAggregateResult {
  const result: MemoryAggregateResult = { summaries: [], orphans: [] };
  // 세션의 main·이름·진단을 요청마다 모든 파일에서 다시 찾지 않는다.
  const details = new Map<string, { main?: StreamingAggregateFile; name: string | null;
    flags: Map<string, { fileId: number; rootId: string; values: string[] }[]> }>();
  for (const [id, files] of sessions) {
    const session: NonNullable<ReturnType<typeof details.get>> = { name: null, flags: new Map() };
    for (const source of files) {
      if (source.file.identity.isMain) {
        session.main ??= source.file;
        session.name = source.file.identity.sessionName ?? session.name;
      }
      for (const [rootId, values] of source.flags) {
        if (!values.size) continue;
        let entries = session.flags.get(rootId);
        if (!entries) session.flags.set(rootId, entries = []);
        entries.push({ fileId: source.file.id, rootId, values: [...values].sort(compareText) });
      }
    }
    details.set(id, session);
  }
  for (const root of roots) {
    if (root.outcome?.event.status === 'aborted') continue;
    const session = details.get(key(root.provider, root.session))!;
    const main = session.main ?? root.firstFile;
    const flags = new Set<string>();
    const common = session.flags.get('*') ?? [], specific = root.rootId === '*' ? [] : session.flags.get(root.rootId) ?? [];
    let commonIndex = 0, specificIndex = 0;
    while (commonIndex < common.length || specificIndex < specific.length) {
      const left = common[commonIndex], right = specific[specificIndex];
      const takeCommon = !right || left && (left.fileId < right.fileId
        || left.fileId === right.fileId && compareText(left.rootId, right.rootId) < 0);
      const entry = takeCommon ? common[commonIndex++] : specific[specificIndex++];
      for (const flag of entry.values) flags.add(flag);
    }
    const modelUsage: ModelUsageInput[] = [];
    for (const { usage } of root.models.values())
      if (usage.model !== '' || usage.input_tokens + usage.output_tokens > 0) modelUsage.push(usage);
    const { status, completedAt, duration, quality } = timing(root);
    if (quality === 'missing') flags.add('duration-missing');
    if (quality === 'approximate') flags.add('duration-approximate');
    if (!root.hasMain) {
      flags.add('missing-root-turn');
      result.orphans.push({ fileId: root.firstFile.id, offset: root.offset, provider: root.provider, session_id: root.session, rootId: root.rootId });
    }
    result.summaries.push({ provider: root.provider, project_key: main.identity.projectKey, project_name: main.identity.projectName,
      session_id: root.session, session_name: session.name, root_turn_id: root.rootId, request_title: root.title,
      started_at_ms: root.started, completed_at_ms: completedAt, duration_ms: duration, duration_quality: quality,
      input_tokens: root.input, output_tokens: root.output, cache_read_input_tokens: root.cacheRead, cache_write_input_tokens: root.cacheWrite,
      total_tokens: root.input + root.output, status, quality_flags: [...flags].join(',') || null,
      diagnostic_file_id: flags.size ? root.firstFile.id : null, diagnostic_offset: flags.size ? root.offset : null,
      model_usage: modelUsage.sort((a, b) => compareText(a.model, b.model)),
      capability_usage: collectCapabilities ? [...root.capabilities.values()].sort((a, b) => compareText(a.category, b.category) || compareText(a.name, b.name)) : undefined,
      billing: root.billing.size === 1 ? root.billing.keys().next().value! : 'unknown', hasMain: root.hasMain });
  }
  result.summaries.sort((a, b) => compareText(a.provider, b.provider) || compareText(a.session_id, b.session_id) || compareText(a.root_turn_id, b.root_turn_id));
  return result;
}
