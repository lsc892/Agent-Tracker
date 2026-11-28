// Selects file-local response winners while preserving ordered Codex accounting evidence.
import { basename, dirname, sep } from 'node:path';
import { tokenUsageScore } from '../aggregation/winners';
import type { Provider } from '../db/types';
import { SummaryError } from '../jsonl';
import { hasJsonFields, type FixedJsonShape } from '../jsonl/projection';
import { StreamingFixedProjection } from '../jsonl/streamProjection';
import type { TokenVector } from '../types';
import { claudeTokens, codexTokens, displayName, object, project, sqlText, string, timestamp } from './common';
import { packLegacySignatures, type LegacySignatures } from './legacySignatures';
import { scoreThreadTokens, ThreadTokenBuffer, type ThreadTokens } from './threadTokens';

const scalar: FixedJsonShape = {};
const fields = (...keys: string[]): Record<string, FixedJsonShape> => Object.fromEntries(keys.map(key => [key, scalar]));
const claudeUsage: FixedJsonShape = { fields: fields('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'),
  keepNonempty: true };
const usage: FixedJsonShape = { fields: { ...fields('input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens'),
  input_tokens_details: { fields: fields('cached_tokens', 'cache_write_tokens') } } };
const legacyUsage: FixedJsonShape = { fields: { ...usage.fields, ...fields('reasoning_output_tokens', 'total_tokens') } };
const lineage: FixedJsonShape = { fields: { subagent: { fields: { thread_spawn: { fields: fields('parent_thread_id') } } } } };
const claudeTypes = new Set(['user', 'assistant', 'system', 'progress', 'file-history-snapshot', 'queue-operation', 'summary']);
const timestampPrefix = Buffer.from('{"timestamp":"');
const ordinalPrefix = Buffer.from(',"ordinal":');
const responseItemPrefix = Buffer.from(',"type":"response_item","payload":{');
const isoTimestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;

function matches(bytes: Buffer, start: number, end: number, prefix: Buffer): boolean {
  return start + prefix.length <= end && bytes.compare(prefix, 0, prefix.length, start, start + prefix.length) === 0;
}

// Fixed field paths make selection independent of the order of type and payload in a row.
export const threadFields: Record<Provider, FixedJsonShape> = {
  claude: { fields: { ...fields('type', 'timestamp', 'sessionId', 'requestId', 'isApiErrorMessage'),
    message: { fields: { id: scalar, model: scalar, usage: claudeUsage } } } },
  codex: { fields: { ...fields('type', 'timestamp'), payload: { fields: {
    ...fields('type', 'id', 'session_id', 'thread_id', 'turn_id', 'response_id', 'model', 'timestamp', 'started_at', 'completed_at',
      'forked_from_id', 'parent_thread_id'), usage, thread_token_usage: usage, turn_token_usage: usage,
    source: lineage, thread_source: lineage,
    info: { fields: { total_token_usage: legacyUsage, last_token_usage: legacyUsage } },
  } } } },
};

export interface ThreadResponse {
  responseId: string;
  requestId?: string;
  turnId?: string;
  model: string;
  /** Claude can use the winning row's order to break ties within a file. */
  order?: number;
}

export interface ThreadResponses {
  rows: ThreadResponse[];
  tokens: Float64Array<ArrayBuffer>;
}

export interface ThreadCheckpoint {
  responseIndex: number;
  model: string;
  threadTotal: ThreadTokens;
  turnTotal?: ThreadTokens;
}

export interface ThreadCheckpointInterval {
  start: ThreadCheckpoint;
  end: ThreadCheckpoint;
}

export interface ThreadLegacy {
  signatures: LegacySignatures;
  models: string[];
  /** Each row stores two consecutive vectors, the cumulative total and the last usage. */
  tokens: Float64Array<ArrayBuffer>;
  leadingCount: number;
  firstResponse?: { tokens: ThreadTokens; threadTotal: ThreadTokens };
}

type PendingLegacy = Omit<ThreadLegacy, 'signatures' | 'tokens'> & {
  signatures: string[];
  tokens: ThreadTokenBuffer;
};

export interface ThreadIdentity {
  sessionId: string;
  threadId: string;
}

export interface ThreadLog extends ThreadIdentity {
  projectKey: string;
  projectName: string;
  startedAt: number | null;
  lastAt: number | null;
  parentThreadId?: string;
  recordCount: number;
  responses: ThreadResponses;
  checkpoints: ThreadCheckpointInterval[];
  legacy?: ThreadLegacy;
}

export const responseKey = (row: Pick<ThreadResponse, 'turnId' | 'responseId'>): string => JSON.stringify([row.turnId, row.responseId]);

