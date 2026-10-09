import { basename, dirname, sep } from 'node:path';
import { SummaryError } from '../jsonl';
import type { FileContext, ParsedIdentity, ParseSink } from '../types';
import { billingMode, claudeTokens, displayName, number, object, project, requestTitle, string, timestamp } from './common';
import { toolCapabilities } from './capabilities';

export class ClaudeParserAdapter {
  private currentRoot: string | undefined;
  private identityValue: ParsedIdentity;
  private recognized = false;
  private apiFailed = false;
  private stopBlocked = false;
  private customTitle = false;
  private billing: import('../db/types').BillingMode = 'unknown';

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
    if (row.billing_mode !== undefined || row.auth_mode !== undefined) this.billing = billingMode(row.billing_mode ?? row.auth_mode);
    const type = string(row.type);
    if (!type) return;
    if (this.identityValue.isMain && (type === 'ai-title' || type === 'custom-title')) {
      const name = displayName(type === 'custom-title' ? row.customTitle : row.aiTitle);
      if (name && (type === 'custom-title' || !this.customTitle)) {
        this.identityValue.sessionName = name;
        this.customTitle = type === 'custom-title';
      }
    }
    if (['user', 'assistant', 'system', 'progress', 'file-history-snapshot', 'queue-operation', 'summary'].includes(type)) this.recognized = true;
    const sessionId = string(row.sessionId);
    // Subagent sessionId is sometimes its own thread. Its path establishes the parent session.
    if (sessionId && this.identityValue.isMain) this.identityValue.sessionId = this.identityValue.threadId = sessionId;
    const cwd = string(row.cwd);
    if (cwd) Object.assign(this.identityValue, project(cwd));
    const explicitPrompt = string(row.promptId);
    const message = object(row.message);
    const content = message.content;
    const toolResult = Array.isArray(content) && content.some((item: unknown) => object(item).type === 'tool_result');
    const external = type === 'user' && row.isMeta !== true && !toolResult && row.isSidechain !== true;
    const previousRoot = this.currentRoot;
    if (explicitPrompt) this.currentRoot = explicitPrompt;
    if (external && !this.currentRoot) this.currentRoot = string(row.uuid);
    if (external && !explicitPrompt && string(row.uuid)) this.currentRoot = string(row.uuid);
    const rootId = this.currentRoot;
    if (external || rootId !== previousRoot) { this.apiFailed = false; this.stopBlocked = false; }
    const time = timestamp(row.timestamp);
    if (this.context.collectCapabilities !== false && rootId && type === 'assistant' && Array.isArray(content)) {
      for (const item of content) {
        const call=object(item);
        const eventId=string(call.id);
        const name=string(call.name);
        if (call.type !== 'tool_use' || !eventId || !name) continue;
        for (const use of toolCapabilities(name,call.input)) this.sink.event({kind:'capability',rootId,
          threadId:this.identityValue.threadId,eventId:`${eventId}:${use.index}`,category:use.category,name:use.name,offset});
      }
    }
    if (external && rootId) this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain,
      startedAt: time, title: requestTitle(content), flags: explicitPrompt ? [] : ['missing-request-id'], offset });
    if (type === 'assistant' && Object.keys(object(message.usage)).length > 0) {
      const tokens = claudeTokens(object(message.usage));
      const model = displayName(message.model);
      const synthetic = model === '<synthetic>';
      // Local error notices carry a zero usage vector, rather than an API response.
      // Retain any reported tokens, but never treat the placeholder as a model.
      if ((!synthetic && row.isApiErrorMessage !== true) || tokens.input + tokens.output > 0) {
        if (!rootId) throw new SummaryError('missing-root-turn', offset);
        const responseId = string(message.id);
        if (!responseId) throw new SummaryError('missing-response-id', offset);
        this.sink.event({ kind: 'usage', rootId, responseId, requestId: string(row.requestId) ?? null,
          threadId: this.identityValue.threadId, turnId: rootId, tokens,
          model: synthetic ? undefined : model, billingMode: billingMode(message.billing_mode ?? row.billing_mode ?? row.auth_mode ?? this.billing), offset });
      }
    }
    if (type === 'assistant' && rootId) {
      this.apiFailed = row.isApiErrorMessage === true;
      this.stopBlocked = false;
      const stopped = !this.apiFailed && (message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence');
      this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, lastAssistantAt: time,
        completed: stopped, completedAt: stopped ? time : null, durationQuality: 'approximate',
        status: this.apiFailed ? 'failed' : stopped ? 'completed' : 'in_progress', statusAt: time,
        flags: this.apiFailed ? ['api-error'] : [], offset });
    }
    if (rootId && type === 'system' && row.subtype === 'stop_hook_summary') {
      // Only an explicit outcome can supersede the assistant timestamp fallback.
      if (typeof row.preventedContinuation !== 'boolean') return;
      this.stopBlocked = row.preventedContinuation;
      const completed = !this.stopBlocked && !this.apiFailed;
      this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, completed,
        completedAt: completed ? time : null, durationQuality: 'derived',
        status: this.stopBlocked ? 'in_progress' : this.apiFailed ? 'failed' : 'completed', statusAt: time, offset });
    } else if (rootId && !this.stopBlocked && type === 'system' && row.subtype === 'turn_duration' && typeof row.durationMs === 'number') {
      this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, duration: number(row.durationMs),
        durationQuality: 'exact', completed: !this.apiFailed, completedAt: this.apiFailed ? null : time,
        status: this.apiFailed ? 'failed' : 'completed', statusAt: time, offset });
    } else if (rootId && !this.stopBlocked && (type === 'system' && ['stop', 'turn_complete', 'task_complete'].includes(String(row.subtype)))) {
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
