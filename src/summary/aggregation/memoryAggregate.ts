// 파일별 winner를 요청·모델·진단 값에 반영한다.
import type { AppliedResponse } from '../db/appliedResponses';
import type { CapabilityEvent, TurnEvent } from '../types';
import { addFlag, eligible, eligibleWinner, key, prepareSources,
  type SourcePlan, type StreamingAggregateFile } from './sourceEvidence';
import { accountedCacheRead, accountedCacheWrite, addCapability, addUsage, createRoot, materialize, max, mergeTurn,
  type MemoryAggregateResult, type Outcome, type Root, type UsageContribution } from './turns';
import { referenceWinners, type DetailedSourceWinnersSnapshot, type ReferencedWinners,
  type SourceCheck, type SourceWinnersSnapshot, type UsageWinner, type WinnerReference } from './sourceWinners';
import { isBetterUsage, usageScore } from './winners';

export type { StreamingAggregateFile } from './sourceEvidence';
export type { MaterializedTurnSummary, MemoryAggregateResult } from './turns';

interface UsageSource extends SourcePlan { usage?: ReferencedWinners }

interface RecordedCheck {
  source: SourcePlan;
  rootId: string;
  check: SourceCheck;
  ordinal: number;
  sum?: UsageContribution['tokens'];
}

interface ResponseCandidate {
  source: SourcePlan;
  root: Root;
  reference: WinnerReference;
  tokens: UsageWinner['tokens'];
  request: string | null;
  score: number | bigint;
  ordinal: number;
  position: number;
}

const MISSING_CLAUDE_REQUEST = 'no-req';

function compareId(left: string, right: string): number {
  return left < right ? -1 : Number(left > right);
}

function compareClaudeResponses(left: ResponseCandidate, right: ResponseCandidate): number {
  return compareId(left.reference.responseId, right.reference.responseId)
    || compareId(left.request ?? MISSING_CLAUDE_REQUEST, right.request ?? MISSING_CLAUDE_REQUEST);
}

function compareCodexResponses(left: ResponseCandidate, right: ResponseCandidate): number {
  const a = left.reference, b = right.reference;
  return compareId(a.responseId, b.responseId) || compareId(a.threadId, b.threadId) || compareId(a.turnId, b.turnId);
}

/** 파일별 winner를 세션의 응답 키 순서로 합쳐 집계한다. */
export class StreamingAggregation {
  private readonly sources = new Map<number, UsageSource>();
  private readonly requests: Map<string, string | null>;
  private readonly sessions = new Map<string, UsageSource[]>();
  private readonly sessionRoots = new Map<string, Map<string, Root>>();
  private readonly roots: Root[] = [];
  private readonly checks = new Map<string, RecordedCheck>();
  private readonly capabilities = new Set<string>();

  constructor(files: readonly StreamingAggregateFile[], private readonly collectCapabilities = true,
    private readonly onApplied?: (response: AppliedResponse) => void) {
    // [귀속 정책] 복사 이력과 Claude 요청 ID 보정 근거를 준비하고 원본을 파일·세션 키로 색인한다.
    const prepared = prepareSources(files);
    this.requests = prepared.requests;
    for (const source of prepared.sources) {
      this.sources.set(source.file.id, source);
      const id = key(source.file.provider, source.file.session_id);
      let files = this.sessions.get(id);
      if (!files) {
        this.sessions.set(id, files = []);
        this.sessionRoots.set(id, new Map());
      }
      files.push(source);
    }

    // [진단 정책] 세션 원본을 파일 ID 순으로 정렬해 메인 원본 선택과 진단 순서에 사용한다.
    for (const files of this.sessions.values()) files.sort((a, b) => a.file.id - b.file.id);
  }

