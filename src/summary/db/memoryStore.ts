// 메모리에서 완성한 요청 snapshot을 비교해 달라진 영속 행만 원자적으로 반영한다.
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import type { SqliteSession } from './connection';
import type { SessionBillingStore } from './billing';
import type { BillingMode, FileMetadata, ModelUsageInput, SessionRef, TurnSummaryInput } from './types';
import { nonnegative } from './validation';
import { estimateCost, PRICING_VERSION } from '../models/pricing';

export interface MemoryReplacement {
  sessions: readonly SessionRef[];
  summaries: readonly TurnSummaryInput[];
  files: readonly (FileMetadata & { id: number })[];
  removedFileIds?: readonly number[];
  reconnectedFiles?: readonly { old_id: number; new_id: number }[];
  preserveCapabilities?: boolean;
  retainDeletedSourceUsage?: boolean;
  metadata?: readonly {
    provider: SessionRef['provider'];
    session_id: string;
    root_id: string;
    signature: string;
  }[];
  scanId: string;
}

type ReplacementSessions = Map<string, SessionRef>;
type SourceSession = { provider: string; session_id: string | null };
type RemovedSources = Map<number, SourceSession>;
type StoredRow = Record<string, SQLOutputValue>;
type MemoryFile = MemoryReplacement['files'][number];
type MemoryMetadata = NonNullable<MemoryReplacement['metadata']>[number];

