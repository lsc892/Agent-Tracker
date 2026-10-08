import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { FileMetadata, TurnSummaryInput, ModelUsageInput, CapabilityUsageInput } from './db/types';
import type { ParsedIdentity, ParseEvent, Provider } from './types';

export interface StagedFile extends FileMetadata {
  id: number;
  old_session: string | null;
  changed: number;
  parsed: number;
  removed: number;
  failed: number;
  project_key: string | null;
  project_name: string | null;
  session_name: string | null;
  thread_id: string | null;
  parent_thread_id: string | null;
  is_main: number;
  forked_from_id: string | null;
}

/** All corpus-sized work lives in SQLite's file-backed TEMP store. */
export class SummaryStaging {
  private readonly insertEvent: StatementSync;
  private readonly insertFlag: StatementSync;
  private readonly insertAffected: StatementSync;
  constructor(readonly connection: DatabaseSync, private readonly collectCapabilities = true) {
    connection.exec(`
      CREATE TEMP TABLE scan_files (
        id INTEGER PRIMARY KEY, provider TEXT NOT NULL, source_root TEXT NOT NULL, path TEXT NOT NULL,
        session_id TEXT, old_session TEXT, size_bytes INTEGER NOT NULL, mtime_ms REAL NOT NULL,
        dev TEXT, inode TEXT, parser_version INTEGER NOT NULL, capabilities_collected INTEGER NOT NULL, changed INTEGER NOT NULL,
        parsed INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
        settled INTEGER NOT NULL DEFAULT 0,
        project_key TEXT, project_name TEXT, session_name TEXT, thread_id TEXT, parent_thread_id TEXT, forked_from_id TEXT, is_main INTEGER DEFAULT 1
      );
      CREATE INDEX temp.scan_session ON scan_files(provider,session_id,id);
      CREATE INDEX temp.scan_old_session ON scan_files(provider,old_session,id);
      CREATE INDEX temp.scan_thread ON scan_files(provider,thread_id);
      CREATE TEMP TABLE affected(provider TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(provider,session_id));
      CREATE TEMP TABLE links(provider TEXT NOT NULL, a TEXT NOT NULL,b TEXT NOT NULL, PRIMARY KEY(provider,a,b));
      CREATE TEMP TABLE component(provider TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(provider,session_id));
      CREATE TEMP TABLE session_names(provider TEXT NOT NULL,session_id TEXT NOT NULL,session_name TEXT NOT NULL,
        priority INTEGER NOT NULL,PRIMARY KEY(provider,session_id)) WITHOUT ROWID;
      CREATE TEMP TABLE events (
        id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, kind TEXT NOT NULL, root_id TEXT NOT NULL,
        response_id TEXT, request_id TEXT, thread_id TEXT, turn_id TEXT, model TEXT, billing_mode TEXT,
        input INTEGER,output INTEGER,cache_read INTEGER,cache_write INTEGER,reasoning INTEGER,
        is_main INTEGER,started INTEGER,completed_at INTEGER,last_assistant INTEGER,duration INTEGER,
        duration_quality TEXT,completed INTEGER,status TEXT,status_at INTEGER,flags TEXT,byte_offset INTEGER NOT NULL,schema_kind TEXT,
        category TEXT,name TEXT,event_key TEXT,request_title TEXT
      );
      CREATE INDEX temp.events_file ON events(file_id,id);
      CREATE INDEX temp.events_file_root ON events(file_id,root_id,kind);
      CREATE INDEX temp.events_response ON events(kind,response_id,request_id,file_id);
      CREATE INDEX temp.events_turn ON events(kind,thread_id,turn_id,id);
      CREATE TEMP TABLE flags(file_id INTEGER NOT NULL,root_id TEXT NOT NULL,flag TEXT NOT NULL,
        PRIMARY KEY(file_id,root_id,flag));
    `);
    this.insertEvent = connection.prepare(`INSERT INTO events(file_id,kind,root_id,response_id,request_id,thread_id,turn_id,
      input,output,cache_read,cache_write,reasoning,is_main,started,completed_at,last_assistant,duration,duration_quality,completed,status,status_at,flags,byte_offset,schema_kind,model,billing_mode,category,name,event_key,
      request_title) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.insertFlag = connection.prepare('INSERT OR IGNORE INTO flags VALUES (?,?,?)');
    this.insertAffected = connection.prepare('INSERT OR IGNORE INTO affected VALUES (?,?)');
  }

  addFile(file: FileMetadata & { id: number }, oldSession: string | null, changed: boolean, removed = false): void {
    this.connection.prepare(`INSERT OR REPLACE INTO scan_files
      (id,provider,source_root,path,session_id,old_session,size_bytes,mtime_ms,dev,inode,parser_version,capabilities_collected,changed,removed)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(file.id,file.provider,file.source_root,file.path,file.session_id,oldSession,
      file.size_bytes,file.mtime_ms,file.dev,file.inode,file.parser_version,Number(this.collectCapabilities),Number(changed),Number(removed));
    if (changed && oldSession) this.affect(file.provider,oldSession);
  }
  affect(provider: Provider, session: string): void {
    this.insertAffected.run(provider,session);
  }
  identity(fileId: number, identity: ParsedIdentity): void {
    const previous = this.connection.prepare('SELECT * FROM scan_files WHERE id=?').get(fileId) as unknown as StagedFile;
    this.connection.prepare(`UPDATE scan_files SET session_id=?,project_key=?,project_name=?,session_name=?,thread_id=?,parent_thread_id=?,forked_from_id=?,is_main=?,parsed=1 WHERE id=?`)
      .run(identity.sessionId,identity.projectKey,identity.projectName,identity.sessionName ?? null,identity.threadId,identity.parentThreadId,identity.forkedFromId ?? null,Number(identity.isMain),fileId);
    if (identity.standaloneSubagent) {
      this.connection.prepare("UPDATE events SET is_main=1 WHERE file_id=? AND kind='turn'").run(fileId);
      this.flag(fileId,'*','standalone-subagent');
    }
    this.affect(previous.provider,identity.sessionId);
    if (previous.old_session && previous.old_session !== identity.sessionId) {
      this.connection.prepare('INSERT OR IGNORE INTO links VALUES (?,?,?)').run(previous.provider,previous.old_session,identity.sessionId);
    }
  }
  event(fileId: number, event: ParseEvent): void {
    const usage = event.kind === 'usage' || event.kind === 'check' ? event : undefined;
    const turn = event.kind === 'turn' ? event : undefined;
    const capability = event.kind === 'capability' ? event : undefined;
    this.insertEvent.run(fileId,event.kind,event.rootId,
      event.kind === 'usage' ? event.responseId : null,event.kind === 'usage' ? event.requestId : null,
      usage?.threadId ?? capability?.threadId ?? null,usage?.turnId ?? null,usage?.tokens.input ?? null,usage?.tokens.output ?? null,
      usage?.tokens.cacheRead ?? null,usage?.tokens.cacheWrite ?? null,usage?.tokens.reasoning ?? null,
      turn ? Number(turn.isMain) : null,turn?.startedAt ?? null,turn?.completedAt ?? null,turn?.lastAssistantAt ?? null,
      turn?.duration ?? null,turn?.durationQuality ?? null,turn?.completed ? 1 : 0,
      turn?.status ?? null,turn?.statusAt ?? null,null,event.offset,event.kind === 'usage' ? event.schema ?? null : null,
      event.kind === 'usage' ? event.model ?? '' : null,event.kind === 'usage' ? event.billingMode ?? 'unknown' : null,
      capability?.category ?? null,capability?.name ?? null,capability?.eventId ?? null,turn?.title ?? null);
    if ('flags' in event) for (const flag of event.flags ?? []) this.flag(fileId,event.rootId,flag);
  }
  /** A bounded synchronous TEMP-only transaction; persistent tables and file I/O stay outside. */
  batchEvents(parseRows: () => void): void {
    this.connection.exec('BEGIN DEFERRED');
    try { parseRows();this.connection.exec('COMMIT'); }
    catch (error) { this.connection.exec('ROLLBACK');throw error; }
  }
  flag(fileId: number, root: string, flag: string): void {
    this.insertFlag.run(fileId,root,flag);
  }
  fail(fileId: number): void { this.connection.prepare('UPDATE scan_files SET failed=1 WHERE id=?').run(fileId); }

  *files(sql: string, parameters: (string | number)[] = []): Generator<StagedFile> {
    let after = 0;
    while (true) {
      const rows = this.connection.prepare(`SELECT * FROM scan_files WHERE id>? AND (${sql}) ORDER BY id LIMIT 100`)
        .all(after,...parameters) as unknown as StagedFile[];
      if (!rows.length) return;
      for (const row of rows) { after = row.id; yield row; }
    }
  }

  nextComponent(): boolean {
    this.connection.exec('DELETE FROM component');
    const first = this.connection.prepare('SELECT provider,session_id FROM affected ORDER BY provider,session_id LIMIT 1').get() as {provider:string;session_id:string}|undefined;
    if (!first) return false;
    this.connection.prepare(`INSERT INTO component WITH RECURSIVE connected(session_id) AS (
      SELECT ? UNION SELECT CASE WHEN links.a=connected.session_id THEN links.b ELSE links.a END
      FROM links JOIN connected ON links.a=connected.session_id OR links.b=connected.session_id WHERE links.provider=?
    ) SELECT ?,session_id FROM connected`).run(first.session_id,first.provider,first.provider);
    return true;
  }
  finishComponent(): void {
    this.connection.exec(`UPDATE scan_files SET settled=1 WHERE EXISTS(SELECT 1 FROM component c
        WHERE c.provider=scan_files.provider AND (c.session_id=scan_files.session_id OR c.session_id=scan_files.old_session));
      DELETE FROM events WHERE file_id IN(SELECT f.id FROM scan_files f JOIN component c
        ON c.provider=f.provider AND (c.session_id=f.session_id OR c.session_id=f.old_session));
      DELETE FROM flags WHERE file_id IN(SELECT f.id FROM scan_files f JOIN component c
        ON c.provider=f.provider AND (c.session_id=f.session_id OR c.session_id=f.old_session));
      DELETE FROM affected WHERE EXISTS(SELECT 1 FROM component c WHERE c.provider=affected.provider AND c.session_id=affected.session_id)`);
  }
  componentFailed(): boolean {
    return Boolean(this.connection.prepare(`SELECT 1 FROM scan_files f JOIN component c ON c.provider=f.provider
      AND (c.session_id=f.session_id OR c.session_id=f.old_session) WHERE f.failed=1 LIMIT 1`).get());
  }
  componentSessions(): Iterable<{provider:Provider;session_id:string}> {
    return this.connection.prepare('SELECT provider,session_id FROM component').iterate() as unknown as Iterable<{provider:Provider;session_id:string}>;
  }

  /** Resolve descendant thread trees on disk, after provider metadata has been parsed. */
  resolveLineage(): void {
    for (let pass = 0; pass < 128; pass++) {
      this.connection.exec(`DROP TABLE IF EXISTS temp.lineage;
        CREATE TEMP TABLE lineage AS SELECT f.id,f.provider,f.session_id previous,min(p.session_id) target
        FROM scan_files f JOIN scan_files p ON p.provider=f.provider AND p.thread_id=f.parent_thread_id
        WHERE f.provider='codex' AND f.removed=0 AND p.removed=0 AND p.failed=0 AND p.parsed=1
        GROUP BY f.id HAVING count(DISTINCT p.session_id)=1 AND target<>f.session_id;
        INSERT OR IGNORE INTO affected SELECT provider,target FROM lineage;
        INSERT OR IGNORE INTO affected SELECT provider,previous FROM lineage;
        INSERT OR IGNORE INTO links SELECT provider,previous,target FROM lineage;
        UPDATE scan_files SET session_id=(SELECT target FROM lineage WHERE lineage.id=scan_files.id)
          WHERE id IN (SELECT id FROM lineage);`);
      const changed = this.connection.prepare('SELECT count(*) count FROM lineage').get() as {count:number};
      if (!changed.count) break;
      if (pass === 127) {
        this.connection.exec(`INSERT OR IGNORE INTO flags SELECT id,'*','missing-parent-agent' FROM scan_files WHERE parent_thread_id IS NOT NULL`);
      }
    }
    this.connection.exec(`DROP TABLE IF EXISTS temp.lineage;
      DELETE FROM events WHERE schema_kind='legacy' AND file_id IN (SELECT file_id FROM events WHERE schema_kind='current');
      INSERT OR IGNORE INTO flags SELECT f.id,'*','missing-parent-agent' FROM scan_files f
        WHERE f.provider='codex' AND f.parent_thread_id IS NOT NULL AND f.parsed=1
        AND NOT EXISTS(SELECT 1 FROM scan_files p WHERE p.provider=f.provider AND p.thread_id=f.parent_thread_id AND p.parsed=1 AND p.removed=0);`);
  }

  /** Only identical, ordered legacy events from a referenced parent constitute an inherited prefix. */
  excludeVerifiedPrefixes(): void {
    this.connection.exec('CREATE TEMP TABLE IF NOT EXISTS inherited(event_id INTEGER PRIMARY KEY,parent_event_id INTEGER NOT NULL); DELETE FROM inherited;');
    for (const file of this.files("provider='codex' AND parsed=1 AND removed=0 AND failed=0 AND (forked_from_id IS NOT NULL OR parent_thread_id IS NOT NULL)")) {
      const parent = this.connection.prepare(`SELECT id FROM scan_files WHERE provider='codex' AND thread_id=?
        AND parsed=1 AND removed=0 AND failed=0 AND id<>? ORDER BY id LIMIT 1`).get(file.forked_from_id ?? file.parent_thread_id,file.id) as {id:number}|undefined;
      if (!parent) continue;
      const parentRows = this.connection.prepare("SELECT * FROM events WHERE file_id=? AND schema_kind='legacy' ORDER BY id").iterate(parent.id);
      const childRows = this.connection.prepare("SELECT * FROM events WHERE file_id=? AND schema_kind='legacy' ORDER BY id").iterate(file.id);
      try {
        for (const child of childRows) {
          const next = parentRows.next();
          if (next.done) break;
          const same = ['root_id','turn_id','response_id','input','output','cache_read','cache_write','reasoning'].every(key => child[key] === next.value[key]);
          if (!same) break;
          this.connection.prepare('INSERT OR IGNORE INTO inherited VALUES (?,?)').run(child.id,next.value.id);
        }
      } finally { parentRows.return?.(); childRows.return?.(); }
      this.connection.prepare("DELETE FROM flags WHERE file_id=? AND flag='missing-parent'").run(file.id);
    }
    if (!this.connection.prepare('SELECT 1 FROM inherited LIMIT 1').get()) {
      this.connection.exec('DROP TABLE inherited');
      return;
    }
    this.connection.exec(`DELETE FROM events AS child WHERE child.kind='capability' AND EXISTS(
        SELECT 1 FROM inherited i JOIN events inherited_child ON inherited_child.id=i.event_id
        JOIN events inherited_parent ON inherited_parent.id=i.parent_event_id
        JOIN events parent ON parent.file_id=inherited_parent.file_id
        WHERE inherited_child.file_id=child.file_id AND child.id<=inherited_child.id
          AND parent.kind='capability' AND parent.id<=inherited_parent.id
          AND parent.root_id=child.root_id AND parent.event_key=child.event_key
          AND parent.category=child.category AND parent.name=child.name);
      CREATE TEMP TABLE inherited_roots AS
        SELECT DISTINCT e.file_id,e.root_id FROM events e JOIN inherited i ON i.event_id=e.id
        WHERE NOT EXISTS(SELECT 1 FROM events remaining WHERE remaining.file_id=e.file_id AND remaining.root_id=e.root_id
          AND remaining.kind='usage' AND remaining.id NOT IN(SELECT event_id FROM inherited));
      DELETE FROM events WHERE id IN(SELECT event_id FROM inherited) OR (kind<>'capability' AND EXISTS(
        SELECT 1 FROM inherited_roots r WHERE r.file_id=events.file_id AND r.root_id=events.root_id));
      DROP TABLE inherited_roots; DROP TABLE inherited;`);
  }

  /** Window functions select whole response vectors, never independent component maxima. */
  prepareSummaries(): void {
    this.connection.exec(`
      DROP TABLE IF EXISTS temp.component_events;
      CREATE TEMP TABLE component_events AS SELECT e.* FROM component c
        CROSS JOIN scan_files f ON f.provider=c.provider AND f.session_id=c.session_id
        CROSS JOIN events e ON e.file_id=f.id WHERE f.removed=0 AND f.failed=0;
      CREATE INDEX temp.component_events_response ON component_events(kind,response_id,request_id);
      CREATE INDEX temp.component_events_turn ON component_events(kind,thread_id,turn_id,id);
      DROP TABLE IF EXISTS temp.winners;
      CREATE TEMP TABLE winners AS
      WITH candidates AS (
        SELECT e.*,f.provider,f.session_id,
          CASE WHEN f.provider='claude' AND e.request_id IS NULL THEN
            (SELECT CASE WHEN count(DISTINCT e2.request_id)=1 THEN min(e2.request_id) ELSE NULL END
             FROM component_events e2 JOIN scan_files f2 ON f2.id=e2.file_id
             WHERE e2.kind='usage' AND f2.provider=f.provider AND f2.session_id=f.session_id AND e2.response_id=e.response_id)
            ELSE e.request_id END canonical_request
        FROM component_events e JOIN scan_files f ON f.id=e.file_id
        WHERE e.kind='usage' AND f.removed=0 AND f.failed=0
      ), ranked AS (
        SELECT *,row_number() OVER(PARTITION BY provider,session_id,response_id,
          CASE WHEN provider='claude' THEN coalesce(canonical_request,'no-req') ELSE thread_id END,
          CASE WHEN provider='claude' THEN '' ELSE turn_id END
          ORDER BY input+output DESC,id DESC) rank FROM candidates
      ) SELECT * FROM ranked WHERE rank=1;
      CREATE INDEX temp.winners_root ON winners(provider,session_id,root_id);
      CREATE INDEX temp.winners_turn ON winners(provider,session_id,thread_id,turn_id);
      DROP TABLE IF EXISTS temp.capability_winners;
      CREATE TEMP TABLE capability_winners AS
        SELECT DISTINCT f.provider,f.session_id,e.root_id,e.thread_id,e.event_key,e.category,e.name
        FROM component_events e JOIN scan_files f ON f.id=e.file_id WHERE e.kind='capability';
      CREATE INDEX temp.capability_winners_root ON capability_winners(provider,session_id,root_id);
      INSERT OR IGNORE INTO flags SELECT file_id,root_id,'missing-request-id' FROM winners
        WHERE provider='claude' AND canonical_request IS NULL;
      INSERT OR IGNORE INTO flags SELECT e.file_id,e.root_id,'token-total-mismatch'
        FROM component_events e JOIN scan_files f ON f.id=e.file_id
        WHERE e.kind='check' AND e.id=(SELECT max(x.id) FROM component_events x JOIN scan_files y ON y.id=x.file_id
          WHERE x.kind='check' AND y.provider=f.provider AND y.session_id=f.session_id AND x.thread_id=e.thread_id AND x.turn_id=e.turn_id)
          AND (e.input<>coalesce((SELECT sum(w.input) FROM winners w WHERE w.provider=f.provider AND w.session_id=f.session_id AND w.thread_id=e.thread_id AND w.turn_id=e.turn_id),0)
            OR e.output<>coalesce((SELECT sum(w.output) FROM winners w WHERE w.provider=f.provider AND w.session_id=f.session_id AND w.thread_id=e.thread_id AND w.turn_id=e.turn_id),0));
      DROP TABLE IF EXISTS temp.prepared_turns;
      CREATE TEMP TABLE prepared_turns AS
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
          WHERE sf.provider=r.provider AND sf.session_id=r.session_id AND (x.root_id=r.root_id OR x.root_id='*')) flags,
        row_number() OVER(PARTITION BY r.provider,r.session_id ORDER BY r.started IS NULL,r.started,r.root_id) turn_index
      FROM roots r JOIN scan_files f ON f.id=coalesce(
        (SELECT sf.id FROM scan_files sf WHERE sf.provider=r.provider AND sf.session_id=r.session_id AND sf.is_main=1 AND sf.removed=0 ORDER BY sf.id LIMIT 1),r.file_id)
      LEFT JOIN outcomes o ON o.provider=r.provider AND o.session_id=r.session_id AND o.root_id=r.root_id AND o.rank=1
      WHERE o.status IS NULL OR o.status<>'aborted';
    `);
  }

  *summaries(): Generator<TurnSummaryInput> {
    let after = 0;
    const sessionName = this.connection.prepare(`SELECT coalesce(
      (SELECT session_name FROM session_names WHERE provider=? AND session_id=?),
      (SELECT session_name FROM scan_files WHERE provider=? AND session_id=? AND is_main=1
        AND removed=0 AND failed=0 AND session_name IS NOT NULL ORDER BY id DESC LIMIT 1)) AS name`);
    while (true) {
      const rows = this.connection.prepare('SELECT rowid AS cursor,* FROM prepared_turns WHERE rowid>? ORDER BY rowid LIMIT 100').all(after);
      if (!rows.length) return;
      for (const raw of rows) {
        const row = raw as unknown as {cursor:number;provider:Provider;session_id:string;root_id:string;started:number|null;completed_at:number|null;
          last_assistant:number|null;completed:number;explicit_duration:number|null;lifecycle:number;file_id:number;byte_offset:number;has_main:number;
          latest_status:TurnSummaryInput['status']|null;latest_status_at:number|null;latest_status_quality:TurnSummaryInput['duration_quality']|null;
          project_key:string;project_name:string;input_tokens:number;output_tokens:number;billing:import('./db/types').BillingMode;
          cache_read_input_tokens:number;cache_write_input_tokens:number;flags:string|null;turn_index:number;request_title:string|null};
        after = row.cursor;
        let duration: number | null = null;
        let quality: TurnSummaryInput['duration_quality'] = 'missing';
        const status = row.latest_status ?? (row.completed ? 'completed' : 'in_progress');
        const completedAt = status === 'in_progress' ? null : row.latest_status !== null ? row.latest_status_at : row.completed_at;
        if (status !== 'in_progress' && row.explicit_duration !== null) { duration = row.explicit_duration; quality = 'exact'; }
        else if (row.started !== null && completedAt !== null && completedAt >= row.started) {
          const lifecycle = row.latest_status !== null ? row.latest_status_quality === 'derived' : row.lifecycle;
          duration = completedAt - row.started; quality = status === 'completed' && lifecycle ? 'derived' : 'approximate';
        } else if (status === 'completed' && row.started !== null && row.last_assistant !== null && row.last_assistant >= row.started) {
          duration = row.last_assistant - row.started; quality = 'approximate';
        }
        const flags = new Set((row.flags ?? '').split(',').filter(Boolean));
        if (quality === 'missing') flags.add('duration-missing');
        if (quality === 'approximate') flags.add('duration-approximate');
        if (!row.has_main) flags.add('missing-root-turn');
        const name = sessionName.get(row.provider,row.session_id,row.provider,row.session_id)?.name as string | null;
        yield { provider:row.provider,project_key:row.project_key,project_name:row.project_name,session_id:row.session_id,session_name:name,
          root_turn_id:row.root_id,request_title:row.request_title,turn_index:row.turn_index,started_at_ms:row.started,completed_at_ms:completedAt,
          duration_ms:duration,duration_quality:quality,input_tokens:row.input_tokens,output_tokens:row.output_tokens,
          cache_read_input_tokens:row.cache_read_input_tokens,cache_write_input_tokens:row.cache_write_input_tokens,
          model_usage:this.modelUsage(row.provider,row.session_id,row.root_id),
          capability_usage:this.collectCapabilities ? this.capabilityUsage(row.provider,row.session_id,row.root_id) : undefined,
          billing:row.billing,
          total_tokens:row.input_tokens+row.output_tokens,status,
          quality_flags:[...flags].join(',') || null,diagnostic_file_id:flags.size ? row.file_id : null,
          diagnostic_offset:flags.size ? row.byte_offset : null };
      }
    }
  }

  private *modelUsage(provider: Provider, session: string, root: string): Generator<ModelUsageInput> {
    for (const row of this.connection.prepare(`SELECT coalesce(model,'') AS model,
      sum(input) AS input_tokens,sum(output) AS output_tokens,
      sum(min(input,cache_read)) AS cache_read_input_tokens,
      sum(min(max(0,input-cache_read),cache_write)) AS cache_write_input_tokens
      FROM winners WHERE provider=? AND session_id=? AND root_id=? GROUP BY coalesce(model,'')
      HAVING coalesce(model,'')<>'' OR sum(input+output)>0`)
      .iterate(provider,session,root)) yield row as unknown as ModelUsageInput;
  }

  private *capabilityUsage(provider: Provider, session: string, root: string): Generator<CapabilityUsageInput> {
    for (const row of this.connection.prepare(`SELECT category,name,count(*) AS usage_count FROM capability_winners
      WHERE provider=? AND session_id=? AND root_id=? GROUP BY category,name
      UNION ALL SELECT 'model',coalesce(model,''),count(*) FROM winners
      WHERE provider=? AND session_id=? AND root_id=? AND (coalesce(model,'')<>'' OR input+output>0)
      GROUP BY coalesce(model,'')`)
      .iterate(provider,session,root,provider,session,root)) yield row as unknown as CapabilityUsageInput;
  }

  close(): void {
    this.connection.exec(`DROP TABLE IF EXISTS temp.prepared_turns; DROP TABLE IF EXISTS temp.winners; DROP TABLE IF EXISTS temp.capability_winners; DROP TABLE IF EXISTS temp.component_events;
      DROP TABLE temp.flags; DROP TABLE temp.events; DROP TABLE temp.component; DROP TABLE temp.links;
      DROP TABLE temp.affected; DROP TABLE temp.scan_files; DROP TABLE temp.session_names;`);
  }
}