  /** 파싱 중 접은 요청 상태와 파일별 winner를 등록한다. */
  addSource(fileId: number, prepared: SourceWinnersSnapshot | DetailedSourceWinnersSnapshot): void {
    const source = this.sources.get(fileId)!, file = source.file;
    const roots = this.sessionRoots.get(key(file.provider, file.session_id))!;
    const parentRootId = file.identity.parentRootId;
    const outcomes = new Map<string, Outcome>();
    for (const state of prepared.roots.values()) {
      // [귀속 정책] 부모 요청 ID가 있으면 그쪽으로 귀속하고 복사 이력만 남은 요청은 상태·누계 병합에서 제외한다.
      const inherited = source.inheritedRoots.has(state.rootId);
      const rootId = parentRootId ?? state.rootId;
      if (!inherited) {
        const usageRootId = parentRootId || state.rootId;
        if (state.usageOffset !== null) this.observeRequest(file, roots, usageRootId, state.usageOffset);
        if (state.checkOffset !== null) this.observeRequest(file, roots, rootId, state.checkOffset);

        // [집계 정책] 메인 원본의 메인 턴과 독립 서브에이전트의 턴에서 요청 상태와 제목을 병합한다.
        for (const [isMain, turn] of state.turns) {
          if (!file.identity.isMain && !file.identity.standaloneSubagent) continue;
          const target = this.observeRequest(file, roots, rootId, turn.offset);
          if (!isMain && !file.identity.standaloneSubagent) continue;
          mergeTurn(target, turn, source.base);
          if (turn.outcome) this.recordOutcome(outcomes, target, turn.outcome.event,
            source.base + turn.outcome.ordinal, turn.outcome.orderingAt);
        }

        // [진단 정책] 스레드·턴별 최신 누계를 등록하고 미리 기록한 위치를 쓸 수 없으면 검사 위치도 남긴다.
        for (const check of state.checks.values()) {
          if (usageRootId !== rootId || state.checkOffset === null) this.observeRequest(file, roots, usageRootId, check.offset);
          this.recordCheck(source, usageRootId, check);
        }
      }

      // [집계 정책] 각 도구 이벤트의 첫 유효 위치를 골라 중복 없이 반영한다.
      for (const { event, positions } of state.capabilities.values()) {
        for (const position of positions) {
          if (!eligible(source, event, position.index)) continue;
          const observed = this.observeRequest(file, roots, rootId, position.offset);
          // [귀속 정책] 부모 ID가 비어 있으면 도구 이벤트가 가리키는 원래 요청에 반영한다.
          const capabilityRootId = parentRootId || event.rootId;
          const root = capabilityRootId === rootId ? observed : this.observeRequest(file, roots, capabilityRootId, position.offset);
          this.recordCapability(root, event);
          break;
        }
      }
    }

    // 복사 이력과 첫 현재 응답의 중복을 제외한 구형 요청을 등록한다.
    if (!file.evidence.current || file.evidence.legacyPrefix) {
      for (const { rootId, index, offset, responseId } of file.evidence.legacy) {
        if (index > source.legacyCutoff && !source.inheritedRoots.has(rootId)
          && responseId !== file.evidence.legacyPrefix?.overlap)
          this.observeRequest(file, roots, parentRootId || rootId, offset);
      }
    }

    // [DTO 정책] 파일별 winner의 토큰과 메타데이터 참조를 행 인덱스로 연결해 세션 병합에 넘긴다.
    const { winners, references } = 'references' in prepared ? prepared : referenceWinners(prepared.winners);
    source.usage = { winners, references };
  }

  private createResponseCandidate(source: SourcePlan, roots: ReadonlyMap<string, Root>,
    winner: UsageWinner, reference: WinnerReference, position: number): ResponseCandidate {
    const { file } = source, { rootId, requestId, responseId } = reference;
    // [귀속 정책] 등록된 대상 요청을 찾고 누락된 Claude 요청 ID는 세션의 응답별 근거로 보정한다.
    const root = roots.get(file.identity.parentRootId || rootId)!;
    const request = file.provider === 'claude' && requestId === null
      ? this.requests.get(key(file.session_id, responseId)) ?? null : requestId;

    return { source, root, reference, tokens: winner.tokens, request,
      score: usageScore(winner), ordinal: source.base + winner.referenceId, position };
  }

