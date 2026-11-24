// 현재·이전 Codex 로그의 식별 정보·요청·사용량·도구 호출을 공통 이벤트로 변환한다.
import { SummaryError } from '../jsonl';
import { projectJson } from '../jsonl/projection';
import type { FileContext, ParsedIdentity, ParseSink, TokenVector } from '../types';
import { billingMode, codexTokens, displayName, number, object, project, requestTitle, string, timestamp, tokenFlags, validateTokens } from './common';
import { readToolCapabilities } from './capabilities';
import { spawnOutput } from './logFields';

const turnRowTypes = new Set(['turn_context', 'token_usage_record', 'event_msg']);
const tokenFields = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const satisfies readonly (keyof TokenVector)[];

/**
 * 책임: Codex 수명주기의 시각 단위를 공통 밀리초로 맞춘다.
 * 알고리즘: 숫자 payload 시각만 Unix 초에서 밀리초로 변환하고 문자열 날짜는 기존 timestamp 검증에 맡긴다.
 */
function lifecycleTimestamp(value: unknown): number | null {
  return timestamp(typeof value === 'number' ? value * 1000 : value);
}

/** Codex 세션·턴 문맥을 유지하며 현재 사용량과 이전 누계·수명주기를 해석한다. */
export class CodexCurrentParserAdapter {
  private identityValue: ParsedIdentity | undefined;
  private root: string | undefined;
  private turn: string | undefined;
  private sawCurrent = false;
  private legacySignature: string | undefined;
  private highWater: TokenVector = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  private currentClosed = false;
  private hasUserInTurn = false;
  private pendingLifecycle = false;
  private hasExplicitRoot = false;
  private forkMissing = false;
  private model: string | undefined;
  private billing: import('../db/types').BillingMode = 'unknown';
  private readonly spawnRequests = new Map<string, string>();

  constructor(private readonly context: FileContext, private readonly sink: ParseSink) {}

  /**
   * 책임: Codex 행을 identity와 root 문맥이 갖춰진 처리기로 분배한다.
   * 알고리즘: session_meta를 먼저 반영하고 명시 root 유무를 추적한 뒤 turn 문맥·응답 사용량·도구·수명주기별로 분기한다.
   */
  row(row: Record<string, unknown>, offset: number): void {
    const type = row.type;
    if (type === 'session_meta') {
      this.sessionMetadata(object(row.payload), offset);
      return;
    }
    const identity = this.identityValue;
    if (!identity) {
      if (type === 'token_usage_record') throw new SummaryError('missing-session-id', offset);
      return;
    }
    if (type === 'response_item') {
      this.responseItem(object(row.payload), identity.threadId, offset);
      return;
    }
    if (typeof type === 'string' && !turnRowTypes.has(type)) return;
    const payload = object(row.payload);
    const suppliedRoot = string(payload.root_turn_id);
    // Preserve explicit-root detection for legacy types that stringify to a known name.
    if (suppliedRoot && (typeof type === 'string' || turnRowTypes.has(String(type)))) this.hasExplicitRoot = true;
    if (typeof type !== 'string') return;
    const suppliedTurn = string(payload.turn_id);
    switch (type) {
      case 'turn_context': this.turnContext(payload, identity.isMain, suppliedRoot, suppliedTurn); break;
      case 'token_usage_record': this.currentUsage(payload, identity, suppliedRoot, suppliedTurn, offset); break;
      case 'event_msg': this.eventLifecycle(payload, identity, suppliedRoot, suppliedTurn, row, offset); break;
    }
  }

