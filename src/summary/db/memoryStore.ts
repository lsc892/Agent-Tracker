// 메모리에서 완성한 요청 snapshot을 비교해 달라진 영속 행만 원자적으로 반영한다.
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import type { SqliteSession } from './connection';
import type { SessionBillingStore } from './billing';
import type { BillingMode, FileMetadata, ModelUsageInput, SessionRef, TurnSummaryInput } from './types';
import { nonnegative } from './validation';
import { estimateCost, PRICING_VERSION } from '../models/pricing';
import { performance } from 'node:perf_hooks';
import { StageProfiler, type StorageStage } from '../profiling';

export interface MemoryReplacement {
  sessions: Iterable<SessionRef>;
  summaries: Iterable<TurnSummaryInput>;
  files: readonly (FileMetadata & { id: number })[];
  removedFileIds?: Iterable<number>;
  reconnectedFiles?: readonly { old_id: number; new_id: number }[];
  preserveCapabilities?: boolean;
  retainDeletedSourceUsage?: boolean;
  scanId: string;
}

type ReplacementSessions = Map<string, SessionRef>;
type SourceSession = { provider: string; session_id: string | null };
type RemovedSources = Map<number, SourceSession>;
type StoredRow = Record<string, SQLOutputValue>;
type MemoryFile = MemoryReplacement['files'][number];

interface RetainedUsage {
  turnIds: Set<number>;
  roots: Set<string>;
  sessions: Set<string>;
}

interface PreparedReplacement {
  replacement: MemoryReplacement;
  sessions: ReplacementSessions;
  next: Map<string, TurnSummaryInput>;
  removed: RemovedSources;
  reconnected: Map<number, number>;
  retained: RetainedUsage;
  now: string;
}

interface SessionMetadata extends SessionRef { name: string | null }
interface ReplacementMetadata {
  projects: Map<string, string>;
  sessions: Map<string, SessionMetadata>;
  billing: Map<string, BillingMode | undefined>;
}

/** COMMIT한 이름만 스캔 마무리의 중복 이름 갱신 생략에 사용한다. */
export type SavedSessionNames = ReadonlyMap<string, string>;

const SUMMARY_COLUMNS = [
  'provider', 'project_key', 'session_id', 'root_turn_id', 'request_title', 'started_at_ms', 'completed_at_ms',
  'duration_ms', 'duration_quality', 'input_tokens', 'output_tokens', 'cache_write_input_tokens', 'cache_read_input_tokens',
  'total_tokens', 'status', 'quality_flags', 'diagnostic_file_id', 'diagnostic_offset', 'last_error', 'updated_at',
];
const MAX_CAPABILITY_NAME_LENGTH = 512;

/** 제공자와 세션을 JSON 튜플로 묶어 충돌 없는 세션 키를 만든다. */
const sessionKey = (provider: unknown, session: unknown): string => JSON.stringify([provider, session]);

/** 제공자와 요청 root를 JSON 튜플로 묶어 삭제 보존 여부를 구분한다. */
const rootKey = (provider: unknown, root: unknown): string => JSON.stringify([provider, root]);

/** 정렬된 SQL 값 배열을 같은 JSON 표현으로 비교한다. */
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** 모델명의 문자열 순서를 비교해 기존 SQL 행과 같은 순서로 맞춘다. */
function compareModels(left: SQLInputValue[], right: SQLInputValue[]): number {
  if (String(left[0]) < String(right[0])) return -1;
  if (String(left[0]) > String(right[0])) return 1;
  return 0;
}

/** 분류·이름의 JSON 키를 localeCompare로 비교해 기존 Skill 정렬을 유지한다. */
function compareCapabilities(left: SQLInputValue[], right: SQLInputValue[]): number {
  return JSON.stringify(left.slice(0, 2)).localeCompare(JSON.stringify(right.slice(0, 2)));
}

