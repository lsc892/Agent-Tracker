// 세션/월 PK와 일괄/묶음 반영의 저장 호출·쓰기 트랜잭션 시간을 같은 입력으로 비교한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync, backup } = require('node:sqlite');
const { root, seed, state, stats, order, fingerprint, time, integrity } = require('./storage-ab-common.cjs');
const { compareResults } = require('./sql-rollup.cjs');
const snapshots = join(root, 'tests/.cache/storage-product-20261030');
const timezone = 'Asia/Seoul';

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes:true }).flatMap(e => e.isDirectory()
    ? files(join(directory,e.name)) : /\.(ts|js)$/.test(e.name) ? [join(directory,e.name)] : []);
}

function input(db) {
  const c=db.connection;
  const selected=c.prepare('SELECT provider,session_id FROM turn_summary GROUP BY provider,session_id ORDER BY count(*) DESC,provider,session_id LIMIT 1').get();
  const models=c.prepare('SELECT model,input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens FROM turn_model_usage WHERE turn_id=? ORDER BY model');
  const caps=c.prepare('SELECT category,name,usage_count FROM turn_capability_usage WHERE turn_id=? ORDER BY category,name');
  const rows=c.prepare(`SELECT t.*,p.project_name,s.session_name,coalesce(b.billing_mode,c.billing_mode,'unknown') AS billing
    FROM turn_summary t JOIN projects p USING(project_key) JOIN sessions s ON s.provider=t.provider AND s.session_id=t.session_id
    LEFT JOIN session_billing b ON b.provider=t.provider AND b.session_id=t.session_id LEFT JOIN turn_costs c ON c.turn_id=t.id
    WHERE t.provider=? AND t.session_id=? ORDER BY t.id`).all(selected.provider,selected.session_id);
  return {sessions:[selected],files:[],summaries:rows.map(({id,...r})=>{
    const model_usage=models.all(id);return {...r,model_usage:model_usage.length?model_usage:undefined,capability_usage:caps.all(id)};
  })};
}

function observe(db) {
  const exec=db.connection.exec.bind(db.connection);
  const monitor={current:undefined,beginStart:0,acquired:0};
  db.connection.exec=sql=>{
    if (!monitor.current) return exec(sql);
    if (sql==='BEGIN IMMEDIATE') {
      monitor.beginStart=performance.now();const result=exec(sql);monitor.acquired=performance.now();
      monitor.current.beginMs=monitor.acquired-monitor.beginStart;return result;
    }
    const result=exec(sql);
    if (sql==='COMMIT') {
      const end=performance.now();monitor.current.transactionMs=end-monitor.beginStart;
      monitor.current.writeSpanMs=end-monitor.acquired;
    }
    return result;
  };
  const rollups=db.sqlite.rollups,refresh=rollups.refreshChangedSessions.bind(rollups);
  rollups.refreshChangedSessions=()=>{
    const start=performance.now();try{return refresh();}finally{if(monitor.current)monitor.current.rollupMs+=performance.now()-start;}
  };
  return monitor;
}

