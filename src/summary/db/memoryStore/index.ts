// 메모리 집계에서 원본 상태와 일별 합계를 한 트랜잭션으로 반영한다.
import type { SqliteSession } from '../connection';
import type { Provider, SessionRef, SourceFileRow, TurnSummaryInput } from '../types';
import { SOURCE_THREAD_ID, sourceThreadId } from '../sourceFiles';
import { StageProfiler, type StorageStage } from '../../profiling';
import type { MemoryReplacement, SavedSessionNames } from './types';

export type { MemoryReplacement, SavedSessionNames } from './types';

interface BatchReplacement extends MemoryReplacement {
  sessions: SessionRef[];
  removedFileIds: number[];
}

type ReplacementSessions = Map<string, SessionRef>;
type SourceSession = Pick<SourceFileRow, 'provider' | 'session_id' | 'thread_usage'> & { thread_id: string | Uint8Array | null };

interface PreparedReplacement {
  replacement: BatchReplacement;
  sessions: ReplacementSessions;
  summaries: Map<string, TurnSummaryInput>;
  removed: Map<number, SourceSession>;
}

interface SessionName extends SessionRef { name: string | null }

const sessionKey = (provider: unknown, session: unknown): string => JSON.stringify([provider, session]);
const threadKey = (provider: Provider, session: string, thread: string): string => JSON.stringify([provider, session, thread]);
const SESSION_KEYS = "SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)";

export class MemoryStore {
  constructor(
    private readonly database: SqliteSession,
    private readonly profile = new StageProfiler<StorageStage>(),
  ) {}

  replace(replacement: MemoryReplacement): SavedSessionNames {
    return this.replaceBatch([replacement]);
  }

  replaceBatch(replacements: readonly MemoryReplacement[]): SavedSessionNames {
    const savedNames = new Map<string, string>();
    if (!replacements.length) return savedNames;

    // [SQL 트랜잭션 정책] 모든 입력을 한 트랜잭션에 넣고 삭제나 중복 세션이 없을 때만 일괄 반영한다.
    this.profile.measure('replace', () => this.database.transaction(() => {
      const inputs: BatchReplacement[] = replacements.map(replacement => ({
        ...replacement, sessions: [...replacement.sessions], removedFileIds: [...replacement.removedFileIds ?? []],
      }));
      if (this.canCombine(inputs)) {
        this.saveSnapshots(inputs.map(replacement => this.prepare(replacement)), savedNames);
        return;
      }
      // [SQL 트랜잭션 정책] 중복 세션이나 삭제가 있으면 앞 입력이 반영된 상태에서 다음 입력을 처리한다.
      for (const replacement of inputs) this.saveSnapshots([this.prepare(replacement)], savedNames);
    }, this.profile));
    return savedNames;
  }

  private canCombine(replacements: readonly BatchReplacement[]): boolean {
    // [SQL 트랜잭션 정책] 삭제 파일이 있거나 같은 제공자·세션을 두 번 교체할 때는 순차 반영한다.
    const seen = new Set<string>();
    for (const replacement of replacements) {
      if (replacement.removedFileIds.length
        || Boolean(replacement.preserveCapabilities) !== Boolean(replacements[0].preserveCapabilities)) return false;
      for (const session of replacement.sessions) {
        const key = sessionKey(session.provider, session.session_id);
        if (seen.has(key)) return false;
        seen.add(key);
      }
    }
    return true;
  }

  private prepare(replacement: BatchReplacement): PreparedReplacement {
    // [SQL 트랜잭션 정책] 삭제 파일의 현재 귀속을 조회해 저장 대상 세션에 속하는지 확인한다.
    const { sessions, removed } = this.profile.measure('prepare', () => {
      const sessions = new Map(replacement.sessions.map(session => [sessionKey(session.provider, session.session_id), session]));
      const removed = new Map<number, SourceSession>();
      if (replacement.removedFileIds.length) {
        const select = this.database.statement(`SELECT provider,session_id,${SOURCE_THREAD_ID},thread_usage FROM source_file WHERE id=?`);
        for (const id of replacement.removedFileIds) {
          const file = select.get(id) as SourceSession | undefined;
          if (!file) continue;
          this.requireSession(file.provider, file.session_id, sessions);
          removed.set(id, file);
        }
      }
      return { sessions, removed };
    });

    // [DTO 정책] 요약을 제공자·세션·스레드 키로 색인하고 범위를 벗어나거나 중복된 요약을 거부한다.
    const summaries = this.profile.measure('indexSummaries', () => {
      const summaries = new Map<string, TurnSummaryInput>();
      for (const summary of replacement.summaries) {
        const { provider, session_id, root_turn_id } = summary;
        this.requireSession(provider, session_id, sessions);
        const key = threadKey(provider, session_id, root_turn_id);
        if (summaries.has(key)) throw new Error('Duplicate request in memory replacement');
        summaries.set(key, summary);
      }
      return summaries;
    });
    return { replacement, sessions, summaries, removed };
  }

