// 유효한 원본의 요청 상태와 최종 winner를 조회용 요청·모델·도구 값으로 만든다.
import type { BillingMode, CapabilityUsageInput, ModelUsageInput, TurnSummaryInput } from '../db/types';
import type { TokenVector, TurnEvent, UsageEvent } from '../types';
import { key, type SourcePlan, type StreamingAggregateFile } from './sourceEvidence';

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
  // [집계 정책] 미관측 시각은 null로 두고 첫 제목과 위치를 고르기 위한 기준은 Infinity로 둔다.
  return { started: null, completedAt: null, lastAssistant: null, completed: false,
    explicitDuration: null, lifecycle: false, title: null, titleOrdinal: Infinity, offset: Infinity };
}

export function createRoot(file: StreamingAggregateFile, rootId: string, offset: number): Root {
  // [집계 정책] 요청의 원본과 진단 위치를 등록하고 사용량·모델·도구 합계를 비워 둔다.
  return { provider: file.provider, session: file.session_id, rootId, firstFile: file, offset, hasMain: false,
    started: null, completedAt: null, lastAssistant: null, completed: false, explicitDuration: null, lifecycle: false,
    title: null, titleOrdinal: Infinity, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, billing: new Map(), models: new Map(), capabilities: new Map() };
}

export function addTurn(root: TurnState, event: TurnEvent, ordinal: number): void {
  // [집계 정책] 가장 이른 시작과 가장 늦은 응답·완료 시각을 남기고 명시된 소요 시간은 최댓값을 쓴다.
  root.offset = Math.min(root.offset, event.offset);
  root.started = min(root.started, event.startedAt); root.lastAssistant = max(root.lastAssistant, event.lastAssistantAt);
  root.completed ||= Boolean(event.completed);
  if (event.completed) root.completedAt = max(root.completedAt, event.completedAt);
  if (event.durationQuality === 'exact') root.explicitDuration = max(root.explicitDuration, event.duration);
  if (event.completed && event.durationQuality === 'derived') root.lifecycle = true;

  // [집계 정책] 요청 제목은 원본에서 가장 먼저 등장한 값으로 고정한다.
  if (event.title !== undefined && ordinal < root.titleOrdinal) { root.title = event.title; root.titleOrdinal = ordinal; }
}

/** 원본 이벤트를 재생하지 않고 최소·최대·첫 제목 상태를 병합한다. */
export function mergeTurn(root: TurnState, state: TurnState, base: number): void {
  // [집계 정책] 파일별 시작·종료 시각과 완료 근거를 최솟값·최댓값·논리합으로 합친다.
  root.started = min(root.started, state.started); root.lastAssistant = max(root.lastAssistant, state.lastAssistant);
  root.completed ||= state.completed; root.completedAt = max(root.completedAt, state.completedAt);
  root.explicitDuration = max(root.explicitDuration, state.explicitDuration); root.lifecycle ||= state.lifecycle;

  // [집계 정책] 파일의 기준 순번을 더해 원본 전체에서 가장 이른 제목을 고른다.
  if (state.title !== null && base + state.titleOrdinal < root.titleOrdinal) {
    root.title = state.title; root.titleOrdinal = base + state.titleOrdinal;
  }
}

export function addCapability(root: Root, category: CapabilityUsageInput['category'], name: string, direction: 1 | -1 = 1): void {
  // [집계 정책] 분류·이름별 횟수를 증감하고 0이 된 항목은 집계에서 지운다.
  const id = key(category, name), previous = root.capabilities.get(id);
  const count = (previous?.usage_count ?? 0) + direction;
  if (count === 0) root.capabilities.delete(id);
  else if (previous) previous.usage_count = count;
  else root.capabilities.set(id, { category, name, usage_count: count });
}

export interface UsageContribution extends Pick<UsageEvent, 'billingMode' | 'model'> {
  tokens: Pick<TokenVector, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>;
}

export function accountedCacheRead(tokens: UsageContribution['tokens']): number {
  // [집계 정책] 캐시 읽기 토큰은 전체 입력 토큰까지만 인정한다.
  return Math.min(tokens.input, tokens.cacheRead);
}

export function accountedCacheWrite(tokens: UsageContribution['tokens']): number {
  // [집계 정책] 캐시 쓰기 토큰은 캐시 읽기분을 제외한 입력 범위에서만 인정한다.
  return Math.min(Math.max(0, tokens.input - tokens.cacheRead), tokens.cacheWrite);
}