  private applySessionUsage(files: readonly UsageSource[], roots: ReadonlyMap<string, Root>): void {
    // [Winner 정책] 원본 순으로 후보를 모으고 제외된 winner는 점수순 대체 후보 중 첫 유효 항목으로 바꾼다.
    const candidates: ResponseCandidate[] = [];
    for (const source of files.slice().sort((a, b) => a.base - b.base)) {
      if (!source.usage) continue;
      const { winners, references } = source.usage;
      for (const entry of winners) {
        let winner = entry;
        let reference = references.get(entry.referenceId)!;
        if (!eligibleWinner(source, reference.rootId, entry.referenceId)) {
          const fallback = reference.later?.find(item => eligibleWinner(source, references.get(item.referenceId)!.rootId, item.referenceId));
          if (!fallback) continue;
          winner = fallback;
          reference = references.get(fallback.referenceId)!;
        }
        candidates.push(this.createResponseCandidate(source, roots, winner, reference, candidates.length));
      }
      source.usage = undefined;
    }

    // [Winner 정책] 원래 ID 필드로 같은 응답을 모아 입력+출력 합과 이벤트 순서로 winner를 고른다.
    const compareResponses = files[0].file.provider === 'claude' ? compareClaudeResponses : compareCodexResponses;
    candidates.sort(compareResponses);
    const selected: (ResponseCandidate | undefined)[] = [];
    for (let index = 0; index < candidates.length;) {
      const first = candidates[index++];
      let winner = first;
      while (index < candidates.length && compareResponses(candidates[index], first) === 0) {
        const candidate = candidates[index++];
        if (isBetterUsage(candidate.score, candidate.ordinal, winner.score, winner.ordinal)) winner = candidate;
      }
      // [집계 정책] 그룹의 첫 등장 위치에 winner를 놓아 기존 반영·진단 순서를 유지한다.
      selected[first.position] = winner;
    }
    for (const winner of selected) if (winner) this.applyUsage(winner);
  }

  private recordCapability(root: Root, event: CapabilityEvent): void {
    if (!this.collectCapabilities) return;
    // [집계 정책] 같은 요청에서 스레드·이벤트·분류·이름이 같은 도구 사용을 한 번만 센다.
    const id = key(root.provider, root.session, root.rootId, event.threadId, event.eventId, event.category, event.name);
    if (!this.capabilities.has(id)) { this.capabilities.add(id); addCapability(root, event.category, event.name); }
  }

  private recordCheck(source: SourcePlan, rootId: string, check: SourceCheck): void {
    // [진단 정책] 제공자·세션·스레드·턴마다 전체 이벤트 순서상 가장 뒤의 누계 검사를 남긴다.
    const { file } = source, ordinal = source.base + check.index;
    const id = key(file.provider, file.session_id, check.threadId, check.turnId), previous = this.checks.get(id);
    if (!previous) {
      this.checks.set(id, { source, rootId, check, ordinal });
    } else if (ordinal > previous.ordinal) {
      previous.source = source;
      previous.rootId = rootId;
      previous.check = check;
      previous.ordinal = ordinal;
    }
  }

  private recordOutcome(outcomes: Map<string, Outcome>, root: Root, event: TurnEvent,
    ordinal: number, orderingAt: number | null): void {
    // [집계 정책] 원본 안에서는 마지막 상태 이벤트와 가장 늦은 비교 시각을 각각 보존한다.
    let outcome = outcomes.get(root.rootId);
    if (!outcome) {
      outcome = { event, ordinal, orderingAt };
      outcomes.set(root.rootId, outcome);
    } else {
      outcome.orderingAt = max(outcome.orderingAt, orderingAt);
      if (ordinal > outcome.ordinal) { outcome.event = event; outcome.ordinal = ordinal; }
    }

    // [집계 정책] 원본 간에는 비교 시각을 우선하고 시각이 같으면 이벤트 순서로 상태를 고른다.
    const before = root.outcome;
    if (!before || outcome.orderingAt !== null && (before.orderingAt === null || outcome.orderingAt > before.orderingAt)
      || outcome.orderingAt === before.orderingAt && outcome.ordinal > before.ordinal) root.outcome = outcome;
  }