async function main() {
  const options={stages:['before','month-optimized','hybrid-optimized','session-batch'],samples:5,warmup:1,
    sizes:[[10000,1000],[100000,100],[100000,10000]],real:true,
    output:resolve('docs/benchmarks/2026-10-31/StorageTransactions-2026-10-31.json')};
  for(const arg of process.argv.slice(2)) {
    const [key,value]=arg.replace(/^--/,'').split('=');
    if(key==='samples')options.samples=Number(value);
    else if(key==='sizes')options.sizes=value.split(',').map(s=>s.split(':').map(Number));
    else if(key==='no-real')options.real=false;
    else if(key==='output')options.output=resolve(value);
    else throw Error(`Unknown option ${key}`);
  }
  assert.ok(options.samples>=3);
  const apis=options.stages.map(stage=>({stage,...require(join(snapshots,stage,'dist/src/summary/db')),
    ...require(join(snapshots,stage,'dist/src/summary/db/queries'))}));
  const measuredFiles=[__filename,join(__dirname,'storage-ab-common.cjs'),join(__dirname,'sql-rollup.cjs')];
  for(const stage of options.stages)for(const sub of ['src/summary','dist/src/summary'])measuredFiles.push(...files(join(snapshots,stage,sub)));
  const hashes=fingerprint(measuredFiles);
  const report={startedSeoul:time(),runtime:{node:process.version,sqlite:process.versions.sqlite},options,sourceSha256:hashes,datasets:[],
    scope:'same frozen product inputs; BEGIN IMMEDIATE entry/success to COMMIT return; uncontended writer; no parser, worker, account calls or installed database writes'};
  const base=join(root,'tests/results/benchmarks');fs.mkdirSync(base,{recursive:true});
  const directory=fs.mkdtempSync(join(base,'storage-transactions-'));
  try {
    const datasets=options.sizes.map(([requests,turns])=>({name:`synthetic-${requests}-${turns}`,requests,turns}));
    const installed=join(process.env.APPDATA,'Code/User/globalStorage/agenttracker.agent-tracker/agent-tracker.sqlite');
    if(options.real&&fs.existsSync(installed)) {
      const frozen=join(directory,'installed-input.sqlite'),db=new DatabaseSync(installed,{readOnly:true});
      try{await backup(db,frozen);}finally{db.close();}datasets.push({name:'installed-snapshot',frozen});
    }
    for(const dataset of datasets) {
      console.log(`${time()} ${dataset.name}`);
      const template=dataset.frozen??join(directory,'template.sqlite');
      if(!dataset.frozen){const db=new apis[0].SummaryDatabase(template);try{seed(db,dataset.requests,dataset.turns);}finally{db.close();}}
      const dbs=[],paths=[],monitors=[];
      try {
        for(const api of apis){const path=join(directory,`${api.stage}.sqlite`);fs.copyFileSync(template,path);paths.push(path);
          const db=new api.SummaryDatabase(path);db.queryUsage({},'month',timezone);dbs.push(db);monitors.push(observe(db));}
        const original=input(dbs[0]);
        const append=structuredClone(original),added=structuredClone(original.summaries.at(-1));
        added.root_turn_id='transaction-benchmark-added';append.summaries.push(added);
        const dense=structuredClone(original);dense.summaries.forEach(r=>{r.request_title='Changed';r.capability_usage=[{category:'skill',name:'changed',usage_count:2}];});
        const writes=[];
        for(const [name,value]of [['same',original],['append',append],['all-changed',dense]]) {
          const samples=dbs.map(()=>[]);
          for(let round=-options.warmup;round<options.samples;round++)for(const i of order(dbs.length,Math.abs(round))) {
            dbs[i].replaceSessions(structuredClone(original));dbs[i].connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            const record={beginMs:0,transactionMs:0,writeSpanMs:0,rollupMs:0};
            monitors[i].current=record;const start=performance.now();
            try{dbs[i].replaceSessions(structuredClone(value));}finally{record.totalMs=performance.now()-start;monitors[i].current=undefined;}
            assert.ok(record.transactionMs>0);assert.ok(record.totalMs>=record.transactionMs);
            record.walBytes=fs.statSync(paths[i]+'-wal').size;
            record.tempAllocatedBytes=dbs[i].connection.prepare('PRAGMA temp.page_count').get().page_count*dbs[i].connection.prepare('PRAGMA temp.page_size').get().page_size;
            if(round>=0)samples[i].push(record);
          }
          const expected=state(dbs[0]);
          dbs.forEach((db,i)=>{
            assert.deepEqual(state(db),expected,`${dataset.name}/${name}/${apis[i].stage}`);
            for(const by of ['provider','model']){
              const filter={...original.sessions[0]},raw=apis[i].buildUsageQuery({provider:filter.provider,sessionId:filter.session_id},'month',timezone,by);
              compareResults(db.connection.prepare(raw.sql).all(...raw.values,1000,0),db.queryUsage({provider:filter.provider,sessionId:filter.session_id},'month',timezone,{limit:1000},by),`${name}/${by}`);
            }
          });
          writes.push({name,hashes:expected,variants:Object.fromEntries(apis.map((api,i)=>[api.stage,{samples:samples[i],
            ...Object.fromEntries(['beginMs','transactionMs','writeSpanMs','rollupMs','totalMs'].map(key=>[key,stats(samples[i].map(v=>v[key]))]))}]))});
        }
        const variants={};
        for(let i=0;i<dbs.length;i++){
          const db=dbs[i];db.replaceSessions(structuredClone(original));integrity(db);db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          const objects=db.connection.prepare('SELECT name,sum(pgsize) AS bytes FROM dbstat GROUP BY name').all();
          variants[apis[i].stage]={liveBytes:objects.reduce((n,o)=>n+o.bytes,0),rollupBytes:objects.filter(o=>o.name.includes('usage_')).reduce((n,o)=>n+o.bytes,0)};
        }
        report.datasets.push({name:dataset.name,counts:dbs[0].connection.prepare('SELECT count(*) AS requests,count(DISTINCT session_id) AS sessions FROM turn_summary').get(),
          selectedSessionTurns:original.summaries.length,writes,variants});
        fs.mkdirSync(dirname(options.output),{recursive:true});fs.writeFileSync(options.output,JSON.stringify(report,null,2)+'\n');
      }finally{dbs.forEach(db=>db.close());}
      if(!dataset.frozen)for(const suffix of ['','-wal','-shm'])if(fs.existsSync(template+suffix))fs.unlinkSync(template+suffix);
    }
    assert.deepEqual(fingerprint(measuredFiles),hashes);report.completedSeoul=time();fs.writeFileSync(options.output,JSON.stringify(report,null,2)+'\n');console.log(`Saved ${options.output}`);
  }finally{assert.equal(dirname(resolve(directory)),resolve(base));fs.rmSync(directory,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
