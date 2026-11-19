// 메모리에서 완성한 요청 snapshot을 비교해 달라진 영속 행만 원자적으로 반영한다.
import type { SQLInputValue } from 'node:sqlite';
import type { SqliteSession } from '../connection';
import type { SessionBillingStore } from '../billing';
import type { BillingMode, SessionRef, TurnSummaryInput } from '../types';
import { nonnegative } from '../validation';
import { PRICING_VERSION } from '../../models/pricing';
import { performance } from 'node:perf_hooks';
import { StageProfiler, type StorageStage } from '../../profiling';
import type { MemoryReplacement, SavedSessionNames } from './types';
import {
  SUMMARY_COLUMNS, capabilityValues, compareCapabilities, compareModels, equal, hasFactsChanged, modelValues, summaryValues,
} from './values';

export type { MemoryReplacement, SavedSessionNames } from './types';

interface BatchReplacement extends MemoryReplacement {
  sessions: SessionRef[];
  removedFileIds: number[];
}

type ReplacementSessions = Map<string, SessionRef>;
type SourceSession = { provider: string; session_id: string | null };
type RemovedSources = Map<number, SourceSession>;

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

/** 제공자와 세션을 JSON 튜플로 묶어 충돌 없는 세션 키를 만든다. */
const sessionKey = (provider: unknown, session: unknown): string => JSON.stringify([provider, session]);

/** 제공자와 요청 root를 JSON 튜플로 묶어 삭제 보존 여부를 구분한다. */
const rootKey = (provider: unknown, root: unknown): string => JSON.stringify([provider, root]);

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
      const inputs: BatchReplacement[] = replacements.map(replacement => ({ ...replacement, sessions: [...replacement.sessions],
        removedFileIds: [...replacement.removedFileIds ?? []] }));
      const changedSessions: ReplacementSessions = new Map();
      if (this.canShareMetadata(inputs)) {
        this.applyPrepared(inputs.map(replacement => this.prepare(replacement)), changedSessions, savedNames);
      } else {
        // Repeated sessions and source removal retain their original intermediate prune/cascade semantics.
        for (const replacement of inputs) this.applyPrepared([this.prepare(replacement)], changedSessions, savedNames);
      }
      if (!changedSessions.size) return;
      this.profile.measure('rollups', () => {
        if (replacements.length === 1) {
          for (const session of changedSessions.values()) {
            this.database.rollups.refreshSession(session.provider, session.session_id, this.profile);
          }
        } else {
          this.database.rollups.refreshSessions([...changedSessions.values()], this.profile);
        }
      });
    }, this.profile));
    return savedNames;
  }

  /** 서로 독립적인 정상 snapshot만 이름·설정 계획과 마지막 이름 정리를 공유한다. */
  private canShareMetadata(replacements: readonly BatchReplacement[]): boolean {
    const seen = new Set<string>();
    for (const replacement of replacements) {
      if (replacement.removedFileIds.length || replacement.reconnectedFiles?.length) return false;
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
    const checkedSessions = new Set<string>();
    for (const [id, file] of removed) {
      if (reconnected.has(id) || file.session_id === null) continue;
      const key = sessionKey(file.provider, file.session_id);
      if (checkedSessions.has(key)) continue;
      checkedSessions.add(key);
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
    return retained;
  }

  /** 요청의 진단 참조가 가리킬 수 있도록 manifest를 요청 저장보다 먼저 반영한다. */
  private saveFiles(replacement: MemoryReplacement, sessions: ReplacementSessions, now: string): void {
    for (const file of replacement.files) {
      const scanId = replacement.scanId;
      nonnegative(file.size_bytes, 'size_bytes');
      const previous = this.database.statement('SELECT provider,session_id FROM manifest WHERE id=?').get(file.id);
      if (previous) {
        if (previous.provider !== file.provider) throw new Error('Manifest provider cannot change');
        this.requireSession(previous.provider, previous.session_id, sessions);
      }
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
    const previous = this.database.statement(`SELECT t.*, c.billing_mode AS stored_billing_mode, c.pricing_version AS stored_pricing_version
      FROM turn_summary t LEFT JOIN turn_costs c ON c.turn_id=t.id
      WHERE t.provider=? AND t.session_id=? AND t.root_turn_id=?`)
      .get(summary.provider, summary.session_id, summary.root_turn_id);
    const incoming = summaryValues(summary, now);
    const models = modelValues(summary);
    const capabilities = capabilityValues(summary);
    affectedProjects.add(summary.project_key);

    let previousModels: SQLInputValue[][] = [];
    if (previous) {
      previousModels = this.database.statement(`SELECT model,input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens,
        estimated_cost_usd,pricing_version FROM turn_model_usage WHERE turn_id=?`)
        .all(previous.id).map(Object.values).sort(compareModels);
    }
    let previousCapabilities: SQLInputValue[][] = [];
    if (!preserveCapabilities && previous) {
      // localeCompare can tie distinct Unicode spellings; keep the original SQL tie order.
      previousCapabilities = this.database.statement('SELECT category,name,usage_count FROM turn_capability_usage WHERE turn_id=? ORDER BY category,name')
        .all(previous.id).map(Object.values).sort(compareCapabilities);
    }
    const modelsChanged = !equal(previousModels, models);
    const capabilitiesChanged = !preserveCapabilities && !equal(previousCapabilities, capabilities ?? []);
    const mode = billing.get(key) ?? summary.billing ?? 'unknown';
    const costChanged = !previous || previous.stored_billing_mode !== mode || previous.stored_pricing_version !== PRICING_VERSION;
    const factsChanged = hasFactsChanged(previous, incoming, summary);
    this.profile.record('summaryCompare', compareStarted);
    if (!factsChanged && !modelsChanged && !capabilitiesChanged && !costChanged) return;

    const writeStarted = performance.now();
    try {
      const id = this.profile.measure('facts', () => {
        if (!previous) {
          return this.database.statement(`INSERT INTO turn_summary(${SUMMARY_COLUMNS.join(',')}) VALUES(${SUMMARY_COLUMNS.map(() => '?').join(',')})`)
            .run(...incoming).lastInsertRowid;
        }
        const id = previous.id as number;
        this.database.statement(`UPDATE turn_summary SET ${SUMMARY_COLUMNS.map(name => `${name}=?`).join(',')} WHERE id=?`).run(...incoming, id);
        return id;
      });
      if (!previous || modelsChanged) {
        this.profile.measure('models', () => {
          if (previous !== undefined) this.database.statement('DELETE FROM turn_model_usage WHERE turn_id=?').run(id);
          for (const model of models) this.database.statement('INSERT INTO turn_model_usage VALUES(?,?,?,?,?,?,?,?)').run(id, ...model);
        });
      }
      if (!previous || capabilitiesChanged) {
        this.profile.measure('capabilities', () => {
          const usages = capabilities ?? [];
          if (previous !== undefined) this.database.statement('DELETE FROM turn_capability_usage WHERE turn_id=?').run(id);
          for (const usage of usages) this.database.statement('INSERT INTO turn_capability_usage VALUES(?,?,?,?)').run(id, ...usage);
        });
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
      if (!reconnected.has(id) && retainedSessions.has(sessionKey(file.provider, file.session_id))) {
        this.database.statement('UPDATE manifest SET source_missing=1,recorded_at=? WHERE id=? AND source_missing=0').run(now, id);
        continue;
      }
      this.database.statement('DELETE FROM manifest WHERE id=?').run(id);
    }
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
}