/** 요청의 수치 범위와 토큰 합계·캐시 포함 관계를 기존 순서대로 검사한다. */
function validateSummary(row: TurnSummaryInput): void {
  for (const name of ['input_tokens', 'output_tokens', 'total_tokens'] as const) {
    nonnegative(row[name], name);
  }
  if (row.total_tokens !== row.input_tokens + row.output_tokens) throw new RangeError('Invalid total tokens');
  if (row.duration_ms != null) nonnegative(row.duration_ms, 'duration_ms');
  for (const name of ['cache_write_input_tokens', 'cache_read_input_tokens'] as const) {
    if (row[name] != null) nonnegative(row[name], name);
  }
  if ((row.cache_write_input_tokens ?? 0) + (row.cache_read_input_tokens ?? 0) > row.input_tokens) {
    throw new RangeError('Cache components cannot exceed input tokens');
  }
}

/** 검증한 요청을 고정 열 순서로 변환하며 undefined와 null의 기존 기본값을 유지한다. */
function summaryValues(row: TurnSummaryInput, now: string): SQLInputValue[] {
  validateSummary(row);
  return [
    row.provider, row.project_key, row.session_id, row.root_turn_id, row.request_title ?? null,
    row.started_at_ms ?? null, row.completed_at_ms ?? null, row.duration_ms ?? null, row.duration_quality,
    row.input_tokens, row.output_tokens,
    row.cache_write_input_tokens === undefined ? 0 : row.cache_write_input_tokens,
    row.cache_read_input_tokens === undefined ? 0 : row.cache_read_input_tokens,
    row.total_tokens, row.status, row.quality_flags ?? null, row.diagnostic_file_id ?? null,
    row.diagnostic_offset ?? null, row.last_error ?? null, row.updated_at ?? now,
  ];
}

/** DTO를 SQL 임시 표에 재적재하지 않고 최종 facts·모델·도구·원본 상태를 저장한다. */
export class MemoryStore {
  constructor(
    private readonly database: SqliteSession, private readonly billing: SessionBillingStore,
    private readonly profile = new StageProfiler<StorageStage>(),
  ) {}

  /** 최종 snapshot의 모든 변경을 하나의 트랜잭션으로 묶어 실패 시 함께 되돌린다. */
  replace(replacement: MemoryReplacement): SavedSessionNames {
    return this.replaceBatch([replacement]);
  }

  /** 독립 snapshot을 적용한 뒤 변경 세션의 rollup을 한 번 갱신하고 함께 확정한다. */
  replaceBatch(replacements: readonly MemoryReplacement[]): SavedSessionNames {
    const savedNames = new Map<string, string>();
    if (!replacements.length) return savedNames;
    this.profile.measure('replace', () => this.database.transaction(() => {
      const inputs = replacements.map(replacement => ({ ...replacement, sessions: [...replacement.sessions],
        removedFileIds: [...replacement.removedFileIds ?? []] }));
      const changedSessions: ReplacementSessions = new Map();
      if (this.canShareMetadata(inputs)) {
        this.applyPrepared(inputs.map(replacement => this.prepare(replacement)), changedSessions, savedNames);
      } else {
        // Repeated sessions and source removal retain their original intermediate prune/cascade semantics.
        for (const replacement of inputs) this.applyPrepared([this.prepare(replacement)], changedSessions, savedNames);
      }
      if (changedSessions.size) {
        this.profile.measure('rollups', () => {
          if (replacements.length === 1) {
            for (const session of changedSessions.values()) this.database.rollups.refreshSession(session.provider, session.session_id, this.profile);
          } else this.database.rollups.refreshSessions([...changedSessions.values()], this.profile);
        });
      }
    }, this.profile));
    return savedNames;
  }

  /** 서로 독립적인 정상 snapshot만 이름·설정 계획과 마지막 이름 정리를 공유한다. */
  private canShareMetadata(replacements: readonly MemoryReplacement[]): boolean {
    const seen = new Set<string>();
    for (const replacement of replacements) {
      if ([...replacement.removedFileIds ?? []].length || replacement.reconnectedFiles?.length) return false;
      for (const session of replacement.sessions) {
        const key = sessionKey(session.provider, session.session_id);
        if (seen.has(key)) return false;
        seen.add(key);
      }
    }
    return true;
  }

