import { SummaryError } from '../jsonl';
import type { FileContext, ParsedIdentity, ParseSink, TokenVector } from '../types';
import { billingMode, codexTokens, displayName, number, object, project, requestTitle, string, timestamp, tokenFlags } from './common';
import { toolCapabilities } from './capabilities';

/** Codex lifecycle payloads use Unix seconds; row timestamps and durations keep their existing units. */
function lifecycleTimestamp(value: unknown): number | null {
  return timestamp(typeof value === 'number' ? value * 1000 : value);
}

interface CodexRecordContext {
  payload: Record<string, unknown>;
  offset: number;
  identity: ParsedIdentity;
  suppliedRoot: string | undefined;
  suppliedTurn: string | undefined;
  rowTimestamp: unknown;
}

export class CodexCurrentParserAdapter {
  private identityValue: ParsedIdentity | undefined;
  private root: string | undefined;
  private turn: string | undefined;
  private sawCurrent = false;
  private sawLegacy = false;
  private legacySignature: string | undefined;
  private highWater: TokenVector = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  private currentClosed = false;
  private hasUserInTurn = false;
  private pendingLifecycle = false;
  private hasExplicitRoot = false;
  private model: string | undefined;
  private billing: import('../db/types').BillingMode = 'unknown';

  constructor(private readonly context: FileContext, private readonly sink: ParseSink) {}

  row(row: Record<string, unknown>, offset: number): void {
    const payload = object(row.payload);
    if (row.type === 'session_meta') {
      this.sessionMetadata(payload, offset);
      return;
    }
    if (!this.identityValue) {
      if (row.type === 'token_usage_record') throw new SummaryError('missing-session-id', offset);
      return;
    }
    const suppliedRoot = string(payload.root_turn_id);
    if (suppliedRoot && ['turn_context', 'token_usage_record', 'event_msg'].includes(String(row.type))) this.hasExplicitRoot = true;
    const record: CodexRecordContext = { payload, offset, identity: this.identityValue, suppliedRoot,
      suppliedTurn: string(payload.turn_id), rowTimestamp: row.timestamp };
    switch (row.type) {
      case 'turn_context': this.turnContext(record); break;
      case 'token_usage_record': this.currentUsage(record); break;
      case 'response_item': this.responseCapabilities(record); break;
      case 'event_msg': this.eventLifecycle(record); break;
    }
  }

  private sessionMetadata(payload: Record<string, unknown>, offset: number): void {
    const id = string(payload.id) ?? string(payload.thread_id);
    if (!id) throw new SummaryError('missing-session-id', offset);
    // Forked rollouts can contain copied parent session_meta rows. The first identity owns this file.
    if (this.identityValue && id !== this.identityValue.threadId) return;
    const source = object(payload.source ?? payload.thread_source);
    const subagent = object(source.subagent);
    const spawned = object(subagent.thread_spawn);
    const parent = string(payload.parent_thread_id) ?? string(spawned.parent_thread_id) ?? this.identityValue?.parentThreadId ?? null;
    const cwd = string(payload.cwd);
    this.identityValue = { sessionId: string(payload.session_id) ?? string(payload.sessionId) ?? this.identityValue?.sessionId ?? parent ?? id,
      threadId: id, parentThreadId: parent, isMain: parent === null,
      forkedFromId: string(payload.forked_from_id) ?? this.identityValue?.forkedFromId ?? null,
      sessionName: displayName(payload.thread_name) ?? displayName(payload.name) ?? displayName(payload.title) ?? this.identityValue?.sessionName,
      ...this.projectMetadata(cwd),
    };
    // A fork is not automatically a subagent; inherited history needs independently verified lineage.
    this.forkMissing = Boolean(this.identityValue.forkedFromId);
    this.model = displayName(payload.model) ?? this.model;
    if (payload.billing_mode !== undefined || payload.auth_mode !== undefined) this.billing = billingMode(payload.billing_mode ?? payload.auth_mode);
  }

  private projectMetadata(cwd: string | undefined): { projectKey: string; projectName: string } {
    if (cwd) return project(cwd);
    if (this.identityValue) return { projectKey: this.identityValue.projectKey, projectName: this.identityValue.projectName };
    return project(this.context.sourceRoot);
  }