interface RetainedUsage {
  turnIds: Set<number>;
  roots: Set<string>;
  sessions: Set<string>;
}

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
  constructor(private readonly database: SqliteSession, private readonly billing: SessionBillingStore) {}

  /** 최종 snapshot의 모든 변경을 하나의 트랜잭션으로 묶어 실패 시 함께 되돌린다. */
  replace(replacement: MemoryReplacement): void {
    this.database.transaction(() => this.apply(replacement));
  }

  /** 보존 대상 준비부터 원본·요청·metadata 반영과 파생 데이터 정리까지 순서대로 조율한다. */
  private apply(replacement: MemoryReplacement): void {
    const now = new Date().toISOString();
    const sessions = new Map(replacement.sessions.map(session => [sessionKey(session.provider, session.session_id), session]));
    const changedSessions = new Set<string>();
    const affectedProjects = new Set<string>();
    const removed = this.collectRemovedSources(replacement.removedFileIds ?? [], sessions);
    const reconnected = this.collectReconnectedSources(replacement, removed, sessions);
    const retained = this.collectRetainedUsage(replacement.retainDeletedSourceUsage, removed, reconnected);

    this.saveFiles(replacement, sessions, now);
    const next = this.indexSummaries(replacement.summaries, sessions);
    this.deleteMissingSummaries(sessions, next, retained.turnIds, changedSessions, affectedProjects);
    this.saveSummaries(next, retained.roots, replacement.preserveCapabilities, now, changedSessions, affectedProjects);
    this.reconnectDiagnostics(reconnected);
    this.removeSources(removed, reconnected, retained.sessions, now);
    const metadataKeys = this.saveMetadata(replacement.metadata ?? [], sessions, next, retained.roots);
    this.finishSessions(sessions, metadataKeys, retained.roots, changedSessions);
    this.pruneNames(sessions, affectedProjects);
  }

  /** 원본의 세션이 교체 범위에 포함되는지 검사하되 미귀속 원본은 허용한다. */
  private requireSession(provider: unknown, session: unknown, sessions: ReplacementSessions): void {
    if (session !== null && !sessions.has(sessionKey(provider, session))) {
      throw new Error('Source is outside the replacement session group');
    }
  }

  /** 삭제 ID의 manifest를 순서대로 읽고 교체 범위를 검증해 삭제 후보 Map을 만든다. */
  private collectRemovedSources(ids: readonly number[], sessions: ReplacementSessions): RemovedSources {
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
  private indexSummaries(summaries: readonly TurnSummaryInput[], sessions: ReplacementSessions): Map<string, TurnSummaryInput> {
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
    now: string, changedSessions: Set<string>, affectedProjects: Set<string>,
  ): void {
    for (const summary of next.values()) {
      if (retainedRoots.has(rootKey(summary.provider, summary.root_turn_id))) continue;
      this.saveSummary(summary, preserveCapabilities, now, changedSessions, affectedProjects);
    }
  }

  /** 요청·모델·Skill·비용을 비교해 같으면 쓰기를 생략하고 달라진 자식 행만 교체한다. */
  private saveSummary(
    summary: TurnSummaryInput, preserveCapabilities: boolean | undefined, now: string,
    changedSessions: Set<string>, affectedProjects: Set<string>,
  ): void {
    const key = sessionKey(summary.provider, summary.session_id);
    const previous = this.database.statement('SELECT * FROM turn_summary WHERE provider=? AND session_id=? AND root_turn_id=?')
      .get(summary.provider, summary.session_id, summary.root_turn_id);
    const incoming = summaryValues(summary, now);
    const models = this.modelValues(summary);
    const capabilities = this.capabilityValues(summary);
    this.saveNames(summary);
    affectedProjects.add(summary.project_key);

    const previousModels = this.readModels(previous);
    const previousCapabilities = this.readCapabilities(previous);
    const modelsChanged = !equal(previousModels, models);
    const capabilitiesChanged = !preserveCapabilities && !equal(previousCapabilities, capabilities ?? []);
    const mode = this.billingMode(summary);
    const costChanged = this.hasCostChanged(previous, mode);
    const factsChanged = this.hasFactsChanged(previous, incoming, summary);
    if (!factsChanged && !modelsChanged && !capabilitiesChanged && !costChanged) return;

    const id = this.saveFacts(previous, incoming);
    if (!previous || modelsChanged) this.replaceModels(id, models);
    if (!previous || capabilitiesChanged) {
      this.replaceCapabilities(id, preserveCapabilities && previous ? previousCapabilities : capabilities ?? []);
    }
    this.billing.saveTurnCost(id, mode);
    changedSessions.add(key);
  }

  /** 프로젝트 이름을 갱신하고 비어 있지 않은 세션 이름만 기존 값에 덮어쓴다. */
  private saveNames(summary: TurnSummaryInput): void {
    this.database.statement(`INSERT INTO projects VALUES(?,?) ON CONFLICT(project_key) DO UPDATE SET project_name=excluded.project_name
      WHERE project_name<>excluded.project_name`).run(summary.project_key, summary.project_name);
    this.database.statement(`INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(provider,session_id) DO UPDATE SET session_name=excluded.session_name
      WHERE excluded.session_name IS NOT NULL AND session_name IS NOT excluded.session_name`)
      .run(summary.provider, summary.session_id, summary.session_name?.trim() || null);
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

  /** 사용자 세션 결제 설정을 우선하고 없으면 요청의 방식과 unknown 순서로 선택한다. */
  private billingMode(summary: TurnSummaryInput): BillingMode {
    const chosen = this.database.statement('SELECT billing_mode FROM session_billing WHERE provider=? AND session_id=?')
      .get(summary.provider, summary.session_id)?.billing_mode as BillingMode | undefined;
    return chosen ?? summary.billing ?? 'unknown';
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

  /** metadata 입력의 범위를 검증하고 최신 키를 기록한 뒤 각 확정 snapshot을 반영한다. */
  private saveMetadata(
    metadata: readonly MemoryMetadata[], sessions: ReplacementSessions, next: Map<string, TurnSummaryInput>, retainedRoots: Set<string>,
  ): Set<string> {
    const keys = new Set<string>();
    for (const row of metadata) {
      this.requireSession(row.provider, row.session_id, sessions);
      const key = JSON.stringify([row.provider, row.session_id, row.root_id]);
      keys.add(key);
      this.saveRequestMetadata(row, key, next, retainedRoots);
    }
    return keys;
  }

  /** 보존·미존재 세션·동일 snapshot을 건너뛰고 바뀐 요청 metadata와 자식 행을 교체한다. */
  private saveRequestMetadata(
    metadata: MemoryMetadata, key: string, next: Map<string, TurnSummaryInput>, retainedRoots: Set<string>,
  ): void {
    if (retainedRoots.has(rootKey(metadata.provider, metadata.root_id))) return;
    if (!this.database.statement('SELECT 1 FROM sessions WHERE provider=? AND session_id=?').get(metadata.provider, metadata.session_id)) return;
    const summary = next.get(key);
    const prepared = summary ? JSON.stringify(summary) : null;
    const previous = this.database.statement('SELECT signature,prepared_json FROM turn_metadata WHERE provider=? AND session_id=? AND root_id=?')
      .get(metadata.provider, metadata.session_id, metadata.root_id);
    if (previous?.signature === metadata.signature && previous.prepared_json === prepared) return;
    this.database.statement(`INSERT INTO turn_metadata(provider,session_id,root_id,signature,prepared_json) VALUES(?,?,?,?,?)
      ON CONFLICT(provider,session_id,root_id) DO UPDATE SET signature=excluded.signature,prepared_json=excluded.prepared_json
      WHERE signature IS NOT excluded.signature OR prepared_json IS NOT excluded.prepared_json`)
      .run(metadata.provider, metadata.session_id, metadata.root_id, metadata.signature, prepared);
    this.replaceMetadataChildren(metadata);
  }

  /** 기존 metadata 자식 행을 지우고 확정 요청의 모델·Skill 행을 metadata snapshot으로 복사한다. */
  private replaceMetadataChildren(metadata: MemoryMetadata): void {
    for (const table of ['turn_metadata_models', 'turn_metadata_capabilities', 'turn_metadata_dependencies']) {
      this.database.statement(`DELETE FROM ${table} WHERE provider=? AND session_id=? AND root_id=?`)
        .run(metadata.provider, metadata.session_id, metadata.root_id);
    }
    const turn = this.database.statement('SELECT id FROM turn_summary WHERE provider=? AND session_id=? AND root_turn_id=?')
      .get(metadata.provider, metadata.session_id, metadata.root_id);
    if (!turn) return;
    this.database.statement(`INSERT INTO turn_metadata_models SELECT ?,?,?,model,input_tokens,output_tokens,cache_read_input_tokens,
      cache_write_input_tokens FROM turn_model_usage WHERE turn_id=?`)
      .run(metadata.provider, metadata.session_id, metadata.root_id, turn.id);
    this.database.statement(`INSERT INTO turn_metadata_capabilities SELECT ?,?,?,category,name,usage_count FROM turn_capability_usage WHERE turn_id=?`)
      .run(metadata.provider, metadata.session_id, metadata.root_id, turn.id);
  }

  /** 세션마다 사라진 metadata를 정리한 뒤 실제 요청이 바뀐 세션의 rollup만 재구축한다. */
  private finishSessions(
    sessions: ReplacementSessions, metadataKeys: Set<string>, retainedRoots: Set<string>, changedSessions: Set<string>,
  ): void {
    for (const [key, session] of sessions) {
      this.deleteMissingMetadata(session, metadataKeys, retainedRoots);
      if (!changedSessions.has(key)) continue;
      this.database.rollups.refreshSession(session.provider, session.session_id);
    }
  }

  /** 현재 입력에도 삭제 보존 root에도 없는 요청 metadata를 해당 세션에서 제거한다. */
  private deleteMissingMetadata(session: SessionRef, metadataKeys: Set<string>, retainedRoots: Set<string>): void {
    const previous = this.database.statement('SELECT root_id FROM turn_metadata WHERE provider=? AND session_id=?')
      .all(session.provider, session.session_id);
    for (const row of previous) {
      const key = JSON.stringify([session.provider, session.session_id, row.root_id]);
      if (metadataKeys.has(key) || retainedRoots.has(rootKey(session.provider, row.root_id))) continue;
      this.database.statement('DELETE FROM turn_metadata WHERE provider=? AND session_id=? AND root_id=?')
        .run(session.provider, session.session_id, row.root_id);
    }
  }

  /** 요청이 더 이상 참조하지 않는 대상 세션 이름과 영향 프로젝트 이름만 삭제한다. */
  private pruneNames(sessions: ReplacementSessions, affectedProjects: Set<string>): void {
    for (const session of sessions.values()) {
      this.database.statement(`DELETE FROM sessions WHERE provider=? AND session_id=? AND NOT EXISTS(
        SELECT 1 FROM turn_summary t WHERE t.provider=sessions.provider AND t.session_id=sessions.session_id)`)
        .run(session.provider, session.session_id);
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
