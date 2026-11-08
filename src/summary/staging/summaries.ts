// 연결 성분의 SQL 집계 준비와 최종 저장 DTO 변환을 담당한다.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { TurnSummaryInput, ModelUsageInput, CapabilityUsageInput } from '../db/types';
import type { Provider } from '../types';
import { SummaryMetadata } from '../metadata';
import { CONNECTED_SESSIONS } from './components';
import type { PreparedTurn } from './types';

/** 명시 시간·완료 수명·마지막 응답 순서로 원래 요청 시간 품질을 선택한다. */
function summaryTiming(row: PreparedTurn): {
  status: TurnSummaryInput['status']; completedAt: number | null;
  duration: number | null; quality: TurnSummaryInput['duration_quality'];
} {
  const status = row.latest_status ?? (row.completed ? 'completed' : 'in_progress');
  let completedAt: number | null = null;
  if (status !== 'in_progress') completedAt = row.latest_status !== null ? row.latest_status_at : row.completed_at;
  if (status !== 'in_progress' && row.explicit_duration !== null) {
    return { status, completedAt, duration: row.explicit_duration, quality: 'exact' };
  }
  if (row.started !== null && completedAt !== null && completedAt >= row.started) {
    const lifecycle = row.latest_status !== null ? row.latest_status_quality === 'derived' : row.lifecycle;
    return {
      status, completedAt, duration: completedAt - row.started,
      quality: status === 'completed' && lifecycle ? 'derived' : 'approximate'
    };
  }
  if (status === 'completed' && row.started !== null && row.last_assistant !== null && row.last_assistant >= row.started) {
    return { status, completedAt, duration: row.last_assistant - row.started, quality: 'approximate' };
  }
  return { status, completedAt, duration: null, quality: 'missing' };
}

/** 재사용할 집계 TEMP 수명과 요청 페이지 변환을 소유한다. */
export class StagingSummaries {
  private preparedTablesCreated = false;
  private summaryBatchCreated = false;

  /** 같은 연결의 metadata·이벤트 적재 경계를 받아 집계 수명을 조율한다. */
  constructor(private readonly connection: DatabaseSync, private readonly collectCapabilities: boolean,
    private readonly metadata: SummaryMetadata, private readonly loadEvents: () => void) { }

  /** 현재 성분이 준비된 묶음에 있으면 재사용하고 앞 32개 seed의 정상 성분을 함께 준비한다. */
  prepareSummaries(): void {
    if (this.hasPreparedComponent()) return;
    const seeds = this.additionalSeeds();
    if (!seeds.length) {
      this.prepareCurrentComponent();
      return;
    }
    this.expandSummaryBatch(seeds);
    this.prepareSummaryTables('summary_batch');
  }

  /** 현재 성분이 이미 준비한 묶음에 포함될 때만 SQL 집계를 재사용한다. */
  private hasPreparedComponent(): boolean {
    if (!this.summaryBatchCreated) return false;
    return !this.connection.prepare(`SELECT 1 FROM component c WHERE NOT EXISTS(
      SELECT 1 FROM summary_batch b WHERE b.provider=c.provider AND b.session_id=c.session_id) LIMIT 1`).get();
  }

  /** 앞 32개 영향 세션에서 현재 성분 바깥의 추가 seed를 원래 순서로 읽는다. */
  private additionalSeeds(): { provider: Provider; session_id: string }[] {
    return this.connection.prepare(`SELECT a.provider,a.session_id FROM (
        SELECT provider,session_id FROM affected ORDER BY provider,session_id LIMIT 32
      ) a WHERE NOT EXISTS(SELECT 1 FROM component c WHERE c.provider=a.provider AND c.session_id=a.session_id)`)
      .all() as { provider: Provider; session_id: string }[];
  }

  /** 추가 seed가 없으면 이전 묶음만 비우고 현재 연결 성분을 직접 준비한다. */
  private prepareCurrentComponent(): void {
    if (this.summaryBatchCreated) this.connection.exec('DELETE FROM summary_batch');
    this.prepareSummaryTables('component');
  }