  /** 입력 iterable을 한 번 색인하고 실제 저장에서 제외할 보존 root를 확정한다. */
  private prepare(replacement: MemoryReplacement): PreparedReplacement {
    const prepareStarted = performance.now();
    const now = new Date().toISOString();
    const sessions = new Map(Array.from(replacement.sessions, session => [sessionKey(session.provider, session.session_id), session]));
    const removed = this.collectRemovedSources(replacement.removedFileIds ?? [], sessions);
    const reconnected = this.collectReconnectedSources(replacement, removed, sessions);
    const retained = this.collectRetainedUsage(replacement.retainDeletedSourceUsage, removed, reconnected);
    this.profile.record('prepare', prepareStarted);
    const next = this.profile.measure('indexSummaries', () => this.indexSummaries(replacement.summaries, sessions));
    return { replacement, sessions, next, removed, reconnected, retained, now };
  }

  /** 최종 이름·설정을 먼저 저장한 뒤 facts를 순차 반영하고 사용하지 않는 이름을 한 번 정리한다. */
  private applyPrepared(plans: readonly PreparedReplacement[], batchSessions: ReplacementSessions, savedNames: Map<string, string>): void {
    const metadata = this.profile.measure('metadata', () => {
      const metadata = this.collectMetadata(plans);
      this.saveNames(metadata, savedNames);
      return metadata;
    });
    const affectedSessions: ReplacementSessions = new Map(), affectedProjects = new Set<string>();
    for (const { replacement, sessions, next, removed, reconnected, retained, now } of plans) {
      const changedSessions = new Set<string>();
      this.profile.measure('manifest', () => this.saveFiles(replacement, sessions, now));
      this.profile.measure('deleteMissing', () => this.deleteMissingSummaries(sessions, next, retained.turnIds, changedSessions, affectedProjects));
      this.profile.measure('summaries', () => this.saveSummaries(next, retained.roots, replacement.preserveCapabilities,
        now, changedSessions, affectedProjects, metadata.billing));
      this.profile.measure('reconnectDiagnostics', () => this.reconnectDiagnostics(reconnected));
      this.profile.measure('removeSources', () => this.removeSources(removed, reconnected, retained.sessions, now));
      for (const [key, session] of sessions)
        if (changedSessions.has(key)) batchSessions.set(key, session);
      for (const [key, session] of sessions) affectedSessions.set(key, session);
    }
    this.profile.measure('pruneNames', () => this.pruneNames(affectedSessions, affectedProjects, savedNames));
  }

  /** 원본의 세션이 교체 범위에 포함되는지 검사하되 미귀속 원본은 허용한다. */
  private requireSession(provider: unknown, session: unknown, sessions: ReplacementSessions): void {
    if (session !== null && !sessions.has(sessionKey(provider, session))) {
      throw new Error('Source is outside the replacement session group');
    }
  }

  /** 삭제 ID의 manifest를 순서대로 읽고 교체 범위를 검증해 삭제 후보 Map을 만든다. */
  private collectRemovedSources(ids: Iterable<number>, sessions: ReplacementSessions): RemovedSources {
    const removed: RemovedSources = new Map();
    for (const id of ids) {
      const file = this.database.statement('SELECT provider,session_id FROM manifest WHERE id=?')
        .get(id) as SourceSession | undefined;
      if (!file) continue;
      this.requireSession(file.provider, file.session_id, sessions);
      removed.set(id, file);
    }
    return removed;
  }

