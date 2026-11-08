// 메모리 최종 집계를 원본 전체를 보관하는 독립 SQL 집계와 대조한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { aggregateMemory, type MemoryAggregateFile, type MaterializedTurnSummary } from '../../src/summary/aggregation/memoryAggregate';
import type { ParseEvent, UsageEvent } from '../../src/summary/types';

const source = (id: number, provider: MemoryAggregateFile['provider'] = 'codex', events: ParseEvent[] = []): MemoryAggregateFile => ({
  id, provider, session_id: provider + '-session', identity: {sessionId:provider + '-session',threadId:'thread-' + id,
    parentThreadId:null,isMain:true,projectKey:'project',projectName:'Project',sessionName:'Session'}, events,
});
const usage = (input: number, extra: Partial<UsageEvent> = {}): UsageEvent => ({kind:'usage',rootId:'root',
  responseId:'response',requestId:null,threadId:'thread',turnId:'root',schema:'current',model:'known-model',billingMode:'api',
  tokens:{input,output:2,cacheRead:0,cacheWrite:0,reasoning:0},offset:10,...extra});

function comparable(rows: readonly MaterializedTurnSummary[]): unknown[] {
  return rows.map(row=>({provider:row.provider,session_id:row.session_id,root_turn_id:row.root_turn_id,
    project_key:row.project_key,project_name:row.project_name,session_name:row.session_name ?? null,
    request_title:row.request_title ?? null,started_at_ms:row.started_at_ms ?? null,completed_at_ms:row.completed_at_ms ?? null,
    duration_ms:row.duration_ms ?? null,duration_quality:row.duration_quality,status:row.status,
    input_tokens:row.input_tokens,output_tokens:row.output_tokens,total_tokens:row.total_tokens,
    cache_read_input_tokens:row.cache_read_input_tokens,cache_write_input_tokens:row.cache_write_input_tokens,
    billing:row.billing,quality_flags:(row.quality_flags ?? '').split(',').filter(Boolean).sort(),
    diagnostic_file_id:row.diagnostic_file_id ?? null,diagnostic_offset:row.diagnostic_offset ?? null,
    models:[...row.model_usage ?? []].map(x=>({...x})).sort((a,b)=>a.model.localeCompare(b.model)),
    capabilities:[...row.capability_usage ?? []].map(x=>({...x})).sort((a,b)=>(a.category+'/'+a.name).localeCompare(b.category+'/'+b.name))}))
    .sort((a,b)=>(a.provider+'/'+a.session_id+'/'+a.root_turn_id).localeCompare(b.provider+'/'+b.session_id+'/'+b.root_turn_id));
}