  /** 현재 성분과 실패하지 않은 추가 성분을 TEMP 묶음에 중복 없이 확장한다. */
  private expandSummaryBatch(seeds: { provider: Provider; session_id: string }[]): void {
    if (!this.summaryBatchCreated) {
      this.connection.exec(`CREATE TEMP TABLE summary_batch(
        provider TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(provider,session_id)) WITHOUT ROWID`);
      this.summaryBatchCreated = true;
    }
    this.connection.exec('DELETE FROM summary_batch; INSERT INTO summary_batch SELECT * FROM component');
    const contains = this.connection.prepare('SELECT 1 FROM summary_batch WHERE provider=? AND session_id=?');
    const addComponent = this.connection.prepare(`${CONNECTED_SESSIONS}
      INSERT OR IGNORE INTO summary_batch SELECT ?,session_id FROM connected WHERE NOT EXISTS(
        SELECT 1 FROM scan_files f JOIN connected c ON f.session_id=c.session_id OR f.old_session=c.session_id
        WHERE f.provider=? AND f.failed=1)`);
    for (const seed of seeds) {
      if (contains.get(seed.provider, seed.session_id)) continue;
      addComponent.run(seed.session_id, seed.provider, seed.provider, seed.provider);
    }
  }

  /** 이벤트를 적재하고 변경 요청·winner·최종 요청 TEMP 집계를 기존 SQL 한 번으로 준비한다. */
  private prepareSummaryTables(sessions: 'component' | 'summary_batch'): void {
    this.loadEvents();
    this.metadata.prepare(sessions);
    // TEMP 스키마 변경은 저장 SQL도 무효화하므로 다음 묶음은 표를 유지하고 행만 교체한다.
    const populate = (table: string): string => this.preparedTablesCreated
      ? `DELETE FROM ${table}; INSERT INTO ${table}`
      : `CREATE TEMP TABLE ${table} AS`;
    this.connection.exec(`${componentInputSql(sessions, populate, this.metadata.dirtyPredicate('f', 'e'))}${winnerSql(populate)}${preparedTurnSql(populate)}`);
    this.preparedTablesCreated = true;
  }

  /** 준비 요청을 100행씩 읽어 시간·품질·모델·Skill을 저장 DTO로 변환한다. */
  *summaries(includeUnchanged = false): Generator<TurnSummaryInput> {
    const scope = this.summaryBatchCreated
      ? 'AND (provider,session_id) IN (SELECT provider,session_id FROM component)' : '';
    const sessionName = this.connection.prepare(`SELECT coalesce(
        (SELECT session_name FROM session_names WHERE provider=? AND session_id=?),
        (SELECT session_name FROM scan_files WHERE provider=? AND session_id=? AND is_main=1
          AND removed=0 AND failed=0 AND session_name IS NOT NULL ORDER BY id DESC LIMIT 1)) AS name`);
    yield* this.preparedSummaries(scope, sessionName);
    if (!includeUnchanged) return;
    for (const row of this.metadata.unchangedTurns()) {
      yield this.materializeSummary(row, sessionName, 'cached');
    }
  }

  /** 준비된 요청을 rowid 순서로 100행씩 읽고 현재 연결 성분의 저장 DTO를 반환한다. */
  private *preparedSummaries(scope: string, sessionName: StatementSync): Generator<TurnSummaryInput> {
    let after = 0;
    while (true) {
      const rows = this.connection.prepare(`SELECT rowid AS cursor,* FROM prepared_turns WHERE rowid>? ${scope} ORDER BY rowid LIMIT 100`).all(after);
      if (!rows.length) return;
      for (const raw of rows) {
        const row = raw as unknown as PreparedTurn;
        after = row.cursor;
        yield this.materializeSummary(row, sessionName, 'prepared');
      }
    }
  }