  /** 이동 전·후 원본의 존재·제공자·교체 범위를 확인해 진단 참조의 새 ID를 기록한다. */
  private collectReconnectedSources(
    replacement: MemoryReplacement, removed: RemovedSources, sessions: ReplacementSessions,
  ): Map<number, number> {
    const reconnected = new Map<number, number>();
    for (const link of replacement.reconnectedFiles ?? []) {
      const previous = removed.get(link.old_id);
      const current = replacement.files.find(file => file.id === link.new_id)
        ?? this.database.statement('SELECT provider,session_id FROM manifest WHERE id=?').get(link.new_id);
      if (!previous || !current || link.old_id === link.new_id || previous.provider !== current.provider) {
        throw new Error('Invalid reconnected source');
      }
      this.requireSession(current.provider, current.session_id, sessions);
      reconnected.set(link.old_id, link.new_id);
    }
    return reconnected;
  }

  /** 삭제 보존이 켜진 누락 원본에서 유효 사용량이 있는 요청·root·세션 키를 수집한다. */
  private collectRetainedUsage(
    enabled: boolean | undefined, removed: RemovedSources, reconnected: Map<number, number>,
  ): RetainedUsage {
    const retained: RetainedUsage = { turnIds: new Set(), roots: new Set(), sessions: new Set() };
    if (!enabled) return retained;
    for (const [id, file] of removed) {
      if (reconnected.has(id) || file.session_id === null) continue;
      this.retainSourceUsage(file, retained);
    }
    return retained;
  }

  /** 모델·양수 토큰·유효 식별자가 있는 저장 요청만 읽어 세 보존 집합에 추가한다. */
  private retainSourceUsage(file: SourceSession, retained: RetainedUsage): void {
    const requests = this.database.statement(`SELECT t.id,t.root_turn_id FROM turn_summary t WHERE t.provider=? AND t.session_id=?
      AND trim(t.session_id)<>'' AND trim(t.root_turn_id)<>'' AND t.total_tokens>0
      AND EXISTS(SELECT 1 FROM turn_model_usage u WHERE u.turn_id=t.id AND trim(u.model)<>'' AND u.input_tokens+u.output_tokens>0)`)
      .all(file.provider, file.session_id) as { id: number; root_turn_id: string }[];
    for (const row of requests) {
      retained.turnIds.add(row.id);
      retained.roots.add(rootKey(file.provider, row.root_turn_id));
      retained.sessions.add(sessionKey(file.provider, file.session_id));
    }
  }

  /** 요청의 진단 참조가 가리킬 수 있도록 manifest를 요청 저장보다 먼저 반영한다. */
  private saveFiles(replacement: MemoryReplacement, sessions: ReplacementSessions, now: string): void {
    for (const file of replacement.files) this.saveFile(file, sessions, replacement.scanId, now);
  }

  /** 원본 크기와 이전·현재 귀속을 검증한 뒤 정상 처리 snapshot으로 manifest를 UPSERT한다. */
  private saveFile(file: MemoryFile, sessions: ReplacementSessions, scanId: string, now: string): void {
    nonnegative(file.size_bytes, 'size_bytes');
    const previous = this.database.statement('SELECT provider,session_id FROM manifest WHERE id=?').get(file.id);
    if (previous) this.validatePreviousSource(file, previous, sessions);
    this.requireSession(file.provider, file.session_id, sessions);
    this.database.statement(`INSERT INTO manifest(id,provider,source_root,path,session_id,size_bytes,mtime_ms,dev,inode,parser_version,
        source_identity,content_hash,capabilities_collected,source_missing,last_seen_scan_id,processing_status,processing_position,recorded_at,last_error)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,'done','committed',?,NULL)
      ON CONFLICT(id) DO UPDATE SET source_root=excluded.source_root,path=excluded.path,session_id=excluded.session_id,
        size_bytes=excluded.size_bytes,mtime_ms=excluded.mtime_ms,dev=excluded.dev,inode=excluded.inode,
        parser_version=excluded.parser_version,source_identity=excluded.source_identity,content_hash=excluded.content_hash,
        capabilities_collected=excluded.capabilities_collected,source_missing=0,last_seen_scan_id=excluded.last_seen_scan_id,
        processing_status='done',processing_position='committed',recorded_at=excluded.recorded_at,last_error=NULL`)
      .run(file.id, file.provider, file.source_root, file.path, file.session_id, file.size_bytes, file.mtime_ms, file.dev, file.inode,
        file.parser_version, file.source_identity ?? null, file.content_hash ?? null, file.capabilities_collected ?? 1, scanId, now);
  }

