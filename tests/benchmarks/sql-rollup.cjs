// 원본 집계와 세션·일별 롤업 시제품의 정확성·읽기·쓰기·공간을 비교한다.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, statSync } = require('node:fs');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { cpus, tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { backup, DatabaseSync } = require('node:sqlite');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const { buildUsageQuery, buildUsageCountQuery, buildQueryFilter } = require('../../dist/src/summary/db/queries');
const { SCHEMA_VERSION } = require('../../dist/src/summary/db/schema');
const { calendarPeriod, periodBounds } = require('../../dist/src/summary/db/timezone');
const { describe, workloads, prepared, execute, stats } = require('./sql-explain.cjs');
const rollup = require('./sql-rollup-prototype.cjs');

const root = resolve(__dirname, '../..');
const sha = input => createHash('sha256').update(input).digest('hex');
const variants = ['current','session-day-rollup'];
const seoulTime = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',dateStyle:'short',timeStyle:'medium'}).format(new Date());
const round = value => typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(12)) : value;
const canonical = value => JSON.stringify(value, (_key, raw) => round(raw));

function optionsFor(args) {
  const options = { sizes:[280,100000],turnsPerSession:[10,100],samples:3,warmup:1,output:resolve(root,'docs/benchmarks/SqlRollupABBenchmark-2026-10-15.json'),worstCase:true };
  for (const arg of args) {
    if (arg.startsWith('--sizes=')) options.sizes=arg.slice(8).split(',').map(Number);
    else if (arg.startsWith('--turns-per-session=')) options.turnsPerSession=arg.slice(20).split(',').map(Number);
    else if (arg.startsWith('--samples=')) options.samples=Number(arg.slice(10));
    else if (arg.startsWith('--warmup=')) options.warmup=Number(arg.slice(9));
    else if (arg.startsWith('--output=')) options.output=resolve(arg.slice(9));
    else if (arg==='--no-worst-case') options.worstCase=false;
    else throw new Error(`Unknown option ${arg}`);
  }
  assert.ok(options.sizes.every(n=>Number.isSafeInteger(n)&&n>0&&n<=1000000));
  assert.ok(options.turnsPerSession.every(n=>Number.isSafeInteger(n)&&n>0&&n<=10000));
  assert.ok(Number.isInteger(options.samples)&&options.samples>=3&&options.samples<=15);
  assert.ok(Number.isInteger(options.warmup)&&options.warmup>=1&&options.warmup<=5);
  return options;
}