  /** 요청 시간·품질·이름을 조립하고 준비 입력 또는 확정 캐시의 모델·Skill을 연결한다. */
  private materializeSummary(row: PreparedTurn, sessionName: StatementSync, origin: 'prepared' | 'cached'): TurnSummaryInput {
    const { status, completedAt, duration, quality } = summaryTiming(row);
    const flags = this.summaryFlags(row, quality, origin);
    const name = sessionName.get(row.provider, row.session_id, row.provider, row.session_id)?.name as string | null;
    return {
      provider: row.provider, project_key: row.project_key, project_name: row.project_name,
      session_id: row.session_id, session_name: name, root_turn_id: row.root_id, request_title: row.request_title,
      started_at_ms: row.started, completed_at_ms: completedAt, duration_ms: duration, duration_quality: quality,
      input_tokens: row.input_tokens, output_tokens: row.output_tokens,
      cache_read_input_tokens: row.cache_read_input_tokens, cache_write_input_tokens: row.cache_write_input_tokens,
      model_usage: origin === 'cached' ? this.metadata.models(row) : this.modelUsage(row.provider, row.session_id, row.root_id),
      capability_usage: this.capabilitiesFor(row, origin),
      billing: row.billing, total_tokens: row.input_tokens + row.output_tokens, status,
      quality_flags: [...flags].join(',') || null,
      diagnostic_file_id: flags.size ? row.file_id : null, diagnostic_offset: flags.size ? row.byte_offset : null,
    };
  }

  /** 시간 품질 경고를 순서대로 붙이고 새 집계의 메인 원본 누락도 표시한다. */
  private summaryFlags(row: PreparedTurn, quality: TurnSummaryInput['duration_quality'], origin: 'prepared' | 'cached'): Set<string> {
    const flags = new Set((row.flags ?? '').split(',').filter(Boolean));
    if (quality === 'missing') flags.add('duration-missing');
    if (quality === 'approximate') flags.add('duration-approximate');
    if (origin === 'prepared' && !row.has_main) flags.add('missing-root-turn');
    return flags;
  }

  /** Skill 수집이 켜졌을 때만 새 집계나 확정 캐시의 횟수 내역을 선택한다. */
  private capabilitiesFor(row: PreparedTurn, origin: 'prepared' | 'cached'): Iterable<CapabilityUsageInput> | undefined {
    if (!this.collectCapabilities) return undefined;
    if (origin === 'cached') return this.metadata.capabilities(row);
    return this.capabilityUsage(row.provider, row.session_id, row.root_id);
  }

  /** 요청의 모델별 승자 토큰을 합산하고 캐시 포함 관계를 정규화한다. */
  private *modelUsage(provider: Provider, session: string, root: string): Generator<ModelUsageInput> {
    for (const row of this.connection.prepare(`SELECT coalesce(model,'') AS model,
        sum(input) AS input_tokens,sum(output) AS output_tokens,
        sum(min(input,cache_read)) AS cache_read_input_tokens,
        sum(min(max(0,input-cache_read),cache_write)) AS cache_write_input_tokens
        FROM winners WHERE provider=? AND session_id=? AND root_id=? GROUP BY coalesce(model,'')
        HAVING coalesce(model,'')<>'' OR sum(input+output)>0`)
      .iterate(provider, session, root)) yield row as unknown as ModelUsageInput;
  }

  /** 요청의 중복 제거된 도구·모델 사용 횟수를 분류·이름별로 합산한다. */
  private *capabilityUsage(provider: Provider, session: string, root: string): Generator<CapabilityUsageInput> {
    for (const row of this.connection.prepare(`SELECT category,name,count(*) AS usage_count FROM capability_winners
        WHERE provider=? AND session_id=? AND root_id=? GROUP BY category,name
        UNION ALL SELECT 'model',coalesce(model,''),count(*) FROM winners
        WHERE provider=? AND session_id=? AND root_id=? AND (coalesce(model,'')<>'' OR input+output>0)
        GROUP BY coalesce(model,'')`)
      .iterate(provider, session, root, provider, session, root)) yield row as unknown as CapabilityUsageInput;
  }
}


