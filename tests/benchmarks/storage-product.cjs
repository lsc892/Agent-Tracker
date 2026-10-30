// 고정한 실제 제품 빌드와 같은 DB 사본으로 월 PK·선택적 묶음 저장을 단계별 비교한다.
const assert = require('node:assert/strict');
const { readFileSync, existsSync, statSync } = require('node:fs');
const { mkdir, mkdtemp, copyFile, writeFile, rm, readdir } = require('node:fs/promises');
const { join, resolve, dirname, sep } = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync, backup } = require('node:sqlite');
const { root, seed, replacement, state, stats, order, digest, fingerprint, time, integrity } = require('./storage-ab-common.cjs');
const { compareResults } = require('./sql-rollup.cjs');
const snapshots = join(root, 'tests/.cache/storage-product-20261030');
const timezone = 'Asia/Seoul';
async function files(directory) {
  const result = [];
  for (const e of await readdir(directory, { withFileTypes: true })) {
    const p = join(directory,e.name); if(e.isDirectory()) result.push(...await files(p)); else if(/\.(js|ts)$/.test(e.name)) result.push(p);
  }
  return result;
}
function sessionInput(db) {
  const s = db.connection.prepare('SELECT provider,session_id FROM turn_summary GROUP BY provider,session_id ORDER BY count(*) DESC,provider,session_id LIMIT 1').get();
  const c = db.connection;
  const models = c.prepare('SELECT model,input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens FROM turn_model_usage WHERE turn_id=? ORDER BY model');
  const caps = c.prepare('SELECT category,name,usage_count FROM turn_capability_usage WHERE turn_id=? ORDER BY category,name');
  const rows = c.prepare(`SELECT t.*,p.project_name,s.session_name,coalesce(b.billing_mode,c.billing_mode,'unknown') AS billing FROM turn_summary t
    JOIN projects p USING(project_key) JOIN sessions s ON s.provider=t.provider AND s.session_id=t.session_id
    LEFT JOIN session_billing b ON b.provider=t.provider AND b.session_id=t.session_id LEFT JOIN turn_costs c ON c.turn_id=t.id
    WHERE t.provider=? AND t.session_id=? ORDER BY t.id`).all(s.provider,s.session_id);
  return { sessions:[s],files:[],summaries:rows.map(({id,...row}) => {
    const model_usage=models.all(id); return {...row,model_usage:model_usage.length?model_usage:undefined,capability_usage:caps.all(id)};
  }) };
}
function oracle(db, api, filter, group, by, expected) {
  const raw=api.buildUsageQuery(filter,group,timezone,by), rows=db.connection.prepare(raw.sql).all(...raw.values,1000,0);
  const actual=db.queryUsagePage(filter,group,timezone,{limit:1000,offset:0},by);
  compareResults(rows,actual.rows,`raw ${group}/${by}`);
  if(expected) {compareResults(expected.rows,actual.rows,`stage ${group}/${by}`);assert.equal(actual.total,expected.total);}
  return actual;
}
function space(db) {
  db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const objects=db.connection.prepare('SELECT name,sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY name').all();
  return { liveBytes:objects.reduce((n,x)=>n+x.bytes,0), rollupBytes:objects.filter(x=>x.name.includes('usage_')).reduce((n,x)=>n+x.bytes,0),objects };
}
function monthDirectory(db) {
  if (!db.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_session_months'").get()) return undefined;
  const expected=db.connection.prepare(`SELECT provider,session_id,coalesce(agent_tracker_period(started_at_ms,?,'month'),'') AS local_month,
    min(started_at_ms) AS min_started_at_ms FROM turn_summary GROUP BY provider,session_id,local_month ORDER BY provider,session_id,local_month`).all(timezone);
  const actual=db.connection.prepare('SELECT * FROM usage_session_months ORDER BY provider,session_id,local_month').all();
  assert.deepEqual(actual,expected,'Session/month lookup directory matches raw facts');return {rows:actual.length,sha256:digest(actual)};
}
async function main() {
  const options={stages:['before','month-optimized','hybrid-optimized'],samples:5,warmup:1,sizes:[[1200,25],[6000,300],[10000,1000],[100000,100],[100000,10000]],real:true,
    output:join(root,'tests/results/benchmarks/storage-product.json')};
  for(const arg of process.argv.slice(2)) {
    const [key,value]=arg.replace(/^--/,'').split('=');
    if(key==='stages')options.stages=value.split(',');
    else if(key==='samples')options.samples=Number(value);
    else if(key==='sizes')options.sizes=value.split(',').map(s=>s.split(':').map(Number));
    else if(key==='output')options.output=resolve(value);
    else if(key==='no-real')options.real=false;
    else throw Error(`Unknown option ${key}`);
  }
  assert.ok(options.samples>=3&&options.samples<=15);
  const apis=options.stages.map(stage=>{
    const p=join(snapshots,stage,'dist/src/summary');
    return {stage,SummaryDatabase:require(join(p,'db')).SummaryDatabase,...require(join(p,'db/queries')),
      buildRollupUsageQueries:require(join(p,'db/rollup-queries')).buildRollupUsageQueries};
  });
  const sourceFiles=[__filename,join(__dirname,'storage-ab-common.cjs'),join(__dirname,'sql-rollup.cjs')];
  for(const stage of options.stages) sourceFiles.push(...await files(join(snapshots,stage,'dist/src/summary')),...await files(join(snapshots,stage,'src/summary')));
  const hashes=fingerprint(sourceFiles);
  const report={startedSeoul:time(),runtime:{node:process.version,sqlite:process.versions.sqlite},options,sourceSha256:hashes,datasets:[],
    scope:'actual frozen product APIs, same input, warm rotated order, synthetic plus read-only installed DB backup; no source logs/account calls; no installed DB mutation'};
  await mkdir(join(root,'tests/results/benchmarks'),{recursive:true});
  const directory=await mkdtemp(join(root,'tests/results/benchmarks/product-storage-'));
  try {
    const datasets=options.sizes.map(([requests,turns])=>({name:`synthetic-${requests}-${turns}`,requests,turns}));
    const installed=join(process.env.APPDATA,'Code/User/globalStorage/agenttracker.agent-tracker/agent-tracker.sqlite');
    if(options.real&&existsSync(installed)) {
      const frozen=join(directory,'installed-input.sqlite'), input=new DatabaseSync(installed,{readOnly:true});
      try {await backup(input,frozen);} finally {input.close();}
      datasets.push({name:'installed-snapshot',frozen});
    }
    for(const dataset of datasets) {
      console.log(`${time()} ${dataset.name}`);
      const template=dataset.frozen??join(directory,`${dataset.name}-template.sqlite`);
      if(!dataset.frozen) {
        const db=new apis[0].SummaryDatabase(template);
        try{seed(db,dataset.requests,dataset.turns);}finally{db.close();}
      }
      const paths=[],dbs=[],openMs=[];
      try {
        for(const api of apis) {
          const path=join(directory,`${dataset.name}-${api.stage}.sqlite`);await copyFile(template,path);paths.push(path);
          const start=performance.now();dbs.push(new api.SummaryDatabase(path));openMs.push(performance.now()-start);
        }
        const input=sessionInput(dbs[0]), selected=input.sessions[0];
        const first=dbs[0].connection.prepare('SELECT min(started_at_ms) AS first FROM turn_summary WHERE started_at_ms IS NOT NULL').get().first;
        const date=new Date(first??Date.UTC(2026,9,1)); const fromMs=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1)-9*3600000;
        const toMs=Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)-9*3600000;
        const project=input.summaries[0].project_key;
        const initialBuildMs=dbs.map(db=>{const s=performance.now();db.queryUsagePage({},'month',timezone,{limit:1000,offset:0},'provider');return performance.now()-s;});
        const reads=[];
        for(const by of ['provider','model']) for(const [name,filter,group] of [
          ['all-months',{},'month'],['one-month',{fromMs,toMs},'month'],['one-month-known',{fromMs,toMs,unknownTime:'exclude'},'month'],
          ['project-month',{fromMs,toMs,provider:selected.provider,projectKey:project},'month'],
          ['selected-session',{provider:selected.provider,sessionId:selected.session_id},'session']]) {
          const expected=oracle(dbs[0],apis[0],filter,group,by),samples=dbs.map(()=>[]);
          dbs.forEach((db,i)=>oracle(db,apis[i],filter,group,by,expected));
          const run=i=>{const start=performance.now();dbs[i].queryUsagePage(filter,group,timezone,{limit:1000,offset:0},by);return performance.now()-start;};
          for(let round=-options.warmup;round<options.samples;round++)for(const i of order(dbs.length,Math.abs(round))){const ms=run(i);if(round>=0)samples[i].push(ms);}
          reads.push({name,by,group,groups:expected.total,resultSha256:digest(expected),variants:Object.fromEntries(apis.map((api,i)=>{
            const q=api.buildRollupUsageQueries(filter,group,timezone,by);
            return [api.stage,{latency:stats(samples[i]),plan:q?dbs[i].connection.prepare(`EXPLAIN QUERY PLAN ${q.rows.sql}`).all(...q.rows.values,1000,0).map(r=>r.detail):[]}];
          }))});
        }
        const append=structuredClone(input), extra=structuredClone(input.summaries.at(-1));extra.root_turn_id='product-benchmark-appended';append.summaries.push(extra);
        const moved=structuredClone(input);moved.summaries[0].started_at_ms=Date.UTC(2026,0,1);moved.summaries[0].completed_at_ms=Date.UTC(2026,0,1)+1000;
        const deleted=structuredClone(input);deleted.summaries.pop();
        const changed=structuredClone(input);changed.summaries.forEach(r=>{r.request_title='Benchmark changed title';r.capability_usage=[{category:'skill',name:'benchmark-changed',usage_count:2}];});
        const writes=[];
        for(const [name,value] of [['initial',input],['same',input],['append',append],['date-move',moved],['delete',deleted],['all-changed',changed]]) {
          const samples=dbs.map(()=>[]);
          for(let round=-options.warmup;round<options.samples;round++)for(const i of order(dbs.length,Math.abs(round))) {
            dbs[i].replaceSessions(structuredClone(name==='initial'?{sessions:input.sessions,files:[],summaries:[]}:input));
            dbs[i].connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            const start=performance.now();dbs[i].replaceSessions(structuredClone(value));const elapsedMs=performance.now()-start;
            if(round>=0)samples[i].push({elapsedMs,walBytes:statSync(paths[i]+'-wal').size,
              tempAllocatedBytes:dbs[i].connection.prepare('PRAGMA temp.page_count').get().page_count*dbs[i].connection.prepare('PRAGMA temp.page_size').get().page_size});
          }
          const expected=state(dbs[0]);
          dbs.forEach((db,i)=>{assert.deepEqual(state(db),expected,`${dataset.name}/${name}/${apis[i].stage}`);
            for(const by of ['provider','model'])oracle(db,apis[i],{provider:selected.provider,sessionId:selected.session_id},'month',by);});
          writes.push({name,hashes:expected,variants:Object.fromEntries(apis.map((api,i)=>[api.stage,{latency:stats(samples[i].map(v=>v.elapsedMs)),samples:samples[i]}]))});
        }
        dbs.forEach(db=>{db.replaceSessions(structuredClone(input));integrity(db);});
        const counts=dbs[0].connection.prepare('SELECT count(*) requests,count(DISTINCT session_id) sessions FROM turn_summary').get();
        report.datasets.push({name:dataset.name,counts,selectedSessionTurns:input.summaries.length,reads,writes,
          variants:Object.fromEntries(apis.map((api,i)=>[api.stage,{openMs:openMs[i],initialReadMs:initialBuildMs[i],space:space(dbs[i]),monthDirectory:monthDirectory(dbs[i])}]))});
        await mkdir(dirname(options.output),{recursive:true});await writeFile(options.output,JSON.stringify(report,null,2)+'\n');
      } finally {dbs.forEach(db=>db.close());}
    }
    assert.deepEqual(fingerprint(sourceFiles),hashes,'Frozen product build changed');
    report.completedSeoul=time();await writeFile(options.output,JSON.stringify(report,null,2)+'\n');console.log(`Saved ${options.output}`);
  } finally {assert.equal(dirname(resolve(directory)),resolve(root,'tests/results/benchmarks'));assert.ok(resolve(directory).startsWith(resolve(root,'tests/results/benchmarks')+sep));await rm(directory,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