/** 확정한 후보의 토큰, 모델, 결제 정보를 요청에 합친다. */
export function addUsage(root: Root, event: UsageContribution, collectCapabilities: boolean, direction: 1 | -1 = 1,
  cacheRead = accountedCacheRead(event.tokens), cacheWrite = accountedCacheWrite(event.tokens)): void {
  // [집계 정책] 캐시 범위를 보정한 토큰을 요청 합계에 더하거나 빼고 결제 유형별 응답 수도 갱신한다.
  const { tokens } = event;
  root.input += direction * tokens.input; root.output += direction * tokens.output;
  root.cacheRead += direction * cacheRead; root.cacheWrite += direction * cacheWrite;
  const billing = event.billingMode ?? 'unknown', billingCount = (root.billing.get(billing) ?? 0) + direction;
  if (billingCount === 0) root.billing.delete(billing); else root.billing.set(billing, billingCount);

  // [집계 정책] 모델별 응답 수와 토큰을 갱신하고 응답 수가 0인 모델은 제거한다.
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

  // [집계 정책] 도구 집계가 켜져 있으면 모델명 또는 사용량이 있는 응답을 모델 사용 횟수에도 반영한다.
  if (collectCapabilities && (model !== '' || tokens.input + tokens.output > 0)) addCapability(root, 'model', model, direction);
}

function timing(root: Root): { status: TurnSummaryInput['status']; completedAt: number | null;
  duration: number | null; quality: TurnSummaryInput['duration_quality'] } {
  // [집계 정책] 최신 상태를 우선하고 상태 이벤트가 없으면 완료 여부로 상태를 정한다.
  const latest = root.outcome?.event;
  const status = latest?.status === 'aborted' ? 'in_progress' : latest?.status ?? (root.completed ? 'completed' : 'in_progress');
  const completedAt = status === 'in_progress' ? null : latest ? latest.statusAt ?? null : root.completedAt;

  // [집계 정책] 명시된 소요 시간을 우선하고, 다음으로 시작·종료 시각 차이와 수명주기 근거를 사용한다.
  if (status !== 'in_progress' && root.explicitDuration !== null) return { status, completedAt, duration: root.explicitDuration, quality: 'exact' };
  if (root.started !== null && completedAt !== null && completedAt >= root.started) {
    const lifecycle = latest ? latest.durationQuality === 'derived' : root.lifecycle;
    return { status, completedAt, duration: completedAt - root.started,
      quality: status === 'completed' && lifecycle ? 'derived' : 'approximate' };
  }

  // [집계 정책] 완료된 요청은 마지막 응답 시각으로 근사하고 근거가 부족하면 소요 시간을 비워 둔다.
  if (status === 'completed' && root.started !== null && root.lastAssistant !== null && root.lastAssistant >= root.started) {
    return { status, completedAt, duration: root.lastAssistant - root.started, quality: 'approximate' };
  }
  return { status, completedAt, duration: null, quality: 'missing' };
}

export function materialize(roots: Iterable<Root>, sessions: Map<string, SourcePlan[]>, collectCapabilities: boolean,
  mainTurnsOnly = false): MemoryAggregateResult {
  const result: MemoryAggregateResult = { summaries: [], orphans: [] };
  // [DTO 정책] 세션별 메인 원본·이름·진단을 한 번 색인해 각 요청에 재사용한다.
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

  // [DTO 정책] 중단된 요청은 제외하고 메인 턴이 없는 요청은 원본 위치를 남긴다.
  for (const root of roots) {
    if (root.outcome?.event.status === 'aborted') continue;
    if (!root.hasMain) {
      result.orphans.push({ fileId: root.firstFile.id, offset: root.offset, provider: root.provider, session_id: root.session, rootId: root.rootId });
      if (mainTurnsOnly) continue;
    }
    const session = details.get(key(root.provider, root.session))!;
    const main = session.main ?? root.firstFile;

    // [진단 정책] 공통 진단과 요청별 진단을 파일·요청 ID 순서로 병합해 중복을 제거한다.
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

    // [DTO 정책] 모델명이 있거나 입력·출력 사용량이 있는 행만 요약에 담는다.
    const modelUsage: ModelUsageInput[] = [];
    for (const { usage } of root.models.values())
      if (usage.model !== '' || usage.input_tokens + usage.output_tokens > 0) modelUsage.push(usage);

    // [진단 정책] 소요 시간의 근거와 메인 턴의 존재 여부를 표시한다.
    const { status, completedAt, duration, quality } = timing(root);
    if (quality === 'missing') flags.add('duration-missing');
    if (quality === 'approximate') flags.add('duration-approximate');
    if (!root.hasMain) flags.add('missing-root-turn');

    // [DTO 정책] 요청 정보와 정렬된 모델·도구 합계를 묶고 결제 유형이 하나일 때만 확정한다.
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

  // [DTO 정책] 제공자·세션·요청 키의 순서로 요약을 정렬해 반환한다.
  result.summaries.sort((a, b) => compareText(a.provider, b.provider) || compareText(a.session_id, b.session_id) || compareText(a.root_turn_id, b.root_turn_id));
  return result;
}