type TablePopulation = (table: string) => string;

/** 관련 파일의 변경 이벤트만 골라 집계 입력과 조회 인덱스를 구성한다. */
function componentInputSql(sessions: 'component' | 'summary_batch', populate: TablePopulation, dirtyPredicate: string): string {
  return `
      ${populate('component_events')} SELECT e.* FROM ${sessions} c
        CROSS JOIN scan_files f ON f.provider=c.provider AND f.session_id=c.session_id
        CROSS JOIN events e ON e.file_id=f.id WHERE f.removed=0 AND f.failed=0 AND ${dirtyPredicate};
      CREATE INDEX IF NOT EXISTS temp.component_events_response ON component_events(kind,response_id,request_id);
      CREATE INDEX IF NOT EXISTS temp.component_events_turn ON component_events(kind,thread_id,turn_id,id);
      CREATE INDEX IF NOT EXISTS temp.component_request_title ON component_events(root_id,id)
        WHERE is_main=1 AND request_title IS NOT NULL;
      `;
}

/** 선택된 응답·도구 승자와 누락 요청·누계 불일치 경고의 SQL을 구성한다. */
function winnerSql(populate: TablePopulation): string {
  return `${populate('winners')}
      SELECT e.*,f.provider,f.session_id,1 rank FROM component_events e
        JOIN scan_files f ON f.id=e.file_id WHERE e.kind='usage';
      CREATE INDEX IF NOT EXISTS temp.winners_root ON winners(provider,session_id,root_id);
      CREATE INDEX IF NOT EXISTS temp.winners_turn ON winners(provider,session_id,thread_id,turn_id);
      ${populate('capability_winners')}
        SELECT f.provider,f.session_id,e.root_id,e.thread_id,e.event_key,e.category,e.name
        FROM component_events e JOIN scan_files f ON f.id=e.file_id WHERE e.kind='capability';
      CREATE INDEX IF NOT EXISTS temp.capability_winners_root ON capability_winners(provider,session_id,root_id);
      INSERT OR IGNORE INTO flags SELECT file_id,root_id,'missing-request-id' FROM winners
        WHERE provider='claude' AND canonical_request IS NULL;
      INSERT OR IGNORE INTO flags SELECT e.file_id,e.root_id,'token-total-mismatch'
        FROM component_events e JOIN scan_files f ON f.id=e.file_id
        WHERE e.kind='check' AND e.id=(SELECT max(x.id) FROM component_events x JOIN scan_files y ON y.id=x.file_id
          WHERE x.kind='check' AND y.provider=f.provider AND y.session_id=f.session_id AND x.thread_id=e.thread_id AND x.turn_id=e.turn_id)
          AND (e.input<>coalesce((SELECT sum(w.input) FROM winners w WHERE w.provider=f.provider AND w.session_id=f.session_id AND w.thread_id=e.thread_id AND w.turn_id=e.turn_id),0)
            OR e.output<>coalesce((SELECT sum(w.output) FROM winners w WHERE w.provider=f.provider AND w.session_id=f.session_id AND w.thread_id=e.thread_id AND w.turn_id=e.turn_id),0));
      `;
}

