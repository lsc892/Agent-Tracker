// 전수 파싱한 요청의 의미 서명을 비교하고 확정된 집계만 다음 갱신에 재사용한다.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CapabilityUsageInput, ModelUsageInput } from './db/types';
import type { Provider } from './types';
import type { PreparedTurn } from './staging';
import { PRICING_VERSION } from './pricing';

interface TurnKey { provider: Provider; session_id: string; root_id: string }
interface ComparedTurn extends TurnKey { previous_signature: string | null; invalid: number }

/** 변경 요청과 응답·누계 의존성을 좁히고 세션 transaction에서 집계 캐시를 공개한다. */
export class SummaryMetadata {
  constructor(private readonly connection: DatabaseSync, private readonly collectCapabilities: boolean) {
    connection.exec(`CREATE TEMP TABLE metadata_turns(
      provider TEXT NOT NULL,session_id TEXT NOT NULL,root_id TEXT NOT NULL,signature TEXT,dirty INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(provider,session_id,root_id)) WITHOUT ROWID;
      CREATE TEMP TABLE metadata_dependencies(
        provider TEXT NOT NULL,session_id TEXT NOT NULL,root_id TEXT NOT NULL,dependency TEXT NOT NULL,
        PRIMARY KEY(provider,session_id,root_id,dependency)) WITHOUT ROWID;
      CREATE INDEX temp.metadata_dependency ON metadata_dependencies(provider,session_id,dependency,root_id);`);
  }