function seed(db,count,turnsPerSession) {
  const project=db.connection.prepare('INSERT OR IGNORE INTO projects VALUES (?,?)');
  const session=db.connection.prepare('INSERT OR IGNORE INTO sessions VALUES (?,?,?)');
  const turn=db.connection.prepare(`INSERT INTO turn_summary
    (id,provider,project_key,session_id,root_turn_id,started_at_ms,completed_at_ms,duration_ms,duration_quality,input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens,total_tokens,status,last_error,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const model=db.connection.prepare('INSERT INTO turn_model_usage VALUES (?,?,?,?,?,?,?,?)');
  db.transaction(()=>{
    for(let i=0;i<count;i++) {
      const sid=Math.floor(i/turnsPerSession),provider=sid%2?'codex':'claude',pk=`/fixture/project-${Math.floor(sid/2)%20}`,sessionId=`session-${sid}`;
      project.run(pk,basename(pk));session.run(provider,sessionId,sessionId);
      const start=i%101===0?null:Date.UTC(2026,6,1)+(sid*17%90)*rollup.DAY+(i%turnsPerSession)*60000;
      const status=i%17===0?'failed':i%11===0?'in_progress':'completed';
      const empty=i%41===0,input=empty?0:1000+i%19000,output=empty?0:100+i%1900;
      const write=empty?0:i%67===0?null:100,read=empty?0:i%71===0?null:200;
      const duration=status!=='completed'||i%59===0?null:1000+i%10001;
      const quality=status!=='completed'?'missing':i%31===0?'approximate':i%29===0?'derived':'exact';
      turn.run(i+1,provider,pk,sessionId,`request-${i}`,start,status==='completed'&&start!==null?start+1000:null,duration,quality,input,output,write,read,input+output,status,i%79===0?'fixture error':null,'2026-10-15T00:00:00.000Z');
      if(empty&&i%2===0||i%61===0) continue;
      const name=i%53===0||i===123?'':`${provider}-model-${sid%3}`;
      if(!empty&&i%5===0) {
        model.run(i+1,name,input-200,output-50,write,read,null,'fixture');
        model.run(i+1,`${provider}-helper`,200,50,write===null?null:0,read===null?null:0,null,'fixture');
      } else model.run(i+1,name,input,output,write,read,null,'fixture');
    }
  });
}

function fullResults(db,query) {
  return db.connection.prepare(query.sql).all(...query.values,10000000,0);
}

function compareResults(a,b,context) {
  assert.equal(a.length,b.length,`${context}: group count`);
  for(let i=0;i<a.length;i++) {
    assert.deepEqual(Object.keys(a[i]),Object.keys(b[i]),`${context}: field names`);
    for(const key of Object.keys(a[i])) {
      const av=a[i][key],bv=b[i][key];
      if(typeof av==='number'&&typeof bv==='number'&&(key.startsWith('avg_')||key==='cost_usd')) assert.ok(Math.abs(av-bv)<=1e-9*Math.max(1,Math.abs(av)),`${context} row ${i} ${key}: ${av} != ${bv}`);
      else assert.equal(av,bv,`${context} row ${i} ${key}`);
    }
  }
  return sha(canonical(a));
}

function inputRows(db,spec,candidate) {
  if(candidate.mode==='raw-fallback') return { rawRequestFacts:spec.matchedRequestFacts,rawModelFacts:spec.matchedModelFacts,rollupRows:0,rawBoundaryInputRows:0,source:'raw-fallback' };
  const source=candidate.source;
  const n=db.connection.prepare(`SELECT count(*) n FROM ${rollup.tables[spec.by]} AS turn_summary WHERE ${source.rollupWhere}`).get(...source.rollupValues).n;
  const boundary=source.boundary?db.connection.prepare(`SELECT count(*) n FROM ${rollup.rawSource(spec.by)} AS turn_summary WHERE ${source.boundary.where}`).get(...source.boundary.values).n:0;
  const baseline=spec.by==='model'?spec.matchedModelFacts:spec.matchedRequestFacts;
  return { baselineLogicalInputRows:baseline,rollupRows:n,rawBoundaryInputRows:boundary,logicalInputRows:n+boundary,reductionFraction:1-(n+boundary)/baseline,
    scope:'logical selected aggregate input; not actual visited SQLite rows/pages; boundary raw rows are grouped before outer merge' };
}

function measureRead(dbs,spec,options) {
  const candidate=rollup.build(spec.filter,spec.groupBy,rollup.TIMEZONE,spec.by,spec.sortBy);
  const queries=[prepared(dbs[0],spec),prepared(dbs[1],{rows:candidate.rows,count:candidate.count})];
  const full=fullResults(dbs[0],spec.rows),other=fullResults(dbs[1],candidate.rows);
  const fullDigest=compareResults(full,other,spec.name);
  const initial=queries.map(execute);
  assert.equal(initial[0].total,initial[1].total);
  compareResults(initial[0].rows,initial[1].rows,`${spec.name} page`);
  assert.equal(full.length,initial[0].total);
  const iterations=Math.min(30,Math.max(1,Math.ceil(8/Math.max(...initial.map(v=>v.bundleMs),.01))));
  for(const query of queries) for(let i=0;i<options.warmup;i++) execute(query);
  const samples=queries.map(()=>({rows:[],count:[],bundle:[]}));
  const rssBefore=process.memoryUsage().rss;
  for(let i=0;i<options.samples;i++) for(const variant of i%2?[1,0]:[0,1]) {
    let rows=0,count=0,bundle=0;
    for(let j=0;j<iterations;j++) {const value=execute(queries[variant]);rows+=value.rowsMs;count+=value.countMs;bundle+=value.bundleMs;}
    samples[variant].rows.push(rows/iterations);samples[variant].count.push(count/iterations);samples[variant].bundle.push(bundle/iterations);
  }
  queries.forEach((q,i)=>compareResults(initial[i].rows,execute(q).rows,`${spec.name} timed final`));
  return {name:spec.name,groupBy:spec.groupBy,by:spec.by,mode:candidate.mode,fallbackReason:candidate.reason,
    filter:{...spec.filter,...(spec.filter.projectKey?{projectKey:'[selected project]'}:{}),...(spec.filter.sessionId?{sessionId:'[selected session]'}:{})},
    returnedGroups:initial[0].rows.length,totalGroups:full.length,fullResultSha256:fullDigest,correctness:'all fields and all groups; integer/string/null fields exact; avg_* and cost_usd relative/absolute tolerance 1e-9',
    iterationsPerSample:iterations,inputRows:inputRows(dbs[1],spec,candidate),
    variants:Object.fromEntries(variants.map((variant,i)=>[variant,{rows:stats(samples[i].rows),count:stats(samples[i].count),bundle:stats(samples[i].bundle),plans:queries[i].plans,
      sql:{rows:i?candidate.rows.sql:spec.rows.sql,count:i?candidate.count.sql:spec.count.sql}}])),
    speedup:samples[0]?stats(samples[0].bundle).medianMs/stats(samples[1].bundle).medianMs:undefined,
    observedProcess:{rssBeforeBytes:rssBefore,rssAfterBytes:process.memoryUsage().rss,lifetimePeakRssBytes:process.resourceUsage().maxRSS*1024,scope:'same process shared A/B; includes prior datasets, validation and fixtures; not isolated per-variant peak'},
  };
}

function space(db,path) {
  db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const pageSize=db.connection.prepare('PRAGMA page_size').get().page_size;
  const pages=db.connection.prepare('PRAGMA page_count').get().page_count;
  const free=db.connection.prepare('PRAGMA freelist_count').get().freelist_count;
  const objects=db.connection.prepare('SELECT name,sum(pgsize) bytes,count(*) pages,sum(ncell) cells FROM dbstat GROUP BY name ORDER BY name').all();
  return {pageSize,pageCount:pages,freePages:free,allocatedBytes:pages*pageSize,liveAllocatedBytes:(pages-free)*pageSize,fileBytes:statSync(path).size,
    rollupBytes:objects.filter(v=>v.name.startsWith('bench_')).reduce((n,v)=>n+v.bytes,0),objects};
}

function getSessionInput(db) {
  const chosen=db.connection.prepare('SELECT provider,session_id FROM turn_summary GROUP BY provider,session_id ORDER BY count(*) DESC,provider,session_id LIMIT 1').get();
  const rows=db.connection.prepare('SELECT t.*,p.project_name,s.session_name FROM turn_summary t JOIN projects p USING(project_key) JOIN sessions s ON s.provider=t.provider AND s.session_id=t.session_id WHERE t.provider=? AND t.session_id=? ORDER BY t.id').all(chosen.provider,chosen.session_id);
  const model=db.connection.prepare('SELECT model,input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens FROM turn_model_usage WHERE turn_id=? ORDER BY model');
  return {sessions:[{...chosen}],files:[],summaries:rows.map(raw=>{const {id,...row}=raw;const models=model.all(id);return {...row,model_usage:models.length?models:undefined};})};
}

function hookReplace(db,replacement,enable,observer={}) {
  const exec=db.connection.exec;
  let begin=0,commit=0,rollback=0,refreshMs=0;
  db.connection.exec=function(sql) {
    const trimmed=sql.trim();
    if(trimmed==='BEGIN IMMEDIATE') begin++;
    if(trimmed==='COMMIT') {
      if(enable) {const start=performance.now();rollup.refresh(db,replacement.sessions);refreshMs+=performance.now()-start;}
      observer.beforeCommit?.();commit++;
    }
    if(trimmed==='ROLLBACK') rollback++;
    return exec.call(this,sql);
  };
  const start=performance.now();
  try {db.replaceSessions(replacement);return {elapsedMs:performance.now()-start,refreshMs,begin,commit,rollback};}
  finally {db.connection.exec=exec;}
}

function walSize(path) {try{return statSync(`${path}-wal`).size;}catch(error){if(error.code==='ENOENT')return 0;throw error;}}

function measureWrites(dbs,paths,options) {
  const start=performance.now(),base=getSessionInput(dbs[0]),preparationMs=performance.now()-start;
  const historical=structuredClone(base),moved=structuredClone(base),appended=structuredClone(base);
  historical.summaries[0].started_at_ms=Date.UTC(2026,4,1);
  historical.summaries[0].updated_at='2026-10-16T00:00:00.000Z';
  for(const row of moved.summaries){row.project_key='/fixture/moved-project';row.project_name='moved-project';}
  const extra=structuredClone(base.summaries.at(-1));extra.root_turn_id='appended-turn';extra.started_at_ms=Date.UTC(2026,9,15);appended.summaries.push(extra);
  const deletion={sessions:base.sessions,files:[],summaries:[]};
  const scenarios=[['replace-same-session',base],['append-one-turn',appended],['historical-date-correction',historical],['project-move',moved],['delete-session',deletion]];
  const results=[];
  const pageSizes=dbs.map(db=>db.connection.prepare('PRAGMA page_size').get().page_size);
  for(const [name,input] of scenarios) {
    const samples=variants.map(()=>[]);
    for(let i=0;i<options.samples;i++) for(const variant of i%2?[1,0]:[0,1]) {
      hookReplace(dbs[variant],base,variant===1);
      dbs[variant].connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const beforeChanges=dbs[variant].connection.prepare('SELECT total_changes() n').get().n;
      const value=hookReplace(dbs[variant],input,variant===1);
      value.walFileBytes=walSize(paths[variant]);
      value.walFrameCount=value.walFileBytes?Math.max(0,(value.walFileBytes-32)/(pageSizes[variant]+24)):0;
      value.totalSqliteChanges=dbs[variant].connection.prepare('SELECT total_changes() n').get().n-beforeChanges;
      assert.equal(value.begin,1);assert.equal(value.commit,1);assert.equal(value.rollback,0);
      samples[variant].push(value);
    }
    // Validate post-update statistics, including disappearance of old day/project buckets.
    for(const by of ['provider','model']) for(const groupBy of ['total','day','project','session']) {
      const filter={excludeEmptyUsage:true};const a=buildUsageQuery(filter,groupBy,rollup.TIMEZONE,by),b=rollup.build(filter,groupBy,rollup.TIMEZONE,by).rows;
      compareResults(fullResults(dbs[0],a),fullResults(dbs[1],b),`write ${name} ${groupBy} ${by}`);
    }
    results.push({name,sessionInputTurns:input.summaries.length,variants:Object.fromEntries(variants.map((variant,i)=>[variant,{latency:stats(samples[i].map(v=>v.elapsedMs)),rollupRefresh:stats(samples[i].map(v=>v.refreshMs)),samples:samples[i]}]))});
  }
  dbs.forEach((db,i)=>hookReplace(db,base,i===1));
  // Product rejects invalid metadata after BEGIN; both detail and aggregate snapshots must survive.
  const before=dbs.map(db=>sha(canonical(db.connection.prepare('SELECT provider,session_id,root_turn_id,total_tokens FROM turn_summary ORDER BY provider,session_id,root_turn_id').all())));
  const invalid=structuredClone(base);invalid.summaries[0].input_tokens=-1;
  for(let i=0;i<dbs.length;i++) assert.throws(()=>hookReplace(dbs[i],invalid,i===1));
  for(let i=0;i<dbs.length;i++) assert.equal(before[i],sha(canonical(dbs[i].connection.prepare('SELECT provider,session_id,root_turn_id,total_tokens FROM turn_summary ORDER BY provider,session_id,root_turn_id').all())));
  const aggregateBefore=sha(canonical(Object.values(rollup.tables).map(table=>dbs[1].connection.prepare(`SELECT * FROM ${table} ORDER BY provider,session_id,project_key,local_day`).all())));
  assert.throws(()=>hookReplace(dbs[1],appended,true,{beforeCommit(){throw new Error('injected failure after aggregate refresh');}}),/injected failure/);
  assert.equal(before[1],sha(canonical(dbs[1].connection.prepare('SELECT provider,session_id,root_turn_id,total_tokens FROM turn_summary ORDER BY provider,session_id,root_turn_id').all())));
  assert.equal(aggregateBefore,sha(canonical(Object.values(rollup.tables).map(table=>dbs[1].connection.prepare(`SELECT * FROM ${table} ORDER BY provider,session_id,project_key,local_day`).all()))));
  const snapshot=checkSnapshot(dbs[1],paths[1],appended);
  return {inputPreparationMs:preparationMs,inputPreparationScope:'session/model extraction and JS objects outside transaction timings; parsing/scanner not measured',scenarios:results,
    checks:{invalidInputRollback:true,rollbackAfterRollupRefresh:true,...snapshot},unchangedScanner:'not measured; no claim about scanner no-change latency',
    walScope:'wal_autocheckpoint=0; TRUNCATE checkpoint outside each timed transaction; WAL file logical bytes/frames after commit, not physical disk I/O or fsync count'};
}

function checkSnapshot(db,path,input) {
  const reader=new SummaryDatabase(path),before=reader.connection.prepare('SELECT count(*) n FROM turn_summary').get().n;
  reader.connection.exec('BEGIN');
  assert.equal(reader.connection.prepare('SELECT count(*) n FROM turn_summary').get().n,before);
  const aggregateBefore=sha(canonical(Object.values(rollup.tables).map(table=>reader.connection.prepare(`SELECT * FROM ${table} ORDER BY provider,session_id,project_key,local_day`).all())));
  let beforeCommitChecked=false;
  try {
    hookReplace(db,input,true,{beforeCommit(){
      assert.equal(reader.connection.prepare('SELECT count(*) n FROM turn_summary').get().n,before);
      assert.equal(aggregateBefore,sha(canonical(Object.values(rollup.tables).map(table=>reader.connection.prepare(`SELECT * FROM ${table} ORDER BY provider,session_id,project_key,local_day`).all()))));
      beforeCommitChecked=true;
    }});
    assert.equal(reader.connection.prepare('SELECT count(*) n FROM turn_summary').get().n,before);
    assert.equal(aggregateBefore,sha(canonical(Object.values(rollup.tables).map(table=>reader.connection.prepare(`SELECT * FROM ${table} ORDER BY provider,session_id,project_key,local_day`).all()))));
    reader.connection.exec('COMMIT');
    assert.equal(reader.connection.prepare('SELECT count(*) n FROM turn_summary').get().n,before+1);
    const a=buildUsageQuery({},'total',rollup.TIMEZONE,'provider'),b=rollup.build({},'total',rollup.TIMEZONE,'provider').rows;
    compareResults(fullResults(reader,a),fullResults(reader,b),'reader after commit');
    return {readerSnapshotDuringWrite:beforeCommitChecked,readerRetainsSnapshotAfterCommit:true,readerNewSnapshotSeesAtomicDetailsAndRollup:true};
  } finally {reader.close();}
}

function semanticChecks(dbs) {
  let cases=0;const hashes=[];
  for(const by of ['provider','model']) for(const groupBy of ['total','project','session','day','month']) for(const excludeEmptyUsage of [false,true]) for(const unknownTime of [undefined,'include','exclude','only']) {
    const filter={excludeEmptyUsage,unknownTime,fromMs:Date.UTC(2026,6,4,1,23),toMs:Date.UTC(2026,8,7,3,47)};
    const a=buildUsageQuery(filter,groupBy,rollup.TIMEZONE,by),b=rollup.build(filter,groupBy,rollup.TIMEZONE,by);
    hashes.push(compareResults(fullResults(dbs[0],a),fullResults(dbs[1],b.rows),`semantic ${cases}`));cases++;
  }
  for(const [timezone,includeCosts] of [['UTC',false],[rollup.TIMEZONE,true]]) {
    const filter={includeCosts};const a=buildUsageQuery(filter,'total',timezone,'model'),b=rollup.build(filter,'total',timezone,'model');
    assert.equal(b.mode,'raw-fallback');compareResults(fullResults(dbs[0],a),fullResults(dbs[1],b.rows),'explicit fallback');cases++;
  }
  return {cases,digestSha256:sha(hashes.join('')),coverage:'both bases, all 5 groupings, excludeEmpty true/false, unknownTime default/include/exclude/only, partial-day boundaries; UTC and includeCosts explicit raw fallback'};
}

function alignedWorkloads(db) {
  const latest=db.connection.prepare('SELECT max(started_at_ms) latest FROM turn_summary').get().latest;
  const end=periodBounds(calendarPeriod(latest,rollup.TIMEZONE,'day'),rollup.TIMEZONE).toMs;
  return ['provider','model'].map(by=>{
    const filter={providers:['claude','codex'],excludeEmptyUsage:true,fromMs:end-7*rollup.DAY,toMs:end,unknownTime:'include'};
    const where=buildQueryFilter(filter);
    return {name:`day-7-aligned-${by}`,groupBy:'day',by,filter,
      matchedRequestFacts:db.connection.prepare(`SELECT count(*) n FROM turn_summary WHERE ${where.sql}`).get(...where.values).n,
      matchedModelFacts:db.connection.prepare(`SELECT count(*) n FROM turn_summary LEFT JOIN turn_model_usage m ON m.turn_id=turn_summary.id WHERE ${where.sql}`).get(...where.values).n,
      rows:buildUsageQuery(filter,'day',rollup.TIMEZONE,by),count:buildUsageCountQuery(filter,'day',rollup.TIMEZONE,by)};
  });
}

async function runDataset(directory,count,turnsPerSession,options) {
  const label=`synthetic-${count}-turns-${turnsPerSession}`,paths=variants.map(v=>join(directory,`${label}-${v}.sqlite`));
  const base=new SummaryDatabase(join(directory,`${label}-base.sqlite`));
  try {seed(base,count,turnsPerSession);for(const path of paths) await backup(base.connection,path);}
  finally {base.close();}
  const dbs=paths.map(path=>new SummaryDatabase(path));
  try {
    for(const db of dbs)db.connection.exec('PRAGMA wal_autocheckpoint=0');
    const descriptions=describe(dbs[0]),rssBefore=process.memoryUsage().rss,start=performance.now();
    rollup.install(dbs[1]);const ddlMs=performance.now()-start;
    const buildStart=performance.now();dbs[1].transaction(()=>rollup.refresh(dbs[1]));const initialBuildMs=performance.now()-buildStart;
    for(const db of dbs)db.connection.exec('ANALYZE');
    const spaceValues=dbs.map((db,i)=>space(db,paths[i]));
    const result={label,turnsPerSession,...descriptions,fixture:'deterministic synthetic; 90 local days, 20 project slots, two providers, multi-model and missing/empty metadata, null caches/durations, mixed statuses, stale diagnostics',
      initialBuild:{ddlMs,aggregateTransactionMs:initialBuildMs,totalMs:ddlMs+initialBuildMs,observedRssBeforeBytes:rssBefore,observedRssAfterBytes:process.memoryUsage().rss},
      rollupRows:{request:dbs[1].connection.prepare(`SELECT count(*) n FROM ${rollup.tables.provider}`).get().n,model:dbs[1].connection.prepare(`SELECT count(*) n FROM ${rollup.tables.model}`).get().n},
      space:Object.fromEntries(variants.map((v,i)=>[v,spaceValues[i]])),workloads:[]};
    const specs=[...workloads(dbs[0]),...alignedWorkloads(dbs[0])];
    for(const spec of specs) {
      // The inherited builder currently omits sortBy in its returned descriptor. Restore its named average workload explicitly.
      if(spec.name==='project-average-provider')spec.sortBy='averageTokens';
      const value=measureRead(dbs,spec,options);result.workloads.push(value);
      console.log(`${label} ${spec.name}: ${value.variants.current.bundle.medianMs.toFixed(3)} / ${value.variants['session-day-rollup'].bundle.medianMs.toFixed(3)} ms (${value.speedup.toFixed(2)}x)`);
      await new Promise(resolveRun=>setImmediate(resolveRun));
    }
    if(count<=280)result.semanticChecks=semanticChecks(dbs);
    console.log(`${label}: measuring actual replaceSessions transactions`);
    result.transactions=measureWrites(dbs,paths,options);
    result.environment={sqlite:dbs[0].connection.prepare('SELECT sqlite_version() version').get().version};
    return result;
  } finally {dbs.forEach(db=>db.close());}
}

async function main() {
  const options=optionsFor(process.argv.slice(2));
  const directory=await mkdtemp(join(tmpdir(),'agent-tracker-sql-rollup-'));
  const report={createdAtSeoul:seoulTime(),environment:{node:process.version,cpu:cpus()[0]?.model,logicalCpus:cpus().length,platform:process.platform,arch:process.arch,schema:SCHEMA_VERSION,
    sourceSha256:Object.fromEntries(['src/summary/db/queries.ts','src/summary/db/schema.ts','src/summary/db/timezone.ts','src/summary/db/sessions.ts','tests/benchmarks/sql-rollup.cjs','tests/benchmarks/sql-rollup-prototype.cjs'].map(path=>[path,sha(readFileSync(join(root,path)))]))},
    method:{...options,output:undefined,pageLimit:100,offset:0,timezone:rollup.TIMEZONE,statistics:'ANALYZE on both isolated variants',cacheKiB:4096,tempStore:'FILE',
      scope:'prepared SQL rows materialization + group COUNT; excludes prepare, EXPLAIN, fixtures, initial rollup build, full correctness comparison, IPC/UI/parsing; alternating warm-cache variants',
      sampleReason:'3 independent timed samples with at least one warmup; slow current full-history SQL and complete-group correctness execute additional untimed SQL',
      logicalRows:'matched logical aggregate input, not measured actual row/page visits',rss:'shared sequential process; observations and lifetime peak include fixtures and verification; no per-variant memory advantage claim',
      unsupported:'rollup only Asia/Seoul and includeCosts=false; other timezone/cost request transparently uses original raw SQL; capabilities and model subset/deduplicated multi-model requests outside benchmark'},
    complexity:{symbols:{N:'raw request facts',M:'raw model facts',R:'request session-day states',Rm:'model session-day states',K:'selected raw facts',S:'selected rollup states',B:'selected raw boundary facts',G:'result groups',C:'old/new changed-session facts'},
      currentRead:'indexed range O(log N + K) plus aggregation/group/sort; unfiltered O(N) provider or O(N+M) model; repeated correlated expressions increase constants',
      rollupRead:'O(log R + S + log N + B) plus grouping/sort; full range O(R) or O(Rm); session-start scalar lookup retained for session groups',
      rollupStorage:'additional O(R + Rm) fixed-size aggregate states and index key bytes; original facts retained',initialBuild:'scan raw sources plus group B-tree/sort, conservatively O((N+M) log(N+M))',
      replacement:'original full session replacement retained; candidate additionally deletes old affected aggregate states and scans only new affected-session facts O(C_new) plus index/group writes; index B-tree maintenance and existing validation/pricing common',
      worstCase:'one turn per session/day/model yields R≈N and Rm≈M, no row compression; added persistent aggregate state/write cost may outweigh reads',
      empiricalLimit:'analytical growth model, finite scale measurements do not prove asymptotic bounds; SQLite sort scratch and group-state memory not fully measured'},datasets:[]};
  try {
    for(const count of options.sizes)for(const turns of options.turnsPerSession) {
      report.datasets.push(await runDataset(directory,count,turns,options));
      await mkdir(dirname(options.output),{recursive:true});await writeFile(options.output,JSON.stringify(report,null,2)+'\n');
    }
    if(options.worstCase&&!options.turnsPerSession.includes(1)) {
      report.datasets.push(await runDataset(directory,Math.min(...options.sizes),1,options));
      await writeFile(options.output,JSON.stringify(report,null,2)+'\n');
    }
    console.log(`Saved ${options.output}; all full-group results matched`);
  } finally {
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('agent-tracker-sql-rollup-'));
    await rm(directory,{recursive:true,force:true});
  }
}

if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={optionsFor,seed,compareResults,semanticChecks};