  /** 기존 manifest의 제공자를 바꾸지 않고 이전 귀속도 같은 교체 범위에 있는지 확인한다. */
  private validatePreviousSource(file: MemoryFile, previous: StoredRow, sessions: ReplacementSessions): void {
    if (previous.provider !== file.provider) throw new Error('Manifest provider cannot change');
    this.requireSession(previous.provider, previous.session_id, sessions);
  }

  /** 요청을 입력 순서대로 검증하고 제공자·세션·root 키의 중복 없는 Map을 만든다. */
  private indexSummaries(summaries: Iterable<TurnSummaryInput>, sessions: ReplacementSessions): Map<string, TurnSummaryInput> {
    const next = new Map<string, TurnSummaryInput>();
    for (const summary of summaries) {
      this.requireSession(summary.provider, summary.session_id, sessions);
      const key = JSON.stringify([summary.provider, summary.session_id, summary.root_turn_id]);
      if (next.has(key)) throw new Error('Duplicate request in memory replacement');
      next.set(key, summary);
    }
    return next;
  }

  /** 세션별 기존 요청을 조사해 최종 snapshot에서 사라진 비보존 요청을 제거한다. */
  private deleteMissingSummaries(
    sessions: ReplacementSessions, next: Map<string, TurnSummaryInput>, retainedIds: Set<number>,
    changedSessions: Set<string>, affectedProjects: Set<string>,
  ): void {
    for (const [key, session] of sessions) {
      this.deleteMissingSessionSummaries(key, session, next, retainedIds, changedSessions, affectedProjects);
    }
  }

  /** 한 세션의 기존 프로젝트를 기록하고 보존·최종 요청 키에 없는 행만 삭제한다. */
  private deleteMissingSessionSummaries(
    key: string, session: SessionRef, next: Map<string, TurnSummaryInput>, retainedIds: Set<number>,
    changedSessions: Set<string>, affectedProjects: Set<string>,
  ): void {
    const previous = this.database.statement('SELECT id,root_turn_id,project_key FROM turn_summary WHERE provider=? AND session_id=?')
      .all(session.provider, session.session_id) as { id: number; root_turn_id: string; project_key: string }[];
    for (const old of previous) {
      affectedProjects.add(old.project_key);
      const retained = retainedIds.has(old.id);
      if (retained || next.has(JSON.stringify([session.provider, session.session_id, old.root_turn_id]))) continue;
      this.database.statement('DELETE FROM turn_summary WHERE id=?').run(old.id);
      changedSessions.add(key);
    }
  }

  /** 삭제 보존 root는 건너뛰고 최종 요청을 입력 순서대로 비교·반영한다. */
  private saveSummaries(
    next: Map<string, TurnSummaryInput>, retainedRoots: Set<string>, preserveCapabilities: boolean | undefined,
    now: string, changedSessions: Set<string>, affectedProjects: Set<string>, billing: Map<string, BillingMode | undefined>,
  ): void {
    for (const summary of next.values()) {
      if (retainedRoots.has(rootKey(summary.provider, summary.root_turn_id))) continue;
      this.saveSummary(summary, preserveCapabilities, now, changedSessions, affectedProjects, billing);
    }
  }