  private saveSnapshots(plans: readonly PreparedReplacement[], savedNames: Map<string, string>): void {
    const now = new Date().toISOString();
    const summaries = plans.flatMap(plan => [...plan.summaries.values()]);
    const sessions = plans.flatMap(plan => [...plan.sessions.values()]);

    // [SQL 트랜잭션 정책] 이름과 원본 상태를 먼저 저장해 소실 여부가 일별 집계에 반영되게 한다.
    this.profile.measure('metadata', () => this.saveNames(summaries, savedNames));
    for (const plan of plans) {
      this.profile.measure('source_file', () => this.saveFiles(plan, now));
      this.profile.measure('removeSources', () => this.removeSources(plan, now));
    }
    if (!sessions.length) return;

    // [SQL 트랜잭션 정책] 같은 트랜잭션에서 대상 세션의 일별 집계를 교체하고 참조가 끊긴 이름을 정리한다.
    const scope = JSON.stringify(sessions.map(row => [row.provider, row.session_id]));
    const projects = this.database.statement(`SELECT DISTINCT project_key FROM usage_request_daily
      WHERE (provider, session_id) IN (${SESSION_KEYS})`).all(scope).map(row => row.project_key);
    const retain = plans.some(({ replacement }) => replacement.retainDeletedSourceUsage === true);
    const preserveCapabilities = plans[0].replacement.preserveCapabilities === true;
    this.profile.measure('rollups', () => this.database.rollups.replaceDaily(sessions, summaries, retain, this.profile, preserveCapabilities));
    this.profile.measure('pruneNames', () => this.pruneNames(scope, projects, savedNames));
  }

  private requireSession(provider: unknown, session: unknown, sessions: ReplacementSessions): void {
    // [저장 정책] 세션 없는 원본은 허용하고 세션이 있으면 교체 범위에 포함되어야 한다.
    if (session !== null && !sessions.has(sessionKey(provider, session))) {
      throw new Error('Source is outside the replacement session group');
    }
  }

  private saveFiles({ replacement, sessions }: PreparedReplacement, now: string): void {
    if (!replacement.files.length) return;
    // [저장 정책] 다시 읽은 원본은 파일 ID로 갱신하고 계보가 명시된 입력만 기존 계보를 덮어쓴다.
    const select = this.database.statement('SELECT provider,session_id FROM source_file WHERE id=?');
    const save = this.database.statement(`INSERT INTO source_file(id,provider,source_root,path,session_id,mtime_ms,parser_version,capabilities_collected,
        thread_id,thread_usage,source_missing,processing_status,processing_position,recorded_at,last_error)
      VALUES(?,?,?,?,?,?,?,coalesce(?,0),?,?,0,'done','committed',?,NULL)
      ON CONFLICT(id) DO UPDATE SET source_root=excluded.source_root,path=excluded.path,session_id=excluded.session_id,
        mtime_ms=excluded.mtime_ms,parser_version=excluded.parser_version,
        capabilities_collected=coalesce(?,source_file.capabilities_collected),
        thread_id=CASE WHEN ? THEN excluded.thread_id ELSE source_file.thread_id END,
        thread_usage=CASE WHEN ? THEN excluded.thread_usage ELSE source_file.thread_usage END,
        source_missing=0,
        processing_status='done',processing_position='committed',recorded_at=excluded.recorded_at,last_error=NULL`);

    // [저장 정책] 파일의 제공자 변경은 거부하고 이전·현재 세션이 모두 교체 범위에 속하는지 확인한다.
    for (const file of replacement.files) {
      const previous = select.get(file.id);
      if (previous) {
        if (previous.provider !== file.provider) throw new Error('Source provider cannot change');
        this.requireSession(previous.provider, previous.session_id, sessions);
      }
      this.requireSession(file.provider, file.session_id, sessions);
      const relations = file.relations;
      const replaceRelation = Number(relations !== undefined);
      const capabilities = file.capabilities_collected ?? null;
      save.run(file.id, file.provider, file.source_root, file.path, file.session_id, file.mtime_ms, file.parser_version,
        capabilities, relations?.identity.threadId ?? null, Number(relations?.threadUsage === true), now,
        capabilities, replaceRelation, replaceRelation);
    }
  }

  private removeSources(plan: PreparedReplacement, now: string): void {
    if (!plan.removed.size) return;
    // [저장 정책] 사용량을 유지할 세션의 파일은 소실 표시를 남기고 나머지는 파일 행을 삭제한다.
    const retained = plan.replacement.retainDeletedSourceUsage ? this.retainedSessions(plan) : new Set<string>();
    for (const [id, file] of plan.removed) {
      if (retained.has(sessionKey(file.provider, file.session_id))) {
        this.database.statement('UPDATE source_file SET source_missing=1,recorded_at=? WHERE id=? AND source_missing=0').run(now, id);
      } else {
        this.database.statement('DELETE FROM source_file WHERE id=?').run(id);
      }
    }
  }