  /** 원본 전체의 현재 이벤트를 해시하고 공유 응답·누계에 연결된 변경 요청을 재귀 확장한다. */
  prepare(sessions: 'component' | 'summary_batch'): void {
    const c = this.connection;
    c.exec(`DELETE FROM metadata_turns; DELETE FROM metadata_dependencies;
      INSERT INTO metadata_turns(provider,session_id,root_id)
        SELECT f.provider,f.session_id,e.root_id FROM ${sessions} s
        JOIN scan_files f ON f.provider=s.provider AND f.session_id=s.session_id
        JOIN events e ON e.file_id=f.id WHERE f.removed=0 AND f.failed=0
        GROUP BY f.provider,f.session_id,e.root_id;
      INSERT OR IGNORE INTO metadata_turns(provider,session_id,root_id)
        SELECT m.provider,m.session_id,m.root_id FROM turn_metadata m JOIN ${sessions} s
          ON s.provider=m.provider AND s.session_id=m.session_id;
      INSERT OR IGNORE INTO metadata_turns(provider,session_id,root_id)
        SELECT t.provider,t.session_id,t.root_turn_id FROM turn_summary t JOIN ${sessions} s
          ON s.provider=t.provider AND s.session_id=t.session_id;`);
    const events = c.prepare(`SELECT json_array(e.file_id,e.kind,e.root_id,e.response_id,e.request_id,
        e.thread_id,e.turn_id,e.model,e.billing_mode,e.input,e.output,e.cache_read,e.cache_write,e.reasoning,
        e.is_main,e.started,e.completed_at,e.last_assistant,e.duration,e.duration_quality,e.completed,e.status,
        e.status_at,e.flags,e.byte_offset,e.schema_kind,e.category,e.name,e.event_key,e.request_title,
        f.is_main,f.project_key,f.project_name,f.session_name,f.thread_id,f.parent_thread_id,f.forked_from_id,
        f.parser_version) payload
      FROM scan_files f JOIN events e ON e.file_id=f.id AND e.root_id=?
      WHERE f.provider=? AND f.session_id=? AND f.removed=0 AND f.failed=0 ORDER BY e.id`);
    const flags = c.prepare(`SELECT x.file_id,x.root_id,x.flag FROM scan_files f JOIN flags x ON x.file_id=f.id
      WHERE f.provider=? AND f.session_id=? AND f.removed=0 AND f.failed=0 AND (x.root_id=? OR x.root_id='*')
      ORDER BY x.file_id,x.root_id,x.flag`);
    const main = c.prepare(`SELECT id,project_key,project_name FROM scan_files
      WHERE provider=? AND session_id=? AND is_main=1 AND removed=0 AND failed=0 ORDER BY id LIMIT 1`);
    const name = c.prepare(`SELECT session_name FROM scan_files WHERE provider=? AND session_id=? AND is_main=1
      AND removed=0 AND failed=0 AND session_name IS NOT NULL ORDER BY id DESC LIMIT 1`);
    const sources = c.prepare(`SELECT f.id FROM scan_files f WHERE f.provider=? AND f.session_id=?
      AND f.removed=0 AND f.failed=0 AND EXISTS(SELECT 1 FROM events e WHERE e.file_id=f.id)
      ORDER BY (SELECT min(e.id) FROM events e WHERE e.file_id=f.id),f.id`);
    const turns = c.prepare(`SELECT n.provider,n.session_id,n.root_id,a.signature previous_signature,
        (t.id IS NOT NULL AND (t.last_error IS NOT NULL OR a.prepared_json IS NULL)
          OR EXISTS(SELECT 1 FROM scan_files f JOIN manifest m ON m.id=f.id
            JOIN events e ON e.file_id=f.id AND e.root_id=n.root_id
            WHERE f.provider=n.provider AND f.session_id=n.session_id
              AND f.removed=0 AND f.failed=0 AND m.parser_version<>f.parser_version)) invalid
      FROM metadata_turns n LEFT JOIN turn_metadata a
        ON a.provider=n.provider AND a.session_id=n.session_id AND a.root_id=n.root_id
      LEFT JOIN turn_summary t
        ON t.provider=n.provider AND t.session_id=n.session_id AND t.root_turn_id=n.root_id
      ORDER BY n.provider,n.session_id,n.root_id`);
    const update = c.prepare('UPDATE metadata_turns SET signature=?,dirty=? WHERE provider=? AND session_id=? AND root_id=?');
    let previousSession: string | undefined;
    let sessionSignature = '';
    for (const key of turns.iterate() as unknown as Iterable<ComparedTurn>) {
      const session = JSON.stringify([key.provider,key.session_id]);
      if (session !== previousSession) {
        const sourceOrder = createHash('sha256');
        for (const source of sources.iterate(key.provider,key.session_id)) sourceOrder.update(`${source.id},`);
        // Files are parsed serially. Their relative order also breaks ties between different roots.
        sessionSignature = JSON.stringify([this.collectCapabilities,PRICING_VERSION,
          main.get(key.provider,key.session_id),name.get(key.provider,key.session_id),sourceOrder.digest('hex')]);
        previousSession = session;
      }
      const hash = createHash('sha256');
      hash.update(sessionSignature);
      let count = 0;
      for (const row of events.iterate(key.root_id,key.provider,key.session_id)) {
        // Relative order selects equal-score winners, latest lifecycle and first title; absolute IDs do not.
        hash.update(row.payload as string); count++;
      }
      if (!count) continue;
      for (const flag of flags.iterate(key.provider,key.session_id,key.root_id)) hash.update(JSON.stringify(flag));
      const signature = hash.digest('hex');
      update.run(signature,Number(key.previous_signature !== signature || key.invalid),key.provider,key.session_id,key.root_id);
    }
    if (!c.prepare('SELECT 1 FROM metadata_turns WHERE dirty=1 LIMIT 1').get()) return;
    c.exec(`INSERT OR IGNORE INTO metadata_dependencies
      SELECT f.provider,f.session_id,e.root_id,json_array('response',e.response_id)
      FROM ${sessions} s JOIN scan_files f ON f.provider=s.provider AND f.session_id=s.session_id
      JOIN events e ON e.file_id=f.id WHERE f.removed=0 AND f.failed=0 AND e.kind='usage';
      INSERT OR IGNORE INTO metadata_dependencies
      SELECT f.provider,f.session_id,e.root_id,json_array('turn',e.thread_id,e.turn_id)
      FROM ${sessions} s JOIN scan_files f ON f.provider=s.provider AND f.session_id=s.session_id
      JOIN events e ON e.file_id=f.id WHERE f.removed=0 AND f.failed=0 AND e.kind IN ('usage','check');
      INSERT OR IGNORE INTO metadata_dependencies SELECT d.* FROM turn_metadata_dependencies d
        JOIN ${sessions} s ON s.provider=d.provider AND s.session_id=d.session_id;
      WITH RECURSIVE dirty(provider,session_id,root_id) AS (
        SELECT provider,session_id,root_id FROM metadata_turns WHERE dirty=1
        UNION
        SELECT b.provider,b.session_id,b.root_id FROM dirty x
          JOIN metadata_dependencies a ON a.provider=x.provider AND a.session_id=x.session_id AND a.root_id=x.root_id
          JOIN metadata_dependencies b ON b.provider=a.provider AND b.session_id=a.session_id AND b.dependency=a.dependency
      ) UPDATE metadata_turns SET dirty=1 WHERE (provider,session_id,root_id) IN (SELECT * FROM dirty);`);
  }

  dirtyPredicate(fileAlias: string, eventAlias: string): string {
    return `EXISTS(SELECT 1 FROM metadata_turns m WHERE m.provider=${fileAlias}.provider
      AND m.session_id=${fileAlias}.session_id AND m.root_id=${eventAlias}.root_id AND m.dirty=1)`;
  }

  changedTurns(): Iterable<{provider:Provider;session_id:string;root_turn_id:string}> {
    return this.connection.prepare(`SELECT m.provider,m.session_id,m.root_id root_turn_id FROM metadata_turns m
      JOIN component c ON c.provider=m.provider AND c.session_id=m.session_id WHERE m.dirty=1`)
      .iterate() as unknown as Iterable<{provider:Provider;session_id:string;root_turn_id:string}>;
  }

  *unchangedTurns(): Generator<PreparedTurn> {
    const rows = this.connection.prepare(`SELECT a.prepared_json FROM turn_metadata a
      JOIN metadata_turns m ON m.provider=a.provider AND m.session_id=a.session_id AND m.root_id=a.root_id
      JOIN component c ON c.provider=a.provider AND c.session_id=a.session_id
      WHERE m.dirty=0 AND a.prepared_json IS NOT NULL`).iterate();
    for (const row of rows) yield JSON.parse(row.prepared_json as string) as PreparedTurn;
  }