  /** 요청·모델·Skill·비용을 비교해 같으면 쓰기를 생략하고 달라진 자식 행만 교체한다. */
  private saveSummary(
    summary: TurnSummaryInput, preserveCapabilities: boolean | undefined, now: string,
    changedSessions: Set<string>, affectedProjects: Set<string>, billing: Map<string, BillingMode | undefined>,
  ): void {
    const compareStarted = performance.now();
    const key = sessionKey(summary.provider, summary.session_id);
    const previous = this.database.statement('SELECT * FROM turn_summary WHERE provider=? AND session_id=? AND root_turn_id=?')
      .get(summary.provider, summary.session_id, summary.root_turn_id);
    const incoming = summaryValues(summary, now);
    const models = this.modelValues(summary);
    const capabilities = this.capabilityValues(summary);
    affectedProjects.add(summary.project_key);

    const previousModels = this.readModels(previous);
    const previousCapabilities = this.readCapabilities(previous);
    const modelsChanged = !equal(previousModels, models);
    const capabilitiesChanged = !preserveCapabilities && !equal(previousCapabilities, capabilities ?? []);
    const mode = billing.get(key) ?? summary.billing ?? 'unknown';
    const costChanged = this.hasCostChanged(previous, mode);
    const factsChanged = this.hasFactsChanged(previous, incoming, summary);
    this.profile.record('summaryCompare', compareStarted);
    if (!factsChanged && !modelsChanged && !capabilitiesChanged && !costChanged) return;

    const writeStarted = performance.now();
    try {
      const id = this.profile.measure('facts', () => this.saveFacts(previous, incoming));
      if (!previous || modelsChanged) this.profile.measure('models', () => this.replaceModels(id, models));
      if (!previous || capabilitiesChanged) {
        this.profile.measure('capabilities', () => this.replaceCapabilities(id, preserveCapabilities && previous ? previousCapabilities : capabilities ?? []));
      }
      this.profile.measure('costs', () => this.billing.saveTurnCost(id, mode));
      changedSessions.add(key);
    }
    finally { this.profile.record('summaryWrites', writeStarted); }
  }

  /** 실제 반영할 요청에서 마지막 프로젝트 이름과 마지막 nonempty 세션 이름을 선택한다. */
  private collectMetadata(plans: readonly PreparedReplacement[]): ReplacementMetadata {
    const projects = new Map<string, string>(), sessions = new Map<string, SessionMetadata>();
    for (const { next, retained } of plans) for (const summary of next.values()) {
      if (retained.roots.has(rootKey(summary.provider, summary.root_turn_id))) continue;
      projects.set(summary.project_key, summary.project_name);
      const key = sessionKey(summary.provider, summary.session_id), name = summary.session_name?.trim() || null;
      if (!sessions.has(key) || name !== null) sessions.set(key, { provider: summary.provider, session_id: summary.session_id, name });
    }
    return { projects, sessions, billing: new Map() };
  }

  /** 요청 FK의 부모 이름을 키별 한 번 UPSERT하고 세션별 사용자 결제 설정을 한 번 읽는다. */
  private saveNames(metadata: ReplacementMetadata, savedNames: Map<string, string>): void {
    const project = this.database.statement(`INSERT INTO projects VALUES(?,?) ON CONFLICT(project_key) DO UPDATE SET project_name=excluded.project_name
      WHERE project_name<>excluded.project_name`);
    for (const [key, name] of metadata.projects) project.run(key, name);
    const session = this.database.statement(`INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(provider,session_id) DO UPDATE SET session_name=excluded.session_name
      WHERE excluded.session_name IS NOT NULL AND session_name IS NOT excluded.session_name`);
    const billing = this.database.statement('SELECT billing_mode FROM session_billing WHERE provider=? AND session_id=?');
    for (const [key, value] of metadata.sessions) {
      session.run(value.provider, value.session_id, value.name);
      metadata.billing.set(key, billing.get(value.provider, value.session_id)?.billing_mode as BillingMode | undefined);
      if (value.name !== null) savedNames.set(key, value.name);
    }
  }

  /** 기존 모델 행을 값 배열로 읽어 입력 모델 행과 동일한 문자열 순서로 정렬한다. */
  private readModels(previous: StoredRow | undefined): SQLInputValue[][] {
    if (!previous) return [];
    const models = this.database.statement(`SELECT model,input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens,
      estimated_cost_usd,pricing_version FROM turn_model_usage WHERE turn_id=? ORDER BY model`)
      .all(previous.id).map(Object.values);
    return models.sort(compareModels);
  }

