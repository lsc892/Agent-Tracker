import { basename, dirname, sep } from 'node:path';
import { SummaryError } from '../jsonl';
import type { FileContext, ParsedIdentity, ParseSink } from '../types';
import { claudeTokens, number, object, project, string, timestamp } from './common';

export class ClaudeParserAdapter {
  private currentRoot: string | undefined;
  private identityValue: ParsedIdentity;
  private recognized = false;

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
    const type = string(row.type);
    if (!type) return;
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
    if (explicitPrompt) this.currentRoot = explicitPrompt;
    if (external && !this.currentRoot) this.currentRoot = string(row.uuid);
    if (external && !explicitPrompt && string(row.uuid)) this.currentRoot = string(row.uuid);
    const rootId = this.currentRoot;
    const time = timestamp(row.timestamp);
    if (external && rootId) this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain,
      startedAt: time, flags: explicitPrompt ? [] : ['missing-request-id'], offset });
    if (type === 'assistant' && Object.keys(object(message.usage)).length > 0) {
      if (!rootId) throw new SummaryError('missing-root-turn', offset);
      const responseId = string(message.id);
      if (!responseId) throw new SummaryError('missing-response-id', offset);
      this.sink.event({ kind: 'usage', rootId, responseId, requestId: string(row.requestId) ?? null,
        threadId: this.identityValue.threadId, turnId: rootId, tokens: claudeTokens(object(message.usage)), offset });
      const stopped = message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence';
      this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, lastAssistantAt: time,
        completed: stopped, completedAt: stopped ? time : null, durationQuality: 'approximate', offset });
    }
    if (rootId && type === 'system' && row.subtype === 'turn_duration' && typeof row.durationMs === 'number') {
      this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, duration: number(row.durationMs),
        durationQuality: 'exact', completed: true, completedAt: time, offset });
    } else if (rootId && (type === 'system' && ['stop', 'turn_complete', 'task_complete'].includes(String(row.subtype)))) {
      this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, completed: true,
        completedAt: time, durationQuality: 'derived', offset });
    }
  }

  finish(): void {
    if (!this.recognized || !this.identityValue.sessionId) throw new SummaryError('unsupported-schema');
    this.sink.identity(this.identityValue);
  }

  /** Preserve the known parent/session even when a later line makes the file fail. */
  getIdentity(): ParsedIdentity { return this.identityValue; }
}