  /** Another copy of the same thread can supply the corresponding usage again. */
  private retainedSessions({ removed, summaries, replacement }: PreparedReplacement): Set<string> {
    // [저장 정책] 스레드별 사용량이 있으면 같은 스레드의 재집계 여부를 확인하고 그 외에는 세션 단위로 판단한다.
    const retained = new Set<string>(), checked = new Set<string>();
    const liveSessions = new Set(Array.from(summaries.values(), row => sessionKey(row.provider, row.session_id)));
    const liveThreads = new Set<string>();
    for (const file of replacement.files) {
      if (file.session_id && file.relations?.threadUsage && liveSessions.has(sessionKey(file.provider, file.session_id)))
        liveThreads.add(threadKey(file.provider, file.session_id, file.relations.identity.threadId));
    }
    const hasUsage = this.database.statement(`SELECT 1 FROM usage_model_daily WHERE provider=? AND session_id=?
      AND model_key NOT IN ('N','V') AND input_tokens + output_tokens > 0 LIMIT 1`);
    for (const file of removed.values()) {
      const { provider, session_id } = file;
      if (session_id === null) continue;
      const key = sessionKey(provider, session_id);
      if (checked.has(key)) continue;
      const threadId = sourceThreadId(file.thread_id);
      const thread = threadId === undefined ? undefined : threadKey(provider, session_id, threadId);
      const live = file.thread_usage === 1 && thread !== undefined
        ? liveThreads.has(thread) || summaries.has(thread) : liveSessions.has(key);
      if (live) continue;

      // [저장 정책] 다시 집계할 수 없고 기존 일별 테이블에 모델명이 있는 양의 사용량이 남은 세션만 보존한다.
      checked.add(key);
      if (hasUsage.get(provider, session_id)) retained.add(key);
    }
    return retained;
  }

  private saveNames(summaries: readonly TurnSummaryInput[], savedNames: Map<string, string>): void {
    // [저장 정책] 프로젝트와 세션을 키별로 모으고 세션 이름은 비어 있지 않은 마지막 입력을 선택한다.
    const projects = new Map<string, string>(), sessions = new Map<string, SessionName>();
    for (const summary of summaries) {
      const { provider, session_id } = summary;
      projects.set(summary.project_key, summary.project_name);
      const key = sessionKey(provider, session_id), name = summary.session_name?.trim() || null;
      if (!sessions.has(key) || name !== null) sessions.set(key, { provider, session_id, name });
    }
    if (!sessions.size) return;

    // [저장 정책] 프로젝트 이름은 바뀐 경우만 갱신하고 빈 세션 이름은 이미 저장한 이름을 덮어쓰지 않는다.
    const project = this.database.statement(`INSERT INTO projects VALUES(?,?) ON CONFLICT(project_key) DO UPDATE SET project_name=excluded.project_name
      WHERE project_name<>excluded.project_name`);
    for (const [key, name] of projects) project.run(key, name);
    const session = this.database.statement(`INSERT INTO sessions (provider,session_id,session_name) VALUES(?,?,?)
      ON CONFLICT(provider,session_id) DO UPDATE SET session_name=excluded.session_name
      WHERE excluded.session_name IS NOT NULL AND session_name IS NOT excluded.session_name`);
    for (const [key, { provider, session_id, name }] of sessions) {
      session.run(provider, session_id, name);
      if (name !== null) savedNames.set(key, name);
    }
  }

  private pruneNames(scope: string, projects: readonly unknown[], savedNames: Map<string, string>): void {
    // [저장 정책] 교체 범위에서 일별 행이 모두 사라진 세션을 지우고 확정 이름 목록에서도 제외한다.
    const deleted = this.database.statement(`DELETE FROM sessions
      WHERE (provider, session_id) IN (${SESSION_KEYS}) AND NOT EXISTS(
        SELECT 1 FROM usage_request_daily d WHERE d.provider=sessions.provider AND d.session_id=sessions.session_id)
      RETURNING provider,session_id`).iterate(scope);
    for (const row of deleted) savedNames.delete(sessionKey(row.provider, row.session_id));
    if (!projects.length) return;

    // [저장 정책] 교체 전 집계가 참조하던 프로젝트 중 다른 일별 행에서 쓰지 않는 이름만 정리한다.
    this.database.statement(`DELETE FROM projects WHERE project_key IN (SELECT value FROM json_each(?))
      AND NOT EXISTS(SELECT 1 FROM usage_request_daily d WHERE d.project_key=projects.project_key)`).run(JSON.stringify(projects));
  }
}