function identifier(value: unknown): string | undefined {
  const id = string(value);
  return id === undefined ? undefined : sqlText(id);
}

function tokenVector({ input, output, cacheRead, cacheWrite }: TokenVector): ThreadTokens {
  return { input, output, cacheRead, cacheWrite };
}

function optionalCheckpoint(value: unknown): ThreadTokens | undefined {
  // [진단 정책] 보조 누계의 토큰 형식이 지원되지 않으면 해당 누계만 건너뛴다.
  if (value == null) return undefined;
  try { return tokenVector(codexTokens(object(value))); }
  catch (error) {
    if (error instanceof SummaryError && error.code === 'unsupported-token-schema') return undefined;
    throw error;
  }
}

function checkpointSignature(value: TokenVector | undefined, raw: Record<string, unknown>): unknown {
  return value ? [value.input, value.output, value.cacheRead, value.cacheWrite, value.reasoning, raw.total_tokens ?? null] : null;
}

/** Parses the source's identity and ordered evidence for response and checkpoint accounting. */
export class ThreadLogParser {
  private threadId?: string;
  private sessionId?: string;
  private turnId?: string;
  private parentThreadId?: string;
  private forkedFromId?: string;
  private readonly project: ReturnType<typeof project>;
  private readonly claudeChild: boolean;
  private recognized = false;
  private startedAt: number | null = null;
  private lastAt: number | null = null;
  private model?: string;
  private recordCount = 0;
  private readonly responseIndices = new Map<string, number>();
  private readonly responses: ThreadResponse[] = [];
  private readonly responseTokens = new ThreadTokenBuffer();
  private readonly checkpoints: ThreadCheckpointInterval[] = [];
  private previousCheckpoint?: ThreadCheckpoint;
  private intervalUsage = 0;
  private legacy?: PendingLegacy;
  private responseItemValidator?: StreamingFixedProjection;

  constructor(private readonly provider: Provider, path: string, sourceRoot: string) {
    // [귀속 정책] Claude는 경로로 스레드와 프로젝트를, Codex는 원본 루트의 상위 경로로 프로젝트를 정한다.
    const parts = path.split(/[\\/]/);
    const subagents = provider === 'claude' ? parts.lastIndexOf('subagents') : -1;
    this.claudeChild = subagents > 0;
    this.project = project(provider === 'codex' ? dirname(sourceRoot)
      : this.claudeChild ? parts.slice(0, subagents - 1).join(sep) : dirname(path));
    if (provider === 'claude') {
      this.threadId = sqlText(basename(path).replace(/\.jsonl$/i, ''));
      this.sessionId = this.claudeChild ? sqlText(parts[subagents - 1]) : this.threadId;
    }
  }

  identity(): ThreadIdentity | undefined {
    return this.threadId ? { threadId: this.threadId, sessionId: this.sessionId ?? this.threadId } : undefined;
  }

  row(row: Record<string, unknown>, offset: number): void {
    if (this.provider === 'claude') this.claude(row, offset);
    else this.codex(row, offset);
  }

  readCompleteLine(bytes: Buffer, start: number, end: number): boolean {
    // Compact Codex response items contribute only their top-level timestamp.
    if (!matches(bytes, start, end, timestampPrefix)) return false;
    const timeStart = start + timestampPrefix.length;
    const timeEnd = bytes.indexOf(34, timeStart);
    if (timeEnd < 0 || !matches(bytes, timeEnd + 1, end, ordinalPrefix)) return false;
    const ordinalStart = timeEnd + 1 + ordinalPrefix.length;
    let next = ordinalStart;
    while (next < end && bytes[next] >= 48 && bytes[next] <= 57) next++;
    if (next === ordinalStart || next > ordinalStart + 1 && bytes[ordinalStart] === 48
      || !matches(bytes, next, end, responseItemPrefix)) return false;
    const time = bytes.toString('utf8', timeStart, timeEnd);
    if (!isoTimestamp.test(time)) return false;
    const observed = timestamp(time);
    if (observed === null) return false;

    // Require exactly the four root members above. The payload must be one valid JSON object.
    while (end > next && (bytes[end - 1] === 32 || bytes[end - 1] === 9 || bytes[end - 1] === 13)) end--;
    const payloadStart = next + responseItemPrefix.length - 1;
    if (bytes[end - 1] !== 125 || bytes[end - 2] !== 125) return false;
    const validator = this.responseItemValidator ??= new StreamingFixedProjection();
    validator.reset(0);
    validator.append(bytes, payloadStart, end - 1);
    if (!validator.isCompleteObject()) return false;
    this.observeTime(observed);
    return true;
  }