  private turnContext(record: CodexRecordContext): void {
    const { payload, identity, suppliedRoot, suppliedTurn } = record;
    // Rootless subagents use their own turn ids; finish() gives the thread a separate session.
    const ownTurns = identity.isMain || !this.hasExplicitRoot;
    this.model = displayName(payload.model);
    if (payload.billing_mode !== undefined || payload.auth_mode !== undefined) this.billing = billingMode(payload.billing_mode ?? payload.auth_mode);
    if (suppliedTurn && suppliedTurn !== this.turn) { this.hasUserInTurn = false; this.currentClosed = false; }
    this.turn = suppliedTurn ?? this.turn;
    this.root = suppliedRoot ?? (ownTurns ? this.turn : this.root);
  }

  private currentUsage(record: CodexRecordContext): void {
    const { payload, offset, identity, suppliedRoot, suppliedTurn } = record;
    this.sawCurrent = true;
    // Mixed generations can coexist. Disk staging discards legacy usage if any current usage exists in this file.
    const rootId = suppliedRoot ?? (!identity.isMain && !this.hasExplicitRoot
      ? suppliedTurn ?? this.turn ?? this.root : this.root ?? suppliedTurn);
    const turnId = suppliedTurn ?? this.turn;
    const responseId = string(payload.response_id);
    if (!rootId || !turnId) throw new SummaryError('missing-root-turn', offset);
    if (!responseId) throw new SummaryError('missing-response-id', offset);
    this.root = rootId; this.turn = turnId;
    if (string(payload.session_id)) identity.sessionId = String(payload.session_id);
    const tokens = codexTokens(object(payload.usage));
    this.sink.event({ kind: 'usage', rootId, turnId, responseId, requestId: null,
      threadId: string(payload.thread_id) ?? identity.threadId, tokens, schema: 'current',
      model: displayName(payload.model) ?? this.model,
      billingMode: billingMode(payload.billing_mode ?? payload.auth_mode ?? this.billing),
      flags: [...tokenFlags(tokens), ...(this.forkMissing ? ['missing-parent'] : [])], offset });
    if (payload.turn_token_usage) this.sink.event({ kind: 'check', rootId, threadId: string(payload.thread_id) ?? identity.threadId,
      turnId, tokens: codexTokens(object(payload.turn_token_usage)), offset });
  }

  private responseCapabilities(record: CodexRecordContext): void {
    const { payload, offset, identity } = record;
    if (this.context.collectCapabilities !== false && this.root && ['function_call', 'custom_tool_call'].includes(String(payload.type))) {
      const name = string(payload.name);
      const eventId = string(payload.call_id) ?? string(payload.id);
      if (name && eventId) for (const use of toolCapabilities(name, payload.arguments ?? payload.input)) {
        this.sink.event({ kind: 'capability', rootId: this.root, threadId: identity.threadId,
          eventId: `${eventId}:${use.index}`, category: use.category, name: use.name, offset });
      }
    }
  }

