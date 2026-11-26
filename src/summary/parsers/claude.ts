// Claude 대화 로그의 식별 정보·요청·사용량·도구 호출을 공통 이벤트로 변환한다.
import { basename, dirname, sep } from 'node:path';
import { SummaryError } from '../jsonl';
import { hasJsonFields } from '../jsonl/projection';
import type { FileContext, ParsedIdentity, ParseSink } from '../types';
import type { BillingMode } from '../db/types';
import { billingMode, claudeTokens, displayName, number, object, project, requestTitle, string, timestamp } from './common';
import { readToolCapabilities } from './capabilities';

const recognizedTypes = new Set(['user', 'assistant', 'system', 'progress', 'file-history-snapshot', 'queue-operation', 'summary']);

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
    // [귀속 정책] 파일명으로 스레드를 구분하고 하위 에이전트는 경로에서 부모 세션을 찾는다.
    const parts = context.path.split(/[\\/]/);
    const subagentIndex = parts.lastIndexOf('subagents');
    const isMain = subagentIndex < 0;
    const session = isMain ? basename(context.path, '.jsonl') : parts[subagentIndex - 1];
    this.identityValue = { sessionId: session ?? '', threadId: isMain ? session ?? '' : basename(context.path, '.jsonl'),
      parentThreadId: isMain ? null : session ?? null, isMain,
      ...project(isMain ? dirname(context.path) : parts.slice(0, subagentIndex - 1).join(sep)) };
  }

  row(row: Record<string, unknown>, offset: number): void {
    // Billing metadata is accepted even on rows without a recognized type.
    if (row.billing_mode !== undefined || row.auth_mode !== undefined) this.billing = billingMode(row.billing_mode ?? row.auth_mode);
    const type = string(row.type);
    if (!type) return;
    this.updateMetadata(row, type);
    // [파싱 정책] 사용자 행에서 요청 경계를 먼저 세우고 응답·시스템 행은 갱신된 요청에 귀속한다.
    const promptId = string(row.promptId);
    if (type === 'user') {
      this.recordUser(row, promptId, offset);
      return;
    }
    this.identifyRequest(promptId, false);
    if (type === 'assistant') this.recordAssistant(row, offset);
    else if (type === 'system') this.recordSystemLifecycle(row, offset);
  }

  /**
   * 책임: 과거 로그의 결제·제목·세션·프로젝트 metadata를 추적한다.
   * 알고리즘: 명시 결제 정보를 우선 반영하고 사용자 제목을 AI 제목보다 우선하며 subagent의 부모 세션은 경로 기준으로 유지한다.
   */
  private updateMetadata(row: Record<string, unknown>, type: string): void {
    this.updateSessionTitle(row, type);
    if (recognizedTypes.has(type)) this.recognized = true;
    // Subagent sessionId is sometimes its own thread. Its path establishes the parent session.
    if (this.identityValue.isMain) {
      const sessionId = string(row.sessionId);
      if (sessionId) this.identityValue.sessionId = this.identityValue.threadId = sessionId;
    }
    const cwd = string(row.cwd);
    if (cwd) Object.assign(this.identityValue, project(cwd));
  }

  private updateSessionTitle(row: Record<string, unknown>, type: string): void {
    // [이름 정책] 메인 세션의 유효한 제목만 받고 사용자 제목이 있으면 이후 AI 제목은 무시한다.
    if (!this.identityValue.isMain || (type !== 'ai-title' && type !== 'custom-title')) return;
    if (type === 'ai-title' && this.customTitle) return;
    const sessionName = displayName(type === 'custom-title' ? row.customTitle : row.aiTitle);
    if (!sessionName) return;
    this.identityValue.sessionName = sessionName;
    this.customTitle = type === 'custom-title';
  }

  /**
   * 책임: 도구 결과와 외부 사용자 요청을 구분해 사용량의 귀속 요청을 정한다.
   * 알고리즘: promptId를 우선하고 외부 요청에는 uuid를 대체 키로 사용하며 새 요청이 시작될 때 이전 오류·중단 상태를 초기화한다.
   */
  private recordUser(row: Record<string, unknown>, promptId: string | undefined, offset: number): void {
    const mayStartRequest = row.isMeta !== true && row.isSidechain !== true;
    const content = mayStartRequest ? object(row.message).content : undefined;
    const external = mayStartRequest
      && !(Array.isArray(content) && content.some((item: unknown) => object(item).type === 'tool_result'));
    this.identifyRequest(promptId ?? (external ? string(row.uuid) : undefined), external);
    if (!external || !this.currentRoot) return;
    this.sink.event({ kind: 'turn', rootId: this.currentRoot, isMain: this.identityValue.isMain,
      startedAt: timestamp(row.timestamp), title: requestTitle(content),
      flags: promptId ? [] : ['missing-request-id'], offset });
  }

  private identifyRequest(rootId: string | undefined, external: boolean): void {
    // [귀속 정책] 식별자가 없는 행은 이전 요청을 따라가고 새 요청에서 오류·중단 상태를 초기화한다.
    const previousRoot = this.currentRoot;
    this.currentRoot = rootId ?? previousRoot;
    if (external || this.currentRoot !== previousRoot) { this.apiFailed = false; this.stopBlocked = false; }
  }

  private recordToolUsage(content: unknown, rootId: string, offset: number): void {
    // [집계 정책] ID와 이름이 있는 도구 호출만 분류하고 호출 내부 순번을 이벤트 키에 포함한다.
    if (!Array.isArray(content)) return;
    for (const item of content) {
      const call = object(item);
      if (call.type !== 'tool_use') continue;
      const eventId = string(call.id);
      const name = string(call.name);
      if (!eventId || !name) continue;
      for (const use of readToolCapabilities(name, () => call.input)) this.sink.event({ kind: 'capability', rootId,
        threadId: this.identityValue.threadId, eventId: `${eventId}:${use.index}`, category: use.category, name: use.name, offset });
    }
  }

  /**
   * 책임: 응답 토큰과 요청 상태를 기록하면서 로컬 오류 안내의 모델 오집계를 막는다.
   * 알고리즘: 실제 응답 또는 양수 토큰만 usage로 내보내고 synthetic 모델은 비우며, API 오류와 stop reason으로 완료·실패 상태를 정한다.
   */
  private recordAssistant(row: Record<string, unknown>, offset: number): void {
    const rootId = this.currentRoot;
    const message = object(row.message);
    if (rootId && this.context.collectCapabilities !== false) this.recordToolUsage(message.content, rootId, offset);
    this.recordAssistantUsage(row, message, rootId, offset);
    if (!rootId) return;
    // [상태 정책] API 오류를 실패로, 정상 종료 사유를 완료로 기록해 마지막 응답 시각을 보존한다.
    this.apiFailed = row.isApiErrorMessage === true;
    this.stopBlocked = false;
    const time = timestamp(row.timestamp);
    const stopped = !this.apiFailed && (message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence');
    this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, lastAssistantAt: time,
      completed: stopped, completedAt: stopped ? time : null, durationQuality: 'approximate',
      status: this.apiFailed ? 'failed' : stopped ? 'completed' : 'in_progress', statusAt: time,
      flags: this.apiFailed ? ['api-error'] : [], offset });
  }

  private recordAssistantUsage(row: Record<string, unknown>, message: Record<string, unknown>, rootId: string | undefined, offset: number): void {
    if (!message.usage) return;
    const usage = object(message.usage);
    if (!hasJsonFields(usage)) return;
    const tokens = claudeTokens(usage);
    const model = displayName(message.model);
    const synthetic = model === '<synthetic>';
    // Local error notices carry a zero usage vector, rather than an API response.
    // Retain any reported tokens, but never treat the placeholder as a model.
    // [집계 정책] 토큰이 없는 로컬 오류 안내는 제외하고 사용량이 있으면 가상 모델명만 비운다.
    if ((synthetic || row.isApiErrorMessage === true) && tokens.input + tokens.output <= 0) return;
    if (!rootId) throw new SummaryError('missing-root-turn', offset);
    const responseId = string(message.id);
    if (!responseId) throw new SummaryError('missing-response-id', offset);
    // [DTO 정책] 응답별 토큰에 메시지·행·세션 순으로 찾은 결제 유형을 붙인다.
    const usageBillingValue = message.billing_mode ?? row.billing_mode ?? row.auth_mode ?? this.billing;
    const requestId = string(row.requestId);
    this.sink.event({ kind: 'usage', rootId, responseId, requestId: requestId ?? null,
      threadId: this.identityValue.threadId, turnId: rootId, tokens,
      model: synthetic ? undefined : model, billingMode: billingMode(usageBillingValue), offset });
  }

  /**
   * 책임: 명시적 시스템 이벤트로 Claude 요청의 종료와 소요 시간을 보정한다.
   * 알고리즘: stop hook의 계속 실행 여부를 우선하고 차단 상태가 아닐 때만 duration·완료 이벤트를 반영하며 API 실패 상태를 유지한다.
   */
  private recordSystemLifecycle(row: Record<string, unknown>, offset: number): void {
    const rootId = this.currentRoot;
    if (!rootId) return;
    const subtype = row.subtype;
    // Stop hook 결과를 먼저 반영한 뒤, 차단되지 않은 요청의 종료 기록만 허용한다.
    if (subtype === 'stop_hook_summary') {
      this.recordStopHook(row, rootId, offset);
      return;
    }
    // A blocked stop hook must keep the request open, including later duration records.
    if (this.stopBlocked) return;
    // [상태 정책] 명시 소요 시간은 정확값, 완료 시각만 있는 시스템 이벤트는 유도값으로 전달한다.
    if (subtype === 'turn_duration' && typeof row.durationMs === 'number') {
      const time = timestamp(row.timestamp);
      this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, duration: number(row.durationMs),
        durationQuality: 'exact', completed: !this.apiFailed, completedAt: this.apiFailed ? null : time,
        status: this.apiFailed ? 'failed' : 'completed', statusAt: time, offset });
      return;
    }
    switch (String(subtype)) {
      case 'stop':
      case 'turn_complete':
      case 'task_complete': {
        const time = timestamp(row.timestamp);
        this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, completed: !this.apiFailed,
          completedAt: this.apiFailed ? null : time, durationQuality: 'derived',
          status: this.apiFailed ? 'failed' : 'completed', statusAt: time, offset });
        break;
      }
    }
  }

  /** 명시 hook 결과만 assistant 시각에 의한 완료 추정을 덮어쓸 수 있다. */
  private recordStopHook(row: Record<string, unknown>, rootId: string, offset: number): void {
    const preventedContinuation = row.preventedContinuation;
    if (typeof preventedContinuation !== 'boolean') return;
    this.stopBlocked = preventedContinuation;
    // [상태 정책] 계속 실행을 막은 hook은 진행 중으로 두고, 나머지는 API 오류 여부로 완료를 정한다.
    const completed = !this.stopBlocked && !this.apiFailed;
    const time = timestamp(row.timestamp);
    this.sink.event({ kind: 'turn', rootId, isMain: this.identityValue.isMain, completed,
      completedAt: completed ? time : null, durationQuality: 'derived',
      status: this.stopBlocked ? 'in_progress' : this.apiFailed ? 'failed' : 'completed', statusAt: time, offset });
  }

  finish(): void {
    if (!this.recognized || !this.identityValue.sessionId) throw new SummaryError('unsupported-schema');
    this.sink.identity(this.identityValue);
  }

  /** Preserve the known parent/session even when a later line makes the file fail. */
  getIdentity(): ParsedIdentity { return this.identityValue; }
}