  /**
   * 책임: 파일의 thread·부모·논리 세션 identity를 확정한다.
   * 알고리즘: 첫 thread ID를 유지해 복사된 부모 metadata를 무시하고 명시 session·부모·thread 순으로 세션 ID를 정한다.
   */
  private sessionMetadata(payload: Record<string, unknown>, offset: number): void {
    const id = string(payload.id);
    if (!id) throw new SummaryError('missing-session-id', offset);
    // Forked rollouts can contain copied parent session_meta rows. The first identity owns this file.
    if (this.identityValue && id !== this.identityValue.threadId) return;
    const source = object(payload.source ?? payload.thread_source);
    const subagent = object(source.subagent);
    const spawned = object(subagent.thread_spawn);
    const parent = string(payload.parent_thread_id) ?? string(spawned.parent_thread_id) ?? this.identityValue?.parentThreadId ?? null;
    const cwd = string(payload.cwd);
    this.identityValue = { sessionId: string(payload.session_id) ?? this.identityValue?.sessionId ?? parent ?? id,
      threadId: id, parentThreadId: parent, isMain: parent === null,
      forkedFromId: string(payload.forked_from_id) ?? this.identityValue?.forkedFromId ?? null,
      agentPath: string(payload.agent_path) ?? string(spawned.agent_path) ?? this.identityValue?.agentPath,
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

  private turnContext(payload: Record<string, unknown>, isMain: boolean,
    suppliedRoot: string | undefined, suppliedTurn: string | undefined): void {
    // Rootless subagents retain their own turn ids until the spawn binding identifies the parent request.
    const ownTurns = isMain || !this.hasExplicitRoot;
    this.model = displayName(payload.model);
    if (payload.billing_mode !== undefined || payload.auth_mode !== undefined) this.billing = billingMode(payload.billing_mode ?? payload.auth_mode);
    if (suppliedTurn && suppliedTurn !== this.turn) { this.hasUserInTurn = false; this.currentClosed = false; }
    this.turn = suppliedTurn ?? this.turn;
    this.root = suppliedRoot ?? (ownTurns ? this.turn : this.root);
  }

  /**
   * 책임: 현재 형식의 응답별 토큰과 요청 누계 검증 값을 구분한다.
   * 알고리즘: root·turn·response ID를 검증해 usage를 내보내고 turn_token_usage는 check 이벤트로만 기록해 이중 합산을 막는다.
   */
  private currentUsage(payload: Record<string, unknown>, identity: ParsedIdentity,
    suppliedRoot: string | undefined, suppliedTurn: string | undefined, offset: number): void {
    this.sawCurrent = true;
    // Mixed generations can coexist. Source evidence excludes legacy usage when this file contains current usage.
    const rootId = this.currentUsageRoot(identity.isMain, suppliedRoot, suppliedTurn);
    const turnId = suppliedTurn ?? this.turn;
    const responseId = string(payload.response_id);
    if (!rootId || !turnId) throw new SummaryError('missing-root-turn', offset);
    if (!responseId) throw new SummaryError('missing-response-id', offset);
    this.root = rootId; this.turn = turnId;
    const sessionId = string(payload.session_id);
    if (sessionId) identity.sessionId = sessionId;
    const threadId = string(payload.thread_id) ?? identity.threadId;
    const tokens = codexTokens(object(payload.usage));
    const flags = tokenFlags(tokens);
    if (this.forkMissing) flags.push('missing-parent');
    this.sink.event({ kind: 'usage', rootId, turnId, responseId, requestId: null,
      threadId, tokens, schema: 'current',
      model: displayName(payload.model) ?? this.model,
      billingMode: billingMode(payload.billing_mode ?? payload.auth_mode ?? this.billing),
      flags, offset });
    if (payload.turn_token_usage) {
      const totals = object(payload.turn_token_usage);
      validateTokens(totals);
      this.sink.event({ kind: 'check', rootId, threadId, turnId,
        input: number(totals.input_tokens), output: number(totals.output_tokens), offset });
    }
  }

  /** 명시 root를 우선하고 미연결 자식만 자신의 turn을 부모 후보보다 먼저 사용한다. */
  private currentUsageRoot(isMain: boolean, suppliedRoot: string | undefined, suppliedTurn: string | undefined): string | undefined {
    if (suppliedRoot !== undefined) return suppliedRoot;
    if (!isMain && !this.hasExplicitRoot) {
      return suppliedTurn ?? this.turn ?? this.root;
    }
    return this.root ?? suppliedTurn;
  }

  private responseItem(payload: Record<string, unknown>, threadId: string, offset: number): void {
    const type = payload.type;
    if (type === 'function_call_output') {
      this.recordChildResult(payload);
      return;
    }
    if (!this.root) return;
    const collectCapabilities = this.context.collectCapabilities !== false;
    if (type !== 'function_call') {
      if (!collectCapabilities) return;
      const capabilityType = String(type);
      if (capabilityType !== 'function_call' && capabilityType !== 'custom_tool_call') return;
    }
    const name = string(payload.name);
    if (!name) return;
    const spawnsChild = type === 'function_call' && (name === 'spawn_agent' || name.endsWith('.spawn_agent'));
    if (!spawnsChild && !collectCapabilities) return;
    const callId = string(payload.call_id) ?? string(payload.id);
    if (!callId) return;
    if (spawnsChild) this.spawnRequests.set(callId, this.root);
    if (!collectCapabilities) return;
    for (const use of readToolCapabilities(name, () => payload.arguments ?? payload.input)) {
      this.sink.event({ kind: 'capability', rootId: this.root, threadId,
        eventId: `${callId}:${use.index}`, category: use.category, name: use.name, offset });
    }
  }

  /** 반환된 자식 식별자를 호출 당시의 부모 요청에 연결한다. */
  private recordChildResult(payload: Record<string, unknown>): void {
    const callId = string(payload.call_id) ?? string(payload.id);
    if (!callId) return;
    const root = this.spawnRequests.get(callId);
    if (!root) return;
    this.spawnRequests.delete(callId);
    let output: Record<string, unknown>;
    try {
      const value = payload.output;
      output = object(typeof value === 'string' ? projectJson(value, spawnOutput) : value);
    }
    catch { return; }
    const agent = string(output.agent_id), task = string(output.task_name);
    if (agent) this.sink.child?.(agent, root);
    if (task && task !== agent) this.sink.child?.(task, root);
  }

  /**
   * 책임: Codex 요청의 시작·완료·중단과 legacy 사용자 요청 경계를 추적한다.
   * 알고리즘: 명시 root·turn을 우선하고 사용자 메시지·종료 상태로 대체 요청을 구분하며, 이벤트별 시각·duration·상태를 기록한다.
   */
  private eventLifecycle(payload: Record<string, unknown>, identity: ParsedIdentity, suppliedRoot: string | undefined,
    suppliedTurn: string | undefined, row: Record<string, unknown>, offset: number): void {
    const ownTurns = identity.isMain || !this.hasExplicitRoot;
    if (suppliedTurn) this.turn = suppliedTurn;
    if (suppliedRoot) this.root = suppliedRoot;
    else if (ownTurns && suppliedTurn) this.root = suppliedTurn;
    switch (string(payload.type)) {
      case 'task_started': {
        this.currentClosed = false; this.hasUserInTurn = false; this.pendingLifecycle = true;
        if (!this.root) break;
        const startedAt = lifecycleTimestamp(payload.started_at) ?? timestamp(row.timestamp);
        this.sink.event({ kind: 'turn', rootId: this.root, isMain: identity.isMain,
          startedAt, status: 'in_progress', statusAt: startedAt, offset });
        break;
      }
      case 'user_message':
        this.recordUserMessage(payload, timestamp(row.timestamp), identity.isMain, ownTurns, offset);
        break;
      case 'task_complete':
      case 'task_completed':
        this.recordCompletion(payload, row, identity.isMain, offset);
        break;
      case 'turn_aborted':
        this.currentClosed = true; this.pendingLifecycle = false;
        if (this.root) this.sink.event({ kind: 'turn', rootId: this.root, isMain: identity.isMain,
          status: 'aborted', statusAt: lifecycleTimestamp(payload.completed_at) ?? timestamp(row.timestamp), offset });
        break;
      case 'agent_message':
        if (this.root) this.sink.event({ kind: 'turn', rootId: this.root, isMain: identity.isMain, lastAssistantAt: timestamp(row.timestamp), offset });
        break;
      case 'token_count':
        if (!this.sawCurrent) this.legacyTokens(payload, identity, offset);
        break;
    }
  }

  /** 명시 시작 이벤트가 없는 이전 형식에서도 다음 사용자 요청을 별도 root로 구분한다. */
  private recordUserMessage(payload: Record<string, unknown>, time: number | null, isMain: boolean,
    ownTurns: boolean, offset: number): void {
    if (ownTurns && (!this.root || this.currentClosed || this.hasUserInTurn && !this.pendingLifecycle)) {
      this.root = string(payload.id) ?? (time === null ? undefined : `legacy-${time}`);
      this.turn = this.root;
    }
    this.hasUserInTurn = true;
    this.currentClosed = false;
    this.pendingLifecycle = false;
    if (this.root) this.sink.event({ kind: 'turn', rootId: this.root, isMain, startedAt: time,
      title: requestTitle(payload.message), flags: this.root.startsWith('legacy-') ? ['missing-request-id'] : [], offset });
  }

  /** 완료 시각과 duration의 출처를 보존하면서 요청을 종료 상태로 기록한다. */
  private recordCompletion(payload: Record<string, unknown>, row: Record<string, unknown>, isMain: boolean, offset: number): void {
    this.currentClosed = true;
    if (!this.root) return;
    const completedAt = lifecycleTimestamp(payload.completed_at) ?? timestamp(row.timestamp);
    this.sink.event({ kind: 'turn', rootId: this.root, isMain, completed: true, completedAt,
      duration: typeof payload.duration_ms === 'number' ? number(payload.duration_ms) : null,
      durationQuality: typeof payload.duration_ms === 'number' ? 'exact' : 'derived',
      status: 'completed', statusAt: completedAt, offset });
  }

  /**
   * 책임: 이전 형식의 누적 카운터에서 중복 없는 응답 사용량을 복원한다.
   * 알고리즘: 동일한 total·last 조합은 건너뛰고 last가 없으면 high-water 차분을 사용하며, 누계 역행은 플래그로 남기고 기준값은 감소시키지 않는다.
   */
  private legacyTokens(payload: Record<string, unknown>, identity: ParsedIdentity, offset: number): void {
    const info = object(payload.info);
    if (!info.total_token_usage && !info.last_token_usage) return;
    if (!identity.isMain && !this.hasExplicitRoot && (!this.root || !this.turn)) {
      this.root = this.turn = this.turn ?? `legacy-${identity.threadId}`;
    }
    if (!this.root || !this.turn) throw new SummaryError('missing-root-turn', offset);
    const total = info.total_token_usage ? codexTokens(object(info.total_token_usage)) : this.highWater;
    const last = info.last_token_usage ? codexTokens(object(info.last_token_usage)) : null;
    const signature = JSON.stringify([total, last]);
    if (signature === this.legacySignature) return;
    this.legacySignature = signature;
    const tokens = { ...total };
    const flags: string[] = this.forkMissing ? ['missing-parent'] : [];
    let regression = false;
    for (const key of tokenFields) {
      if (total[key] < this.highWater[key]) regression = true;
      tokens[key] = last ? last[key] : Math.max(0, total[key] - this.highWater[key]);
      this.highWater[key] = Math.max(this.highWater[key], total[key]);
    }
    if (regression) flags.push('counter-regression');
    flags.push(...tokenFlags(tokens));
    this.sink.event({ kind: 'usage', rootId: this.root, turnId: this.turn,
      responseId: `legacy-${signature}`, requestId: null,
      threadId: identity.threadId, tokens, model: displayName(payload.model) ?? this.model,
      billingMode: billingMode(payload.billing_mode ?? payload.auth_mode ?? this.billing),
      schema: 'legacy', flags, offset });
  }

  finish(): void {
    const identity = this.getIdentity();
    if (!identity) throw new SummaryError('unsupported-schema');
    this.sink.identity(identity);
  }

  /**
   * 책임: 부모 요청을 뒤에서 연결할 수 있도록 root 없는 subagent의 원래 계보를 보존한다.
   * 알고리즘: 명시 root가 없는 자식은 독립 메인으로 승격하지 않고 rootless 표시만 추가한다.
   */
  getIdentity(): ParsedIdentity | undefined {
    const identity = this.identityValue;
    if (!identity || identity.isMain || this.hasExplicitRoot) return identity;
    return { ...identity, rootlessSubagent: true };
  }
}
