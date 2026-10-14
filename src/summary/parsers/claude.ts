import { basename, dirname, sep } from 'node:path';
import { SummaryError } from '../jsonl';
import type { FileContext, ParsedIdentity, ParseSink } from '../types';
import type { BillingMode } from '../db/types';
import { billingMode, claudeTokens, displayName, number, object, project, requestTitle, string, timestamp } from './common';
import { toolCapabilities } from './capabilities';

interface ClaudeRowContext {
  type: string | undefined;
  offset: number;
  time: number | null;
  hasBillingMetadata: boolean;
  billingValue: unknown;
  sessionId: string | undefined;
  cwd: string | undefined;
  sessionName: string | undefined;
  promptId: string | undefined;
  uuid: string | undefined;
  external: boolean;
  content: unknown;
  usage: Record<string, unknown>;
  responseId: string | undefined;
  requestId: string | undefined;
  model: string | undefined;
  usageBillingValue: unknown;
  apiError: boolean;
  stopReason: unknown;
  subtype: unknown;
  preventedContinuation: boolean | undefined;
  durationMs: number | undefined;
  rootId: string | undefined;
}

export class ClaudeParserAdapter {
  private currentRoot: string | undefined;
  private identityValue: ParsedIdentity;
  private recognized = false;
  private apiFailed = false;
  private stopBlocked = false;
  private customTitle = false;
  private billing: BillingMode = 'unknown';

  constructor(private readonly context: FileContext, private readonly sink: ParseSink) {
    const parts = context.path.split(/[\\/]/);
    const subagentIndex = parts.lastIndexOf('subagents');
    const isMain = subagentIndex < 0;
    const session = isMain ? basename(context.path, '.jsonl') : parts[subagentIndex - 1];
    this.identityValue = { sessionId: session ?? '', threadId: isMain ? session ?? '' : basename(context.path, '.jsonl'),
      parentThreadId: isMain ? null : session ?? null, isMain,
      ...project(isMain ? dirname(context.path) : parts.slice(0, subagentIndex - 1).join(sep)) };
  }

  row(row: Record<string, unknown>, offset: number): void {
    const context = this.readRow(row, offset);
    this.updateMetadata(context);
    if (!context.type) return;
    this.identifyRequest(context);
    this.recordToolUsage(context);
    // Keep the request event after tool events and before assistant usage.
    if (context.external && context.rootId) this.sink.event({ kind: 'turn', rootId: context.rootId,
      isMain: this.identityValue.isMain, startedAt: context.time, title: requestTitle(context.content),
      flags: context.promptId ? [] : ['missing-request-id'], offset: context.offset });
    this.recordAssistant(context);
    this.recordSystemLifecycle(context);
  }

  private readRow(row: Record<string, unknown>, offset: number): ClaudeRowContext {
    const type = string(row.type);
    const message = object(row.message);
    const content = message.content;
    const toolResult = Array.isArray(content) && content.some((item: unknown) => object(item).type === 'tool_result');
    return {
      type, offset, time: timestamp(row.timestamp),
      hasBillingMetadata: row.billing_mode !== undefined || row.auth_mode !== undefined,
      billingValue: row.billing_mode ?? row.auth_mode,
      sessionId: string(row.sessionId), cwd: string(row.cwd),
      sessionName: type === 'custom-title' ? displayName(row.customTitle)
        : type === 'ai-title' ? displayName(row.aiTitle) : undefined,
      promptId: string(row.promptId), uuid: string(row.uuid),
      external: type === 'user' && row.isMeta !== true && !toolResult && row.isSidechain !== true,
      content, usage: object(message.usage), responseId: string(message.id), requestId: string(row.requestId),
      model: displayName(message.model), usageBillingValue: message.billing_mode ?? row.billing_mode ?? row.auth_mode,
      apiError: row.isApiErrorMessage === true, stopReason: message.stop_reason, subtype: row.subtype,
      preventedContinuation: typeof row.preventedContinuation === 'boolean' ? row.preventedContinuation : undefined,
      durationMs: typeof row.durationMs === 'number' ? number(row.durationMs) : undefined,
      rootId: undefined,
    };
  }

  private updateMetadata(context: ClaudeRowContext): void {
    // Billing metadata is accepted even on rows without a recognized type.
    if (context.hasBillingMetadata) this.billing = billingMode(context.billingValue);
    const { type, sessionName, sessionId, cwd } = context;
    if (!type) return;
    if (this.identityValue.isMain && (type === 'ai-title' || type === 'custom-title')) {
      if (sessionName && (type === 'custom-title' || !this.customTitle)) {
        this.identityValue.sessionName = sessionName;
        this.customTitle = type === 'custom-title';
      }
    }
    if (['user', 'assistant', 'system', 'progress', 'file-history-snapshot', 'queue-operation', 'summary'].includes(type)) this.recognized = true;
    // Subagent sessionId is sometimes its own thread. Its path establishes the parent session.
    if (sessionId && this.identityValue.isMain) this.identityValue.sessionId = this.identityValue.threadId = sessionId;
    if (cwd) Object.assign(this.identityValue, project(cwd));
  }