  private observeRequest(file: StreamingAggregateFile, roots: Map<string, Root>, rootId: string, offset: number): Root {
    // [귀속 정책] 제공자·세션·요청 단위로 메인 원본 유무와 최소 파일 ID·오프셋을 추적한다.
    let root = roots.get(rootId);
    if (!root) {
      root = createRoot(file, rootId, offset);
      roots.set(rootId, root);
      this.roots.push(root);
    }
    if (file.id < root.firstFile.id) root.firstFile = file;
    root.offset = Math.min(root.offset, offset); root.hasMain ||= file.identity.isMain;
    return root;
  }

  finish(check?: () => void): MemoryAggregateResult {
    // [Winner 정책] 세션별로 중복을 해소하고 확정된 응답만 요청 집계에 반영한다.
    for (const [id, files] of this.sessions) {
      check?.();
      this.applySessionUsage(files, this.sessionRoots.get(id)!);
    }

    // [진단 정책] 확정 응답의 턴별 합계가 로그에 기록된 누계와 다르면 불일치 플래그를 남긴다.
    for (const { source, rootId, check: { input, output, verified }, sum } of this.checks.values()) {
      const missingInput = input - (sum?.input ?? 0), missingOutput = output - (sum?.output ?? 0);
      if (!missingInput && !missingOutput) continue;
      const canSupplement = sum && verified && missingInput >= 0 && missingOutput >= 0;
      if (!canSupplement) {
        addFlag(source.flags, rootId, 'token-total-mismatch');
        continue;
      }
      const { file } = source;
      const root = this.sessionRoots.get(key(file.provider, file.session_id))!.get(rootId)!;
      const billingMode = root.billing.size === 1 ? root.billing.keys().next().value : undefined;
      addUsage(root, { model: verified.model, billingMode, tokens: {
        input: missingInput, output: missingOutput,
        cacheRead: Math.max(0, verified.cacheRead - sum.cacheRead),
        cacheWrite: Math.max(0, verified.cacheWrite - sum.cacheWrite),
      } }, false);
    }

    // [DTO 정책] 요청·모델·도구 집계와 메인 원본을 찾지 못한 요청의 진단을 반환한다.
    return materialize(this.roots, this.sessions, this.collectCapabilities);
  }

  private applyUsage({ source, root, reference, tokens, request }: ResponseCandidate): void {
    const { file } = source, { model, billingMode, threadId, turnId } = reference;
    // [집계 정책] 확정 응답에 적용한 캐시 보정값을 턴 누계 검산에 재사용한다.
    let cacheRead = accountedCacheRead(tokens), cacheWrite = accountedCacheWrite(tokens);
    addUsage(root, { model, billingMode, tokens }, this.collectCapabilities, 1, cacheRead, cacheWrite);

    // [DTO 정책] 확정 응답의 키·귀속·토큰을 콜백에 전달한다.
    const hasCallback = this.onApplied !== undefined;
    this.onApplied?.({ provider: file.provider, sessionId: file.session_id, rootId: root.rootId, tokens,
      responseKey: file.provider === 'claude' ? key(reference.responseId, request ?? MISSING_CLAUDE_REQUEST)
        : key(reference.responseId, threadId, turnId) });

    // [진단 정책] 누계 검사용 턴별 합계를 쌓고, 보정 후에도 요청 ID가 없는 Claude 응답을 표시한다.
    const check = this.checks.size ? this.checks.get(key(file.provider, file.session_id, threadId, turnId)) : undefined;
    if (check) {
      const sum = check.sum ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      sum.input += tokens.input; sum.output += tokens.output;
      // 상세 콜백이 있으면 기존대로 콜백 이후의 토큰을 검산한다.
      if (hasCallback) {
        cacheRead = accountedCacheRead(tokens);
        cacheWrite = accountedCacheWrite(tokens);
      }
      sum.cacheRead += cacheRead; sum.cacheWrite += cacheWrite;
    }
    if (file.provider === 'claude' && request === null) addFlag(source.flags, root.rootId, 'missing-request-id');
  }
}