  /** 기존 Skill 행을 값 배열로 읽어 분류·이름의 기존 비교 순서로 정렬한다. */
  private readCapabilities(previous: StoredRow | undefined): SQLInputValue[][] {
    if (!previous) return [];
    const capabilities = this.database.statement('SELECT category,name,usage_count FROM turn_capability_usage WHERE turn_id=? ORDER BY category,name')
      .all(previous.id).map(Object.values);
    return capabilities.sort(compareCapabilities);
  }

  /** 기존 비용의 결제 방식·단가 버전을 비교해 비용 재계산 필요 여부를 판정한다. */
  private hasCostChanged(previous: StoredRow | undefined, mode: BillingMode): boolean {
    const cost = previous
      ? this.database.statement('SELECT billing_mode,pricing_version FROM turn_costs WHERE turn_id=?').get(previous.id)
      : undefined;
    return !cost || cost.billing_mode !== mode || cost.pricing_version !== PRICING_VERSION;
  }

  /** 요청 열을 바인딩 값과 비교하되 updated_at은 입력이 명시한 경우에만 비교한다. */
  private hasFactsChanged(previous: StoredRow | undefined, incoming: SQLInputValue[], summary: TurnSummaryInput): boolean {
    if (!previous) return true;
    return SUMMARY_COLUMNS.some((name, index) => {
      if (name === 'updated_at') return summary.updated_at !== undefined && previous.updated_at !== summary.updated_at;
      return previous[name] !== incoming[index];
    });
  }

  /** 기존 요청은 같은 ID로 UPDATE하고 새 요청은 INSERT한 ID를 반환한다. */
  private saveFacts(previous: StoredRow | undefined, incoming: SQLInputValue[]): number | bigint {
    if (!previous) {
      return this.database.statement(`INSERT INTO turn_summary(${SUMMARY_COLUMNS.join(',')}) VALUES(${SUMMARY_COLUMNS.map(() => '?').join(',')})`)
        .run(...incoming).lastInsertRowid;
    }
    const id = previous.id as number;
    this.database.statement(`UPDATE turn_summary SET ${SUMMARY_COLUMNS.map(name => `${name}=?`).join(',')} WHERE id=?`).run(...incoming, id);
    return id;
  }

  /** 한 요청의 모델 행을 삭제하고 검증·정렬한 최종 모델 snapshot을 순서대로 저장한다. */
  private replaceModels(id: number | bigint, models: SQLInputValue[][]): void {
    this.database.statement('DELETE FROM turn_model_usage WHERE turn_id=?').run(id);
    for (const model of models) this.database.statement('INSERT INTO turn_model_usage VALUES(?,?,?,?,?,?,?,?)').run(id, ...model);
  }

  /** 한 요청의 Skill 행을 삭제하고 보존 또는 새 집계로 선택한 횟수 snapshot을 저장한다. */
  private replaceCapabilities(id: number | bigint, capabilities: SQLInputValue[][]): void {
    this.database.statement('DELETE FROM turn_capability_usage WHERE turn_id=?').run(id);
    for (const usage of capabilities) this.database.statement('INSERT INTO turn_capability_usage VALUES(?,?,?,?)').run(id, ...usage);
  }

  /** 검증된 이동 쌍의 이전 진단 원본 ID를 새 manifest ID로 바꾼다. */
  private reconnectDiagnostics(reconnected: Map<number, number>): void {
    for (const [oldId, newId] of reconnected) {
      this.database.statement('UPDATE turn_summary SET diagnostic_file_id=? WHERE diagnostic_file_id=?').run(newId, oldId);
    }
  }

  /** 이동·보존 여부에 따라 삭제 후보 manifest를 제거하거나 source_missing으로 남긴다. */
  private removeSources(
    removed: RemovedSources, reconnected: Map<number, number>, retainedSessions: Set<string>, now: string,
  ): void {
    for (const [id, file] of removed) {
      this.removeSource(id, file, reconnected, retainedSessions, now);
    }
  }

