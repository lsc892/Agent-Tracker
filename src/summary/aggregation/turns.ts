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
export interface Root {
  provider: StreamingAggregateFile['provider']; session: string; rootId: string; firstFile: StreamingAggregateFile;
  offset: number; hasMain: boolean; started: number | null; completedAt: number | null; lastAssistant: number | null;
  completed: boolean; explicitDuration: number | null; lifecycle: boolean; title: string | null; outcome?: Outcome;
  input: number; output: number; cacheRead: number; cacheWrite: number; billing: Set<BillingMode>;
  models: Map<string, ModelUsageInput>; capabilities: Map<string, CapabilityUsageInput>;
}

export const compareText = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const min = (a: number | null, b: number | null | undefined): number | null => b == null ? a : a === null ? b : Math.min(a, b);
export const max = (a: number | null, b: number | null | undefined): number | null => b == null ? a : a === null ? b : Math.max(a, b);

export function createRoot(file: StreamingAggregateFile, rootId: string, offset: number): Root {
  return { provider: file.provider, session: file.session_id, rootId, firstFile: file, offset, hasMain: false,
    started: null, completedAt: null, lastAssistant: null, completed: false, explicitDuration: null, lifecycle: false,
    title: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, billing: new Set(), models: new Map(), capabilities: new Map() };
}

export function addTurn(root: Root, event: TurnEvent): void {
  root.started = min(root.started, event.startedAt); root.lastAssistant = max(root.lastAssistant, event.lastAssistantAt);
  root.completed ||= Boolean(event.completed);
  if (event.completed) root.completedAt = max(root.completedAt, event.completedAt);
  if (event.durationQuality === 'exact') root.explicitDuration = max(root.explicitDuration, event.duration);
  if (event.completed && event.durationQuality === 'derived') root.lifecycle = true;
  if (root.title === null && event.title !== undefined) root.title = event.title;
}

export function addCapability(root: Root, category: CapabilityUsageInput['category'], name: string): void {
  const id = key(category, name), previous = root.capabilities.get(id);
  if (previous) previous.usage_count++;
  else root.capabilities.set(id, { category, name, usage_count: 1 });
}

export function addWinner(root: Root, winner: Winner, collectCapabilities: boolean): void {
  const event = winner.event, tokens = event.tokens;
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
  for (const root of roots) {
    if (root.outcome?.event.status === 'aborted') continue;
    const sessionFiles = sessions.get(key(root.provider, root.session))!;
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