// Full raw events stay in SQL. This oracle never invokes the product's Map selector or aggregator.
function sqlOracle(files: readonly MemoryAggregateFile[]): MaterializedTurnSummary[] {
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE files(id INTEGER PRIMARY KEY,provider TEXT,session TEXT,thread TEXT,is_main INTEGER,
      project_key TEXT,project_name TEXT,session_name TEXT);
      CREATE TABLE events(id INTEGER PRIMARY KEY,file_id INTEGER,kind TEXT,root TEXT,response TEXT,request TEXT,
        thread TEXT,turn_id TEXT,input INTEGER,output INTEGER,cache_read INTEGER,cache_write INTEGER,
        is_main INTEGER,started INTEGER,completed_at INTEGER,last_assistant INTEGER,duration INTEGER,
        quality TEXT,completed INTEGER,status TEXT,status_at INTEGER,offset INTEGER,model TEXT,billing TEXT,
        category TEXT,name TEXT,event_id TEXT,title TEXT,schema TEXT);
      CREATE TABLE flags(file_id INTEGER,root TEXT,flag TEXT,PRIMARY KEY(file_id,root,flag));`);
    const putFile=db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?)');
    const putEvent=db.prepare('INSERT INTO events VALUES('+Array.from({length:29},()=>'?').join(',')+')');
    const putFlag=db.prepare('INSERT OR IGNORE INTO flags VALUES(?,?,?)');
    let id=0;
    for (const file of files) {
      const identity=file.identity;
      putFile.run(file.id,file.provider,file.session_id,identity.threadId,Number(identity.isMain),identity.projectKey,
        identity.projectName,identity.sessionName ?? null);
      for (const item of file.flags ?? []) putFlag.run(file.id,item.rootId,item.flag);
      if (identity.standaloneSubagent) putFlag.run(file.id,'*','standalone-subagent');
      for (const e of file.events) {
        const u=e.kind==='usage' || e.kind==='check' ? e : undefined,t=e.kind==='turn'?e:undefined,c=e.kind==='capability'?e:undefined;
        putEvent.run(++id,file.id,e.kind,e.rootId,e.kind==='usage'?e.responseId:null,e.kind==='usage'?e.requestId:null,
          u?.threadId ?? c?.threadId ?? null,u?.turnId ?? null,u?.tokens.input ?? null,u?.tokens.output ?? null,
          u?.tokens.cacheRead ?? null,u?.tokens.cacheWrite ?? null,t?Number(t.isMain || identity.standaloneSubagent):null,
          t?.startedAt ?? null,t?.completedAt ?? null,t?.lastAssistantAt ?? null,t?.duration ?? null,t?.durationQuality ?? null,
          Number(t?.completed ?? false),t?.status ?? null,t?.statusAt ?? null,e.offset,e.kind==='usage'?e.model ?? '':null,
          e.kind==='usage'?e.billingMode ?? 'unknown':null,c?.category ?? null,c?.name ?? null,c?.eventId ?? null,t?.title ?? null,
          e.kind==='usage'?e.schema ?? null:null);
        if ('flags' in e) for (const flag of e.flags ?? []) putFlag.run(file.id,e.rootId,flag);
      }
    }
    db.exec(`DELETE FROM events WHERE kind='usage' AND schema='legacy' AND file_id IN(
      SELECT file_id FROM events WHERE kind='usage' AND schema='current');
      CREATE TABLE winners AS WITH candidates AS (
        SELECT e.*,f.provider,f.session,CASE WHEN f.provider='claude' AND e.request IS NULL THEN
          (SELECT CASE WHEN count(DISTINCT x.request)=1 THEN min(x.request) ELSE NULL END
            FROM events x JOIN files y ON y.id=x.file_id WHERE x.kind='usage' AND x.response=e.response
            AND y.provider=f.provider AND y.session=f.session) ELSE e.request END canonical
        FROM events e JOIN files f ON f.id=e.file_id WHERE e.kind='usage'
      ), ranked AS (SELECT *,row_number() OVER(PARTITION BY provider,session,response,
        CASE WHEN provider='claude' THEN coalesce(canonical,'no-req') ELSE thread END,
        CASE WHEN provider='claude' THEN '' ELSE turn_id END ORDER BY input+output DESC,id DESC) rank FROM candidates)
      SELECT * FROM ranked WHERE rank=1;
      INSERT OR IGNORE INTO flags SELECT file_id,root,'missing-request-id' FROM winners
        WHERE provider='claude' AND canonical IS NULL;
      INSERT OR IGNORE INTO flags SELECT e.file_id,e.root,'token-total-mismatch' FROM events e JOIN files f ON f.id=e.file_id
        WHERE e.kind='check' AND e.id=(SELECT max(x.id) FROM events x JOIN files y ON y.id=x.file_id
          WHERE x.kind='check' AND y.provider=f.provider AND y.session=f.session AND x.thread=e.thread AND x.turn_id=e.turn_id)
        AND (e.input<>coalesce((SELECT sum(input) FROM winners w WHERE w.provider=f.provider AND w.session=f.session
          AND w.thread=e.thread AND w.turn_id=e.turn_id),0) OR e.output<>coalesce((SELECT sum(output) FROM winners w
          WHERE w.provider=f.provider AND w.session=f.session AND w.thread=e.thread AND w.turn_id=e.turn_id),0));
      CREATE TABLE cap AS WITH ranked AS (SELECT e.*,f.provider,f.session,row_number() OVER(PARTITION BY f.provider,
        f.session,e.root,e.thread,e.event_id,e.category,e.name ORDER BY e.id) rank
        FROM events e JOIN files f ON f.id=e.file_id WHERE e.kind='capability') SELECT * FROM ranked WHERE rank=1;
      CREATE TABLE roots AS WITH source_outcomes AS (SELECT f.provider,f.session,e.root,e.status,e.status_at,e.quality,e.id,
        max(e.status_at) OVER(PARTITION BY e.file_id,e.root) ordering_at,
        row_number() OVER(PARTITION BY e.file_id,e.root ORDER BY e.id DESC) source_rank
        FROM events e JOIN files f ON f.id=e.file_id WHERE e.is_main=1 AND e.status IS NOT NULL),
      outcomes AS (SELECT *,row_number() OVER(PARTITION BY provider,session,root ORDER BY ordering_at DESC,id DESC) rank
        FROM source_outcomes WHERE source_rank=1), grouped AS (SELECT f.provider,f.session,e.root,
        min(CASE WHEN e.is_main=1 THEN e.started END) started,
        max(CASE WHEN e.is_main=1 AND e.completed=1 THEN e.completed_at END) completed_at,
        max(CASE WHEN e.is_main=1 THEN e.last_assistant END) last_assistant,
        max(CASE WHEN e.is_main=1 THEN e.completed ELSE 0 END) completed,
        max(CASE WHEN e.is_main=1 AND e.quality='exact' THEN e.duration END) explicit_duration,
        max(CASE WHEN e.is_main=1 AND e.quality='derived' AND e.completed=1 THEN 1 ELSE 0 END) lifecycle,
        min(f.id) file_id,min(e.offset) offset,max(f.is_main) has_main
        FROM events e JOIN files f ON f.id=e.file_id GROUP BY f.provider,f.session,e.root)
      SELECT g.*,o.status latest_status,o.status_at latest_at,o.quality latest_quality,
        coalesce(o.status,CASE WHEN g.completed=1 THEN 'completed' ELSE 'in_progress' END) status,
        CASE WHEN o.status IS NOT NULL AND o.status<>'in_progress' THEN o.status_at
          WHEN o.status IS NULL AND g.completed=1 THEN g.completed_at ELSE NULL END ended
        FROM grouped g LEFT JOIN outcomes o ON o.provider=g.provider AND o.session=g.session AND o.root=g.root AND o.rank=1
        WHERE o.status IS NULL OR o.status<>'aborted';`);
    const result:MaterializedTurnSummary[]=[];
    for (const r of db.prepare('SELECT * FROM roots').all()) {
      const provider=r.provider as MemoryAggregateFile['provider'],session=r.session as string,root=r.root as string;
      const main=db.prepare('SELECT * FROM files WHERE provider=? AND session=? AND is_main=1 ORDER BY id LIMIT 1').get(provider,session)
        ?? db.prepare('SELECT * FROM files WHERE id=?').get(r.file_id)!;
      const tokens=db.prepare(`SELECT coalesce(sum(input),0) input,coalesce(sum(output),0) output,
        coalesce(sum(min(input,cache_read)),0) cache_read,coalesce(sum(min(max(0,input-cache_read),cache_write)),0) cache_write,
        CASE WHEN count(DISTINCT billing)=1 THEN min(billing) ELSE 'unknown' END billing
        FROM winners WHERE provider=? AND session=? AND root=?`).get(provider,session,root)!;
      let quality:'exact'|'derived'|'approximate'|'missing'='missing',duration:number|null=null;
      if (r.status!=='in_progress' && r.explicit_duration!==null) {duration=r.explicit_duration as number;quality='exact';}
      else if (r.started!==null && r.ended!==null && Number(r.ended)>=Number(r.started)) {
        duration=Number(r.ended)-Number(r.started);quality=r.status==='completed'
          && (r.latest_status!==null?r.latest_quality==='derived':r.lifecycle===1)?'derived':'approximate';
      } else if (r.status==='completed' && r.started!==null && r.last_assistant!==null && Number(r.last_assistant)>=Number(r.started)) {
        duration=Number(r.last_assistant)-Number(r.started);quality='approximate';
      }
      const flags=new Set(db.prepare(`SELECT DISTINCT x.flag FROM flags x JOIN files f ON f.id=x.file_id
        WHERE f.provider=? AND f.session=? AND (x.root=? OR x.root='*')`).all(provider,session,root).map(x=>x.flag as string));
      if (quality==='missing') flags.add('duration-missing');if (quality==='approximate') flags.add('duration-approximate');
      if (!r.has_main) flags.add('missing-root-turn');
      const name=db.prepare('SELECT session_name FROM files WHERE provider=? AND session=? AND is_main=1 AND session_name IS NOT NULL ORDER BY id DESC LIMIT 1').get(provider,session)?.session_name;
      const models=db.prepare(`SELECT model,sum(input) input_tokens,sum(output) output_tokens,sum(min(input,cache_read)) cache_read_input_tokens,
        sum(min(max(0,input-cache_read),cache_write)) cache_write_input_tokens FROM winners WHERE provider=? AND session=? AND root=?
        GROUP BY model HAVING model<>'' OR sum(input+output)>0`).all(provider,session,root);
      const caps=db.prepare(`SELECT category,name,count(*) usage_count FROM cap WHERE provider=? AND session=? AND root=? GROUP BY category,name
        UNION ALL SELECT 'model',model,count(*) FROM winners WHERE provider=? AND session=? AND root=? AND (model<>'' OR input+output>0) GROUP BY model`)
        .all(provider,session,root,provider,session,root);
      result.push({provider,session_id:session,root_turn_id:root,project_key:String(main.project_key),project_name:String(main.project_name),
        session_name:name as string|null ?? null,request_title:db.prepare(`SELECT e.title FROM events e JOIN files f ON f.id=e.file_id
          WHERE f.provider=? AND f.session=? AND e.root=? AND e.is_main=1 AND e.title IS NOT NULL ORDER BY e.id LIMIT 1`).get(provider,session,root)?.title as string|null ?? null,
        started_at_ms:r.started as number|null,completed_at_ms:r.ended as number|null,duration_ms:duration,duration_quality:quality,
        status:r.status as 'completed'|'in_progress'|'failed',input_tokens:Number(tokens.input),output_tokens:Number(tokens.output),
        total_tokens:Number(tokens.input)+Number(tokens.output),cache_read_input_tokens:Number(tokens.cache_read),cache_write_input_tokens:Number(tokens.cache_write),
        billing:tokens.billing as 'api'|'subscription'|'unknown',quality_flags:[...flags].join(',')||null,
        diagnostic_file_id:flags.size?Number(r.file_id):null,diagnostic_offset:flags.size?Number(r.offset):null,
        model_usage:models as unknown as MaterializedTurnSummary['model_usage'],capability_usage:caps as unknown as MaterializedTurnSummary['capability_usage'],hasMain:Boolean(r.has_main)});
    }
    return result;
  } finally {db.close();}
}

test('pure memory aggregation agrees with full raw SQL for seeded winner, lifecycle, check, model and capability streams',()=>{
  for (let seed=1;seed<=32;seed++) {
    let state=seed;const next=(n:number)=>((state=(state*1664525+1013904223)>>>0)%n);
    const files=[source(1,'claude'),source(2,'claude'),source(3),source(4)];
    for (const file of files) {
      const events=file.events as ParseEvent[];
      for (let root=0;root<3;root++) events.push({kind:'turn',rootId:'root-'+root,isMain:true,
        startedAt:1000+root*100,title:'Title '+root,offset:events.length});
      for (let i=0;i<60;i++) {
        const root='root-'+next(3),thread='thread-'+next(2),turn='turn-'+next(2);
        if (i%7===0) events.push({kind:'capability',rootId:root,threadId:thread,eventId:'cap-'+next(4),
          category:'skill',name:'skill-'+next(2),offset:events.length});
        else if (i%11===0) events.push({kind:'check',rootId:root,threadId:thread,turnId:turn,
          tokens:{input:next(300),output:next(20),cacheRead:0,cacheWrite:0,reasoning:0},offset:events.length});
        else events.push(usage(next(250),{rootId:root,responseId:'response-'+next(6),requestId:next(3)?'request-'+next(2):null,
          threadId:thread,turnId:turn,model:next(3)?'model-'+next(2):'',billingMode:next(3)?'api':'subscription',
          tokens:{input:100+next(200),output:next(10),cacheRead:next(40),cacheWrite:next(20),reasoning:0},
          flags:next(9)?[]:['source-warning'],offset:events.length}));
      }
      for (let root=0;root<3;root++) events.push({kind:'turn',rootId:'root-'+root,isMain:true,
        status:next(4)?'completed':'aborted',statusAt:2000+next(100),durationQuality:'derived',completed:true,
        completedAt:2100,lastAssistantAt:1900,offset:events.length});
    }
    const before=structuredClone(files),actual=aggregateMemory(files);
    assert.deepEqual(comparable(actual.summaries),comparable(sqlOracle(files)),'seed '+seed);
    assert.deepEqual(files,before,'input snapshots remain reusable: seed '+seed);
    assert.deepEqual(actual.orphans,[]);
  }
});

test('canonical requests retain ambiguity, literal no-req collisions, ties and complete winner vectors',()=>{
  const file=source(1,'claude',[
    {kind:'turn',rootId:'root',isMain:true,startedAt:10,offset:0},
    usage(100,{requestId:null,model:'missing-id'}),usage(120,{requestId:'first',model:'first'}),
    usage(120,{requestId:'first',model:'latest',tokens:{input:110,output:12,cacheRead:7,cacheWrite:3,reasoning:4}}),
    usage(90,{requestId:'second',model:'second'}),usage(50,{requestId:'no-req',model:'literal'}),
  ]);
  assert.deepEqual(comparable(aggregateMemory([file]).summaries),comparable(sqlOracle([file])));
});

test('legacy copied winner exclusion keeps a lower valid candidate and original warning without source rereads',()=>{
  const parent=source(1,'codex',[
    {kind:'turn',rootId:'root',isMain:true,startedAt:0,offset:0},usage(100,{schema:'legacy',threadId:'parent',model:'parent-model'}),
  ]);
  parent.identity.threadId='parent';
  const child=source(2,'codex',[
    {kind:'turn',rootId:'root',isMain:true,startedAt:0,offset:0},usage(100,{schema:'legacy',threadId:'child',model:'copied-model'}),
    usage(0,{schema:'legacy',threadId:'child',model:'surviving-model',tokens:{input:0,output:0,cacheRead:0,cacheWrite:0,reasoning:0},
      flags:['counter-regression'],offset:20}),
  ]);
  child.identity.threadId='child';child.identity.forkedFromId='parent';
  const result=aggregateMemory([parent,child]);assert.equal(result.summaries.length,1);
  const row=result.summaries[0];assert.equal(row.total_tokens,102);
  assert.deepEqual([...row.model_usage].map(x=>[x.model,x.input_tokens,x.output_tokens]).sort(),
    [['parent-model',100,2],['surviving-model',0,0]]);
  assert.match(row.quality_flags ?? '',/counter-regression/);assert.deepEqual(result.orphans,[]);
});

test('mixed current excludes legacy usage while preserving observed diagnostics and capability collection toggle',()=>{
  const file=source(1,'codex',[
    {kind:'turn',rootId:'root',isMain:true,offset:0},usage(900,{schema:'legacy',flags:['legacy-warning']}),
    usage(20,{schema:'current',responseId:'current'}),
    {kind:'capability',rootId:'root',threadId:'thread',eventId:'tool',category:'skill',name:'sample',offset:30},
  ]);
  const expected=sqlOracle([file]);assert.deepEqual(comparable(aggregateMemory([file]).summaries),comparable(expected));
  const row=aggregateMemory([file],false).summaries[0];assert.equal(row.capability_usage,undefined);
  assert.equal(row.total_tokens,22);assert.match(row.quality_flags ?? '',/legacy-warning/);
});

test('source lifecycle arrival order and historical maximum timestamp jointly determine the final outcome',()=>{
  const first=source(1,'codex',[
    {kind:'turn',rootId:'root',isMain:true,startedAt:100,offset:0},usage(100),
    {kind:'turn',rootId:'root',isMain:true,status:'completed',statusAt:900,durationQuality:'derived',offset:20},
    {kind:'turn',rootId:'root',isMain:true,status:'in_progress',statusAt:200,offset:30},
  ]);
  const second=source(2,'codex',[
    {kind:'turn',rootId:'root',isMain:true,status:'failed',statusAt:800,durationQuality:'approximate',offset:0},
  ]);
  const actual=aggregateMemory([first,second]);
  assert.deepEqual(comparable(actual.summaries),comparable(sqlOracle([first,second])));
  assert.equal(actual.summaries[0].status,'in_progress');assert.equal(actual.summaries[0].completed_at_ms,null);
});