  /** 이동되지 않은 보존 세션의 원본만 누락 표시하고 나머지 manifest는 삭제한다. */
  private removeSource(
    id: number, file: SourceSession, reconnected: Map<number, number>, retainedSessions: Set<string>, now: string,
  ): void {
    if (!reconnected.has(id) && retainedSessions.has(sessionKey(file.provider, file.session_id))) {
      this.database.statement('UPDATE manifest SET source_missing=1,recorded_at=? WHERE id=? AND source_missing=0').run(now, id);
      return;
    }
    this.database.statement('DELETE FROM manifest WHERE id=?').run(id);
  }

  /** 요청이 더 이상 참조하지 않는 대상 세션 이름과 영향 프로젝트 이름만 삭제한다. */
  private pruneNames(sessions: ReplacementSessions, affectedProjects: Set<string>, savedNames: Map<string, string>): void {
    for (const [key, session] of sessions) {
      const deleted = this.database.statement(`DELETE FROM sessions WHERE provider=? AND session_id=? AND NOT EXISTS(
        SELECT 1 FROM turn_summary t WHERE t.provider=sessions.provider AND t.session_id=sessions.session_id)`)
        .run(session.provider, session.session_id);
      if (deleted.changes) savedNames.delete(key);
    }
    for (const project of affectedProjects) {
      this.database.statement(`DELETE FROM projects WHERE project_key=?
        AND NOT EXISTS(SELECT 1 FROM turn_summary t WHERE t.project_key=projects.project_key)`).run(project);
    }
  }

  /** 모델별 수치를 검증·누적하고 단가를 붙인 행을 모델명순으로 만들어 요청 합계와 대조한다. */
  private modelValues(summary: TurnSummaryInput): SQLInputValue[][] {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    const models = [...summary.model_usage ?? []].map(model => {
      this.validateModel(model);
      input += model.input_tokens;
      output += model.output_tokens;
      cacheRead += model.cache_read_input_tokens ?? 0;
      cacheWrite += model.cache_write_input_tokens ?? 0;
      return [
        model.model, model.input_tokens, model.output_tokens, model.cache_write_input_tokens, model.cache_read_input_tokens,
        estimateCost(summary.provider, model), PRICING_VERSION,
      ] as SQLInputValue[];
    }).sort(compareModels);
    if (!summary.model_usage) return models;
    const totalsMatch = input === summary.input_tokens && output === summary.output_tokens
      && cacheRead === (summary.cache_read_input_tokens ?? 0) && cacheWrite === (summary.cache_write_input_tokens ?? 0);
    if (!totalsMatch) throw new RangeError('Model totals must match the request summary');
    return models;
  }

  /** 모델의 비음수 토큰과 캐시 포함 관계를 원래 검증 순서대로 확인한다. */
  private validateModel(model: ModelUsageInput): void {
    nonnegative(model.input_tokens, 'model input tokens');
    nonnegative(model.output_tokens, 'model output tokens');
    if (model.cache_write_input_tokens != null) nonnegative(model.cache_write_input_tokens, 'model cache write tokens');
    if (model.cache_read_input_tokens != null) nonnegative(model.cache_read_input_tokens, 'model cache read tokens');
    if ((model.cache_write_input_tokens ?? 0) + (model.cache_read_input_tokens ?? 0) > model.input_tokens) {
      throw new RangeError('Invalid model cache components');
    }
  }

  /** Skill 횟수·이름 길이를 검증하고 미수집 상태를 보존한 채 분류·이름순 바인딩 행을 만든다. */
  private capabilityValues(summary: TurnSummaryInput): SQLInputValue[][] | undefined {
    if (summary.capability_usage === undefined) return undefined;
    return [...summary.capability_usage].map(usage => {
      nonnegative(usage.usage_count, 'capability count');
      if (usage.name.length > MAX_CAPABILITY_NAME_LENGTH) throw new RangeError('Capability name is too long');
      return [usage.category, usage.name, usage.usage_count] as SQLInputValue[];
    }).sort(compareCapabilities);
  }
}
