// Claude 대화 로그의 식별 정보·요청·사용량·도구 호출을 공통 이벤트로 변환한다.
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

/** Claude 로그의 세션 문맥을 유지하며 요청·응답·수명주기 이벤트를 내보낸다. */
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

  /**
   * 책임: Claude 원본 행을 후속 처리기가 공유할 문맥으로 해석한다.
   * 알고리즘: 메시지·토큰·시각·식별자를 정규화하고 tool_result·meta·sidechain을 제외해 외부 사용자 요청 여부를 결정한다.
   */
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

  /**
   * 책임: 과거 로그의 결제·제목·세션·프로젝트 metadata를 추적한다.
   * 알고리즘: 명시 결제 정보를 우선 반영하고 사용자 제목을 AI 제목보다 우선하며 subagent의 부모 세션은 경로 기준으로 유지한다.
   */
  private updateMetadata(context: ClaudeRowContext): void {
    // Billing metadata is accepted even on rows without a recognized type.
    if (context.hasBillingMetadata) this.billing = billingMode(context.billingValue);
    const { type, sessionName, sessionId, cwd } = context;
    if (!type) return;
    this.updateSessionTitle(type, sessionName);
    if (['user', 'assistant', 'system', 'progress', 'file-history-snapshot', 'queue-operation', 'summary'].includes(type)) this.recognized = true;
    // Subagent sessionId is sometimes its own thread. Its path establishes the parent session.
    if (sessionId && this.identityValue.isMain) this.identityValue.sessionId = this.identityValue.threadId = sessionId;
    if (cwd) Object.assign(this.identityValue, project(cwd));
  }

  private updateSessionTitle(type: string, sessionName: string | undefined): void {
    if (!this.identityValue.isMain || (type !== 'ai-title' && type !== 'custom-title')) return;
    if (!sessionName || (type !== 'custom-title' && this.customTitle)) return;
    this.identityValue.sessionName = sessionName;
    this.customTitle = type === 'custom-title';
  }

  /**
   * 책임: 도구 결과와 외부 사용자 요청을 구분해 사용량의 귀속 요청을 정한다.
   * 알고리즘: promptId를 우선하고 외부 요청에는 uuid를 대체 키로 사용하며 새 요청이 시작될 때 이전 오류·중단 상태를 초기화한다.
   */
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

  /**
   * 책임: 응답 토큰과 요청 상태를 기록하면서 로컬 오류 안내의 모델 오집계를 막는다.
   * 알고리즘: 실제 응답 또는 양수 토큰만 usage로 내보내고 synthetic 모델은 비우며, API 오류와 stop reason으로 완료·실패 상태를 정한다.
   */
  private recordAssistant(context: ClaudeRowContext): void {
    if (context.type !== 'assistant') return;
    this.recordAssistantUsage(context);
    const { rootId, apiError, time, offset } = context;
    if (!rootId) return;
    this.apiFailed = apiError;
    this.stopBlocked = false;
    const stopped = !this.apiFailed && (context.stopReason === 'end_turn' || context.stopReason === 'stop_sequence');
    this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, lastAssistantAt: time,
      completed: stopped, completedAt: stopped ? time : null, durationQuality: 'approximate',
      status: this.apiFailed ? 'failed' : stopped ? 'completed' : 'in_progress', statusAt: time,
      flags: this.apiFailed ? ['api-error'] : [], offset });
  }

  private recordAssistantUsage(context: ClaudeRowContext): void {
    const { rootId, usage, model, responseId, requestId, apiError, offset } = context;
    if (Object.keys(usage).length === 0) return;
    const tokens = claudeTokens(usage);
    const synthetic = model === '<synthetic>';
    // Local error notices carry a zero usage vector, rather than an API response.
    // Retain any reported tokens, but never treat the placeholder as a model.
    if ((synthetic || apiError) && tokens.input + tokens.output <= 0) return;
    if (!rootId) throw new SummaryError('missing-root-turn', offset);
    if (!responseId) throw new SummaryError('missing-response-id', offset);
    this.sink.event({ kind: 'usage', rootId, responseId, requestId: requestId ?? null,
      threadId: this.identityValue.threadId, turnId: rootId, tokens,
      model: synthetic ? undefined : model, billingMode: billingMode(context.usageBillingValue ?? this.billing), offset });
  }

  /**
   * 책임: 명시적 시스템 이벤트로 Claude 요청의 종료와 소요 시간을 보정한다.
   * 알고리즘: stop hook의 계속 실행 여부를 우선하고 차단 상태가 아닐 때만 duration·완료 이벤트를 반영하며 API 실패 상태를 유지한다.
   */
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
      return;
    }
    // A blocked stop hook must keep the request open, including later duration records.
    if (this.stopBlocked) return;
    if (subtype === 'turn_duration' && durationMs !== undefined) {
      this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, duration: durationMs,
        durationQuality: 'exact', completed: !this.apiFailed, completedAt: this.apiFailed ? null : time,
        status: this.apiFailed ? 'failed' : 'completed', statusAt: time, offset });
      return;
    }
    if (!['stop', 'turn_complete', 'task_complete'].includes(String(subtype))) return;
    this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, completed: !this.apiFailed,
      completedAt: this.apiFailed ? null : time, durationQuality: 'derived',
      status: this.apiFailed ? 'failed' : 'completed', statusAt: time, offset });
  }

  finish(): void {
    if (!this.recognized || !this.identityValue.sessionId) throw new SummaryError('unsupported-schema');
    this.sink.identity(this.identityValue);
  }

  /** Preserve the known parent/session even when a later line makes the file fail. */
  getIdentity(): ParsedIdentity { return this.identityValue; }
}