/** 원본별 최종 상태와 요청별 토큰·시간·제목·품질 경고를 집계하는 SQL을 구성한다. */
function preparedTurnSql(populate: TablePopulation): string {
  return `${populate('prepared_turns')}
      WITH source_outcomes AS (
        SELECT f.provider,f.session_id,e.root_id,e.status,e.status_at,e.duration_quality,e.id,
          max(e.status_at) OVER(PARTITION BY e.file_id,e.root_id) ordering_at,
          row_number() OVER(PARTITION BY e.file_id,e.root_id ORDER BY e.id DESC) source_rank
        FROM component_events e JOIN scan_files f ON f.id=e.file_id
        WHERE e.is_main=1 AND e.status IS NOT NULL
      ), outcomes AS (
        SELECT *,row_number() OVER(PARTITION BY provider,session_id,root_id ORDER BY ordering_at DESC,id DESC) rank
        FROM source_outcomes WHERE source_rank=1
      ), roots AS (
        SELECT f.provider,f.session_id,e.root_id,min(CASE WHEN e.is_main=1 THEN e.started END) started,
          max(CASE WHEN e.is_main=1 AND e.completed=1 THEN e.completed_at END) completed_at,
          max(CASE WHEN e.is_main=1 THEN e.last_assistant END) last_assistant,
          max(CASE WHEN e.is_main=1 THEN e.completed ELSE 0 END) completed,
          max(CASE WHEN e.is_main=1 AND e.duration_quality='exact' THEN e.duration END) explicit_duration,
          max(CASE WHEN e.is_main=1 AND e.duration_quality='derived' AND e.completed=1 THEN 1 ELSE 0 END) lifecycle,
          min(f.id) file_id,min(e.byte_offset) byte_offset,
          max(CASE WHEN f.is_main=1 THEN 1 ELSE 0 END) has_main
        FROM component_events e JOIN scan_files f ON f.id=e.file_id
        WHERE f.failed=0 AND f.removed=0 GROUP BY f.provider,f.session_id,e.root_id
      ) SELECT r.*,o.status latest_status,o.status_at latest_status_at,o.duration_quality latest_status_quality,f.project_key,f.project_name,
        (SELECT e.request_title FROM component_events e JOIN scan_files sf ON sf.id=e.file_id
          WHERE sf.provider=r.provider AND sf.session_id=r.session_id AND e.root_id=r.root_id
            AND e.is_main=1 AND e.request_title IS NOT NULL ORDER BY e.id LIMIT 1) request_title,
        (SELECT CASE WHEN count(DISTINCT w.billing_mode)=1 THEN min(w.billing_mode) ELSE 'unknown' END
          FROM winners w WHERE w.provider=r.provider AND w.session_id=r.session_id AND w.root_id=r.root_id) billing,
        coalesce((SELECT sum(w.input) FROM winners w WHERE w.provider=r.provider AND w.session_id=r.session_id AND w.root_id=r.root_id),0) input_tokens,
        coalesce((SELECT sum(w.output) FROM winners w WHERE w.provider=r.provider AND w.session_id=r.session_id AND w.root_id=r.root_id),0) output_tokens,
        coalesce((SELECT sum(min(w.input,w.cache_read)) FROM winners w WHERE w.provider=r.provider AND w.session_id=r.session_id AND w.root_id=r.root_id),0) cache_read_input_tokens,
        coalesce((SELECT sum(min(max(0,w.input-w.cache_read),w.cache_write)) FROM winners w WHERE w.provider=r.provider AND w.session_id=r.session_id AND w.root_id=r.root_id),0) cache_write_input_tokens,
        (SELECT group_concat(DISTINCT x.flag) FROM flags x JOIN scan_files sf ON sf.id=x.file_id
          WHERE sf.provider=r.provider AND sf.session_id=r.session_id AND (x.root_id=r.root_id OR x.root_id='*')) flags
      FROM roots r JOIN scan_files f ON f.id=coalesce(
        (SELECT sf.id FROM scan_files sf WHERE sf.provider=r.provider AND sf.session_id=r.session_id AND sf.is_main=1 AND sf.removed=0 ORDER BY sf.id LIMIT 1),r.file_id)
      LEFT JOIN outcomes o ON o.provider=r.provider AND o.session_id=r.session_id AND o.root_id=r.root_id AND o.rank=1
      WHERE o.status IS NULL OR o.status<>'aborted';
      CREATE UNIQUE INDEX IF NOT EXISTS temp.prepared_turns_key ON prepared_turns(provider,session_id,root_id);
    `;
}