  models(key: TurnKey): Iterable<ModelUsageInput> {
    return this.connection.prepare(`SELECT model,input_tokens,output_tokens,cache_read_input_tokens,cache_write_input_tokens
      FROM turn_metadata_models WHERE provider=? AND session_id=? AND root_id=? ORDER BY model`)
      .iterate(key.provider,key.session_id,key.root_id) as unknown as Iterable<ModelUsageInput>;
  }

  capabilities(key: TurnKey): Iterable<CapabilityUsageInput> {
    return this.connection.prepare(`SELECT category,name,usage_count FROM turn_metadata_capabilities
      WHERE provider=? AND session_id=? AND root_id=? ORDER BY category,name`)
      .iterate(key.provider,key.session_id,key.root_id) as unknown as Iterable<CapabilityUsageInput>;
  }

  /** 세션 저장 transaction 안에서만 호출해 검증·저장에 실패한 계산은 공개하지 않는다. */
  commit(): void {
    const c = this.connection;
    if (!c.prepare(`SELECT 1 FROM metadata_turns m JOIN component c
      ON c.provider=m.provider AND c.session_id=m.session_id WHERE m.dirty=1 LIMIT 1`).get()) return;
    c.exec(`DELETE FROM turn_metadata WHERE (provider,session_id,root_id) IN (
      SELECT m.provider,m.session_id,m.root_id FROM metadata_turns m
      JOIN component c ON c.provider=m.provider AND c.session_id=m.session_id WHERE m.dirty=1);`);
    const insert = c.prepare('INSERT INTO turn_metadata VALUES(?,?,?,?,?)');
    const prepared = c.prepare('SELECT * FROM prepared_turns WHERE provider=? AND session_id=? AND root_id=?');
    const rows = c.prepare(`SELECT m.* FROM metadata_turns m JOIN component c
      ON c.provider=m.provider AND c.session_id=m.session_id JOIN sessions s
      ON s.provider=m.provider AND s.session_id=m.session_id WHERE m.dirty=1 AND m.signature IS NOT NULL`).iterate();
    for (const raw of rows) {
      const key = raw as unknown as TurnKey;
      const value = prepared.get(key.provider,key.session_id,key.root_id);
      insert.run(key.provider,key.session_id,key.root_id,raw.signature as string,value ? JSON.stringify(value) : null);
    }
    const scope = `JOIN turn_metadata a ON a.provider=m.provider AND a.session_id=m.session_id AND a.root_id=m.root_id
      JOIN component c ON c.provider=m.provider AND c.session_id=m.session_id WHERE m.dirty=1`;
    c.exec(`INSERT INTO turn_metadata_models
      SELECT w.provider,w.session_id,w.root_id,coalesce(w.model,''),sum(w.input),sum(w.output),
        sum(min(w.input,w.cache_read)),sum(min(max(0,w.input-w.cache_read),w.cache_write))
      FROM winners w JOIN metadata_turns m ON m.provider=w.provider AND m.session_id=w.session_id AND m.root_id=w.root_id
      ${scope} GROUP BY w.provider,w.session_id,w.root_id,coalesce(w.model,'')
      HAVING coalesce(w.model,'')<>'' OR sum(w.input+w.output)>0;
      INSERT INTO turn_metadata_capabilities
      SELECT w.provider,w.session_id,w.root_id,w.category,w.name,count(*) FROM capability_winners w
      JOIN metadata_turns m ON m.provider=w.provider AND m.session_id=w.session_id AND m.root_id=w.root_id
      ${scope} GROUP BY w.provider,w.session_id,w.root_id,w.category,w.name;
      INSERT INTO turn_metadata_capabilities
      SELECT w.provider,w.session_id,w.root_id,'model',coalesce(w.model,''),count(*) FROM winners w
      JOIN metadata_turns m ON m.provider=w.provider AND m.session_id=w.session_id AND m.root_id=w.root_id
      ${scope} AND (coalesce(w.model,'')<>'' OR w.input+w.output>0)
      GROUP BY w.provider,w.session_id,w.root_id,coalesce(w.model,'');
      INSERT INTO turn_metadata_dependencies
      SELECT DISTINCT f.provider,f.session_id,e.root_id,json_array('response',e.response_id)
      FROM component_events e JOIN scan_files f ON f.id=e.file_id
      JOIN metadata_turns m ON m.provider=f.provider AND m.session_id=f.session_id AND m.root_id=e.root_id
      ${scope} AND e.kind='usage';
      INSERT INTO turn_metadata_dependencies
      SELECT DISTINCT f.provider,f.session_id,e.root_id,json_array('turn',e.thread_id,e.turn_id)
      FROM component_events e JOIN scan_files f ON f.id=e.file_id
      JOIN metadata_turns m ON m.provider=f.provider AND m.session_id=f.session_id AND m.root_id=e.root_id
      ${scope} AND e.kind IN ('usage','check');`);
  }

  close(): void {
    this.connection.exec('DROP TABLE temp.metadata_dependencies; DROP TABLE temp.metadata_turns;');
  }
}
