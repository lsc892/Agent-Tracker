// Selects file-local response winners while preserving ordered Codex accounting evidence.
import { basename, dirname, sep } from 'node:path';
import { usageScore } from '../aggregation/winners';
import type { Provider } from '../db/types';
import { SummaryError } from '../jsonl';
import { hasJsonFields, type FixedJsonShape } from '../jsonl/projection';
import type { TokenVector } from '../types';
import { claudeTokens, codexTokens, displayName, object, project, sqlText, string, timestamp } from './common';

const scalar: FixedJsonShape = {};
const fields = (...keys: string[]): Record<string, FixedJsonShape> => Object.fromEntries(keys.map(key => [key, scalar]));
const claudeUsage: FixedJsonShape = { fields: fields('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'),
  keepNonempty: true };
const usage: FixedJsonShape = { fields: { ...fields('input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens'),
  input_tokens_details: { fields: fields('cached_tokens', 'cache_write_tokens') } } };
const legacyUsage: FixedJsonShape = { fields: { ...usage.fields, ...fields('reasoning_output_tokens', 'total_tokens') } };
const lineage: FixedJsonShape = { fields: { subagent: { fields: { thread_spawn: { fields: fields('parent_thread_id') } } } } };
const claudeTypes = new Set(['user', 'assistant', 'system', 'progress', 'file-history-snapshot', 'queue-operation', 'summary']);

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

export type ThreadTokens = Pick<TokenVector, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>;

export interface ThreadResponse {
  responseId: string;
  requestId?: string;
  turnId?: string;
  tokens: ThreadTokens;
  model: string;
  /** Claude can use the winning row's order to break ties within a file. */
  order?: number;
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
  total?: ThreadTokens;
  last?: ThreadTokens;
  signature: string;
  model: string;
}

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
  responses: ThreadResponse[];
  checkpoints: ThreadCheckpointInterval[];
  legacy: ThreadLegacy[];
  leadingLegacyCount: number;
  firstResponse?: { tokens: ThreadTokens; threadTotal: ThreadTokens };
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
  private readonly checkpoints: ThreadCheckpointInterval[] = [];
  private previousCheckpoint?: ThreadCheckpoint;
  private intervalUsage = 0;
  private readonly legacy: ThreadLegacy[] = [];
  private leadingLegacyCount = 0;
  private firstResponse?: ThreadLog['firstResponse'];

  constructor(private readonly provider: Provider, path: string, sourceRoot: string) {
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

  finish(): ThreadLog {
    const identity = this.identity();
    if (!identity || !this.recognized) throw new SummaryError('unsupported-schema');
    // [DTO 정책] 원본 식별자와 시간 범위에 파일별 winner, 누계 검증 근거를 묶어 ThreadLog를 만든다.
    const { projectKey, projectName } = this.project;
    return { ...identity, projectKey: sqlText(projectKey), projectName: sqlText(projectName), startedAt: this.startedAt, lastAt: this.lastAt,
      parentThreadId: this.forkedFromId ?? this.parentThreadId, recordCount: this.recordCount,
      responses: this.responses, checkpoints: this.checkpoints, legacy: this.legacy,
      leadingLegacyCount: this.leadingLegacyCount, firstResponse: this.firstResponse };
  }

  private observeTime(value: number | null): void {
    if (value === null) return;
    this.startedAt = this.startedAt === null ? value : Math.min(this.startedAt, value);
    this.lastAt = this.lastAt === null ? value : Math.max(this.lastAt, value);
  }

  private claude(row: Record<string, unknown>, offset: number): void {
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
    const responseId = identifier(message.id);
    if (!responseId) throw new SummaryError('missing-response-id', offset);
    const requestId = identifier(row.requestId);
    this.keepResponse(JSON.stringify([responseId, requestId]), { responseId, requestId, tokens: tokenVector(tokens),
      model: model === '<synthetic>' ? '' : sqlText(model ?? ''), order: this.recordCount++ });
  }

  private codex(row: Record<string, unknown>, offset: number): void {
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
    this.observeTime(timestamp(row.timestamp) ?? timestamp(payload.timestamp));
    if (type === 'event_msg') {
      const time = payload.type === 'task_started' ? payload.started_at : payload.completed_at;
      this.observeTime(timestamp(typeof time === 'number' ? time * 1000 : time));
    }
  }

  private codexModel(payload: Record<string, unknown>): string {
    return sqlText(displayName(payload.model) ?? this.model ?? '');
  }

  /** Replacements keep their first appearance index and carry the winning row's order. */
  private keepResponse(key: string, candidate: ThreadResponse): number | undefined {
    const index = this.responseIndices.get(key);
    if (index !== undefined) {
      if (usageScore(candidate) >= usageScore(this.responses[index])) this.responses[index] = candidate;
      return;
    }
    const next = this.responses.length;
    this.responseIndices.set(key, next);
    this.responses.push(candidate);
    return next;
  }

  private recordResponse(payload: Record<string, unknown>, offset: number): void {
    const responseId = identifier(payload.response_id);
    if (!responseId) throw new SummaryError('missing-response-id', offset);
    if (!this.turnId) throw new SummaryError('missing-root-turn', offset);
    const candidate = { responseId, turnId: this.turnId, model: this.codexModel(payload),
      tokens: tokenVector(codexTokens(object(payload.usage))) };
    this.recordCount++;
    const responseIndex = this.keepResponse(responseKey(candidate), candidate);
    if (responseIndex === undefined) return;
    this.intervalUsage += candidate.tokens.input + candidate.tokens.output;
    const threadTotal = optionalCheckpoint(payload.thread_token_usage);
    if (!threadTotal) return;
    if (responseIndex === 0 && this.leadingLegacyCount) this.firstResponse = { tokens: candidate.tokens, threadTotal };
    this.recordCheckpoint({ responseIndex, model: candidate.model, threadTotal,
      turnTotal: optionalCheckpoint(payload.turn_token_usage) });
  }

  private recordCheckpoint(end: ThreadCheckpoint): void {
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
    const rawTotal = object(info.total_token_usage), rawLast = object(info.last_token_usage);
    const total = info.total_token_usage ? codexTokens(rawTotal) : undefined;
    const last = info.last_token_usage ? codexTokens(rawLast) : undefined;
    if (!total && !last) return;
    // Timestamps can change when the same legacy prefix is written to a fork's file.
    const signature = JSON.stringify([this.turnId ?? null, checkpointSignature(total, rawTotal), checkpointSignature(last, rawLast)]);
    this.recordCount++;
    if (!this.responses.length) this.leadingLegacyCount++;
    this.legacy.push({ signature, model, total: total && tokenVector(total), last: last && tokenVector(last) });
  }
}