  private identifyRequest(context: ClaudeRowContext): void {
    const { promptId, uuid, external } = context;
    const previousRoot = this.currentRoot;
    if (promptId) this.currentRoot = promptId;
    if (external && !this.currentRoot) this.currentRoot = uuid;
    if (external && !promptId && uuid) this.currentRoot = uuid;
    context.rootId = this.currentRoot;
    if (external || context.rootId !== previousRoot) { this.apiFailed = false; this.stopBlocked = false; }
  }

  private recordToolUsage(context: ClaudeRowContext): void {
    const { type, rootId, content, offset } = context;
    if (this.context.collectCapabilities === false || !rootId || type !== 'assistant' || !Array.isArray(content)) return;
    for (const item of content) {
      const call = object(item);
      const eventId = string(call.id);
      const name = string(call.name);
      if (call.type !== 'tool_use' || !eventId || !name) continue;
      for (const use of toolCapabilities(name, call.input)) this.sink.event({ kind: 'capability', rootId,
        threadId: this.identityValue.threadId, eventId: `${eventId}:${use.index}`, category: use.category, name: use.name, offset });
    }
  }

  private recordAssistant(context: ClaudeRowContext): void {
    if (context.type !== 'assistant') return;
    const { rootId, usage, model, responseId, requestId, apiError, time, offset } = context;
    if (Object.keys(usage).length > 0) {
      const tokens = claudeTokens(usage);
      const synthetic = model === '<synthetic>';
      // Local error notices carry a zero usage vector, rather than an API response.
      // Retain any reported tokens, but never treat the placeholder as a model.
      if ((!synthetic && !apiError) || tokens.input + tokens.output > 0) {
        if (!rootId) throw new SummaryError('missing-root-turn', offset);
        if (!responseId) throw new SummaryError('missing-response-id', offset);
        this.sink.event({ kind: 'usage', rootId, responseId, requestId: requestId ?? null,
          threadId: this.identityValue.threadId, turnId: rootId, tokens,
          model: synthetic ? undefined : model, billingMode: billingMode(context.usageBillingValue ?? this.billing), offset });
      }
    }
    if (!rootId) return;
    this.apiFailed = apiError;
    this.stopBlocked = false;
    const stopped = !this.apiFailed && (context.stopReason === 'end_turn' || context.stopReason === 'stop_sequence');
    this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, lastAssistantAt: time,
      completed: stopped, completedAt: stopped ? time : null, durationQuality: 'approximate',
      status: this.apiFailed ? 'failed' : stopped ? 'completed' : 'in_progress', statusAt: time,
      flags: this.apiFailed ? ['api-error'] : [], offset });
  }

  private recordSystemLifecycle(context: ClaudeRowContext): void {
    const { type, rootId, subtype, preventedContinuation, durationMs, time, offset } = context;
    if (type !== 'system' || !rootId) return;
    if (subtype === 'stop_hook_summary') {
      // Only an explicit outcome can supersede the assistant timestamp fallback.
      if (preventedContinuation === undefined) return;
      this.stopBlocked = preventedContinuation;
      const completed = !this.stopBlocked && !this.apiFailed;
      this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, completed,
        completedAt: completed ? time : null, durationQuality: 'derived',
        status: this.stopBlocked ? 'in_progress' : this.apiFailed ? 'failed' : 'completed', statusAt: time, offset });
    } else if (!this.stopBlocked && subtype === 'turn_duration' && durationMs !== undefined) {
      // A blocked stop hook must keep the request open, including later duration records.
      this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, duration: durationMs,
        durationQuality: 'exact', completed: !this.apiFailed, completedAt: this.apiFailed ? null : time,
        status: this.apiFailed ? 'failed' : 'completed', statusAt: time, offset });
    } else if (!this.stopBlocked && ['stop', 'turn_complete', 'task_complete'].includes(String(subtype))) {
      this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, completed: !this.apiFailed,
        completedAt: this.apiFailed ? null : time, durationQuality: 'derived',
        status: this.apiFailed ? 'failed' : 'completed', statusAt: time, offset });
    }
  }

  finish(): void {
    if (!this.recognized || !this.identityValue.sessionId) throw new SummaryError('unsupported-schema');
    this.sink.identity(this.identityValue);
  }

  /** Preserve the known parent/session even when a later line makes the file fail. */
  getIdentity(): ParsedIdentity { return this.identityValue; }
}