  finish(): ThreadLog {
    const identity = this.identity();
    if (!identity || !this.recognized) throw new SummaryError('unsupported-schema');
    // [DTO 정책] 원본 식별자와 시간 범위에 파일별 winner, 누계 검증 근거를 묶어 ThreadLog를 만든다.
    const { projectKey, projectName } = this.project;
    const pending = this.legacy;
    const legacy = pending && {
      signatures: packLegacySignatures(pending.signatures), models: pending.models, tokens: pending.tokens.values,
      leadingCount: pending.leadingCount, firstResponse: pending.firstResponse,
    };
    return { ...identity, projectKey: sqlText(projectKey), projectName: sqlText(projectName), startedAt: this.startedAt, lastAt: this.lastAt,
      parentThreadId: this.forkedFromId ?? this.parentThreadId, recordCount: this.recordCount,
      responses: { rows: this.responses, tokens: this.responseTokens.values }, checkpoints: this.checkpoints, legacy };
  }

  private observeTime(value: number | null): void {
    if (value === null) return;
    this.startedAt = this.startedAt === null ? value : Math.min(this.startedAt, value);
    this.lastAt = this.lastAt === null ? value : Math.max(this.lastAt, value);
  }

  private claude(row: Record<string, unknown>, offset: number): void {
    // [파싱 정책] 메인 로그의 세션 ID와 전체 시간 범위를 추적하고 assistant 행의 사용량만 읽는다.
    const type = string(row.type);
    if (!type) return;
    if (!this.claudeChild) {
      const session = identifier(row.sessionId);
      if (session) this.sessionId = this.threadId = session;
    }
    this.recognized ||= claudeTypes.has(type);
    this.observeTime(timestamp(row.timestamp));
    if (type !== 'assistant') return;
    const message = object(row.message), raw = object(message.usage);
    if (!hasJsonFields(raw)) return;
    const tokens = claudeTokens(raw), model = displayName(message.model);
    if ((model === '<synthetic>' || row.isApiErrorMessage === true) && tokens.input + tokens.output === 0) return;

    // [Winner 정책] 메시지 ID와 요청 ID를 묶어 파일 내 중복 응답을 비교한다.
    const responseId = identifier(message.id);
    if (!responseId) throw new SummaryError('missing-response-id', offset);
    const requestId = identifier(row.requestId);
    const order = this.recordCount++;
    const index = this.winnerIndex(JSON.stringify([responseId, requestId]), tokens);
    if (index === undefined) return;
    this.responses[index] = { responseId, requestId, model: model === '<synthetic>' ? '' : sqlText(model ?? ''), order };
    this.responseTokens.write(index, tokens);
  }

  private codex(row: Record<string, unknown>, offset: number): void {
    // [파싱 정책] session_meta에서 스레드와 부모를 식별하고, 행 유형에 따라 응답·턴 문맥·레거시 누계를 읽는다.
    const type = row.type, payload = object(row.payload);
    if (type === 'session_meta') {
      const threadId = identifier(payload.id);
      if (!threadId) throw new SummaryError('missing-session-id', offset);
      if (this.threadId && this.threadId !== threadId) return;
      this.threadId = threadId;
      this.sessionId = identifier(payload.session_id) ?? this.sessionId;
      const source = object(payload.source ?? payload.thread_source);
      const spawn = object(object(source.subagent).thread_spawn);
      this.forkedFromId = identifier(payload.forked_from_id) ?? this.forkedFromId;
      this.parentThreadId = identifier(payload.parent_thread_id) ?? identifier(spawn.parent_thread_id) ?? this.parentThreadId;
      this.model = displayName(payload.model) ?? this.model;
      this.recognized = true;
    } else if (type === 'token_usage_record') {
      const threadId = identifier(payload.thread_id);
      if (this.threadId && threadId && threadId !== this.threadId) return;
      this.threadId ??= threadId;
      if (!this.threadId) throw new SummaryError('missing-session-id', offset);
      this.sessionId = identifier(payload.session_id) ?? this.sessionId;
      this.turnId = identifier(payload.turn_id) ?? this.turnId;
      this.recordResponse(payload, offset);
      this.recognized = true;
    } else if (type === 'turn_context') {
      this.turnId = identifier(payload.turn_id) ?? this.turnId;
      this.model = displayName(payload.model);
    } else if (type === 'event_msg') {
      this.turnId = identifier(payload.turn_id) ?? this.turnId;
      if (payload.type === 'token_count' && this.threadId) this.recordLegacy(object(payload.info), this.codexModel(payload));
    }

    // [파싱 정책] 행 시각과 이벤트의 시작·종료 시각을 밀리초로 맞춰 시간 범위를 갱신한다.
    this.observeTime(timestamp(row.timestamp) ?? timestamp(payload.timestamp));
    if (type === 'event_msg') {
      const time = payload.type === 'task_started' ? payload.started_at : payload.completed_at;
      this.observeTime(timestamp(typeof time === 'number' ? time * 1000 : time));
    }
  }