  private eventLifecycle(record: CodexRecordContext): void {
    const { payload, offset, identity, suppliedRoot, suppliedTurn } = record;
    const time = timestamp(record.rowTimestamp);
    const ownTurns = identity.isMain || !this.hasExplicitRoot;
    if (suppliedTurn) this.turn = suppliedTurn;
    if (suppliedRoot) this.root = suppliedRoot;
    else if (ownTurns && suppliedTurn) this.root = suppliedTurn;
    switch (string(payload.type)) {
      case 'task_started':
        this.currentClosed = false; this.hasUserInTurn = false; this.pendingLifecycle = true;
        if (this.root) this.sink.event({ kind: 'turn', rootId: this.root, isMain: identity.isMain,
          startedAt: lifecycleTimestamp(payload.started_at) ?? time, status: 'in_progress',
          statusAt: lifecycleTimestamp(payload.started_at) ?? time, offset });
        break;
      case 'user_message':
        if (ownTurns && (!this.root || this.currentClosed || this.hasUserInTurn && !this.pendingLifecycle)) {
          this.root = string(payload.id) ?? (time === null ? undefined : `legacy-${time}`);
          this.turn = this.root;
        }
        this.hasUserInTurn = true; this.currentClosed = false; this.pendingLifecycle = false;
        if (this.root) this.sink.event({ kind: 'turn', rootId: this.root, isMain: identity.isMain, startedAt: time, title: requestTitle(payload.message),
          flags: this.root.startsWith('legacy-') ? ['missing-request-id'] : [], offset });
        break;
      case 'task_complete':
      case 'task_completed':
        this.currentClosed = true;
        if (!this.root) return;
        this.sink.event({ kind: 'turn', rootId: this.root, isMain: identity.isMain, completed: true,
          completedAt: lifecycleTimestamp(payload.completed_at) ?? time,
          duration: typeof payload.duration_ms === 'number' ? number(payload.duration_ms) : null,
          durationQuality: typeof payload.duration_ms === 'number' ? 'exact' : 'derived',
          status: 'completed', statusAt: lifecycleTimestamp(payload.completed_at) ?? time, offset });
        break;
      case 'turn_aborted':
        this.currentClosed = true; this.pendingLifecycle = false;
        if (this.root) this.sink.event({ kind: 'turn', rootId: this.root, isMain: identity.isMain,
          status: 'aborted', statusAt: lifecycleTimestamp(payload.completed_at) ?? time, offset });
        break;
      case 'agent_message':
        if (this.root) this.sink.event({ kind: 'turn', rootId: this.root, isMain: identity.isMain, lastAssistantAt: time, offset });
        break;
      case 'token_count':
        if (!this.sawCurrent) this.legacyTokens(record);
        break;
    }
  }

  private forkMissing = false;
  private legacyTokens(record: CodexRecordContext): void {
    const { payload, offset } = record;
    const info = object(payload.info);
    if (!info.total_token_usage && !info.last_token_usage) return;
    if (this.identityValue && !this.identityValue.isMain && !this.hasExplicitRoot && (!this.root || !this.turn)) {
      this.root = this.turn = this.turn ?? `legacy-${this.identityValue.threadId}`;
    }
    if (!this.root || !this.turn || !this.identityValue) throw new SummaryError('missing-root-turn', offset);
    this.sawLegacy = true;
    const total = info.total_token_usage ? codexTokens(object(info.total_token_usage)) : {...this.highWater};
    const last = info.last_token_usage ? codexTokens(object(info.last_token_usage)) : null;
    const signature = JSON.stringify([total, last]);
    if (signature === this.legacySignature) return;
    this.legacySignature = signature;
    const tokens = { ...total };
    const flags: string[] = this.forkMissing ? ['missing-parent'] : [];
    for (const key of Object.keys(total) as (keyof TokenVector)[]) {
      if (total[key] < this.highWater[key]) flags.push('counter-regression');
      tokens[key] = last ? last[key] : Math.max(0, total[key] - this.highWater[key]);
      this.highWater[key] = Math.max(this.highWater[key], total[key]);
    }
    this.sink.event({ kind: 'usage', rootId: this.root, turnId: this.turn,
      responseId: `legacy-${signature}`, requestId: null,
      threadId: this.identityValue.threadId, tokens, model: displayName(payload.model) ?? this.model,
      billingMode: billingMode(payload.billing_mode ?? payload.auth_mode ?? this.billing),
      schema: 'legacy', flags: [...new Set([...flags, ...tokenFlags(tokens)])], offset });
  }

  finish(): void {
    const identity = this.getIdentity();
    if (!identity) throw new SummaryError('unsupported-schema');
    this.sink.identity(identity);
  }

  /** session_meta can establish reassignment before a later malformed row. */
  getIdentity(): ParsedIdentity | undefined {
    const identity = this.identityValue;
    if (!identity || identity.isMain || this.hasExplicitRoot) return identity;
    return { ...identity, sessionId: identity.threadId, parentThreadId: null, isMain: true,
      forkedFromId: identity.forkedFromId ?? identity.parentThreadId, standaloneSubagent: true };
  }
}

export class CodexLegacyParserAdapter extends CodexCurrentParserAdapter {}