  private codexModel(payload: Record<string, unknown>): string {
    return sqlText(displayName(payload.model) ?? this.model ?? '');
  }

  private winnerIndex(key: string, tokens: ThreadTokens): number | undefined {
    // [Winner 정책] 입력+출력 토큰이 많은 후보를 택하고 동점이면 나중 행으로 교체하되 첫 등장 인덱스를 유지한다.
    const index = this.responseIndices.get(key);
    if (index !== undefined)
      return tokenUsageScore(tokens.input, tokens.output) >= scoreThreadTokens(this.responseTokens.values, index) ? index : undefined;
    const next = this.responses.length;
    this.responseIndices.set(key, next);
    return next;
  }

  private recordResponse(payload: Record<string, unknown>, offset: number): void {
    // [파싱 정책] 응답 ID와 턴 ID를 확인하고 사용량을 공통 토큰 필드로 정규화한다.
    const responseId = identifier(payload.response_id);
    if (!responseId) throw new SummaryError('missing-response-id', offset);
    if (!this.turnId) throw new SummaryError('missing-root-turn', offset);
    const turnId = this.turnId;
    const tokens = codexTokens(object(payload.usage));
    this.recordCount++;

    // [Winner 정책] 턴 ID와 응답 ID가 같은 후보를 파일 내 winner 하나로 합친다.
    const responseIndex = this.winnerIndex(JSON.stringify([turnId, responseId]), tokens);
    if (responseIndex === undefined) return;
    const first = responseIndex === this.responses.length;
    const model = this.codexModel(payload);
    this.responses[responseIndex] = { responseId, turnId, model };
    this.responseTokens.write(responseIndex, tokens);
    if (!first) return;

    // [집계 정책] 첫 등장 행의 사용량으로 구간 합계를 늘리고 누계가 있으면 체크포인트를 기록한다.
    this.intervalUsage += tokens.input + tokens.output;
    const threadTotal = optionalCheckpoint(payload.thread_token_usage);
    if (!threadTotal) return;
    if (responseIndex === 0 && this.legacy?.leadingCount) this.legacy.firstResponse = { tokens, threadTotal };
    this.recordCheckpoint({ responseIndex, model, threadTotal,
      turnTotal: optionalCheckpoint(payload.turn_token_usage) });
  }

  private recordCheckpoint(end: ThreadCheckpoint): void {
    // [집계 정책] 체크포인트마다 구간을 닫고 응답으로 설명되지 않은 증가량이 있을 수 있는 구간만 남긴다.
    const start = this.previousCheckpoint;
    const usage = this.intervalUsage;
    this.previousCheckpoint = end;
    this.intervalUsage = 0;
    if (!start) return;
    const input = end.threadTotal.input - start.threadTotal.input;
    const output = end.threadTotal.output - start.threadTotal.output;
    if (input < 0 || output < 0) return;
    const increase = input + output;
    // Final response winners can only raise the input-plus-output sum for the interval.
    if (Number.isSafeInteger(increase) && Number.isSafeInteger(usage) && increase <= usage) return;
    this.checkpoints.push({ start, end });
  }

  private recordLegacy(info: Record<string, unknown>, model: string): void {
    // [집계 정책] 누계와 개별 사용량을 순서대로 보존하고 첫 응답 이전 기록 수를 따로 센다.
    const rawTotal = object(info.total_token_usage), rawLast = object(info.last_token_usage);
    const total = info.total_token_usage ? codexTokens(rawTotal) : undefined;
    const last = info.last_token_usage ? codexTokens(rawLast) : undefined;
    if (!total && !last) return;
    // Timestamps can change when the same legacy prefix is written to a fork's file.
    const signature = JSON.stringify([this.turnId ?? null, checkpointSignature(total, rawTotal), checkpointSignature(last, rawLast)]);
    const legacy = this.legacy ??= { signatures: [], models: [], tokens: new ThreadTokenBuffer(), leadingCount: 0 };
    this.recordCount++;
    if (!this.responses.length) legacy.leadingCount++;
    const index = legacy.signatures.length;
    legacy.signatures.push(signature);
    legacy.models.push(model);
    legacy.tokens.write(index * 2, total);
    legacy.tokens.write(index * 2 + 1, last);
  }
}
