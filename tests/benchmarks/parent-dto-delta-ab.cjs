// 현재 실제 JSONL 고정 사본에서 부모 DTO 차분 집계의 저장·조회 비용을 비교한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { resolve, join, basename } = require('node:path');
const { fork } = require('node:child_process');
const { cpus } = require('node:os');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const helpers = require('./incremental-refresh.cjs');
const { allUsage, independentCheck, fingerprints, digest, stats } = require('./temp-batch-ab.cjs');
const groups = ['day', 'month', 'session', 'project'];
const filter = { fromMs: -8640000000000000, toMs: 8640000000000000, unknownTime: 'include', excludeEmptyUsage: true };
const seoul = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const sha = value => createHash('sha256').update(value).digest('hex');

function checked(db, buildUsageQuery) {
  const verified = helpers.verify(db, buildUsageQuery);
  const totals = db.connection.prepare(`SELECT count(*) requests,coalesce(sum(input_tokens),0) input,
    coalesce(sum(output_tokens),0) output,coalesce(sum(total_tokens),0) tokens FROM turn_summary`).get();
  const rows = db.connection.prepare('SELECT * FROM turn_summary ORDER BY provider,session_id,root_turn_id').all();
  const modelTotals = db.connection.prepare(`SELECT t.provider,u.model,sum(u.input_tokens) input,sum(u.output_tokens) output,
    sum(u.cache_read_input_tokens) cacheRead,sum(u.cache_write_input_tokens) cacheWrite
    FROM turn_summary t JOIN turn_model_usage u ON u.turn_id=t.id GROUP BY t.provider,u.model ORDER BY t.provider,u.model`).all();
  const queries = Object.fromEntries(groups.map(group => [group, independentCheck(db, filter, group, allUsage(db, group, filter))]));
  const safeRows = rows.map(row => ({ key: sha(JSON.stringify([row.provider,row.session_id,row.root_turn_id])), provider: row.provider,
    session: sha(JSON.stringify([row.provider,row.session_id])), root: sha(JSON.stringify([row.provider,row.root_turn_id])),
    input:row.input_tokens,output:row.output_tokens,tokens:row.total_tokens,cacheRead:row.cache_read_input_tokens,
    cacheWrite:row.cache_write_input_tokens,status:row.status }));
  return { ...totals, factsSha256:digest(rows.map(helpers.normalized)), allFactsSha256:verified.factsSha256, modelsSha256:digest(modelTotals), modelTotals,
    aggregatesSha256:verified.aggregatesSha256, rawChecks:verified.rawChecks, queries, safeRows };
}

async function worker(workspace, variant, work) {
  const config = JSON.parse(fs.readFileSync(join(workspace,'config.json'),'utf8'));
  const product = config.products[variant];
  const { SummaryDatabase } = require(join(product,'dist/src/summary/db'));
  const { refreshSummary } = require(join(product,'dist/src/summary/scanner'));
  const { buildUsageQuery } = require(join(product,'dist/src/summary/db/queries'));
  await fsp.mkdir(work,{recursive:true});
  const dbPath = join(work,'summary.sqlite'),db = new SummaryDatabase(dbPath),samples={};
  async function refresh(name) {
    global.gc?.();
    const start=performance.now();
    const result=await refreshSummary(db,{dbPath,roots:config.roots,timezone:'Asia/Seoul'});
    const ms=performance.now()-start;
    assert.equal(result.interrupted,false); assert.equal(result.error,undefined); assert.equal(result.failed,0);
    samples[name]={ms,parsed:result.parsed,bodyBytes:result.bodyBytes,failed:result.failed};
  }
  try {
    await refresh('initial');
    const initial=checked(db,buildUsageQuery);
    db.connection.exec('UPDATE manifest SET parser_version=0');
    await refresh('reparse');
    const reparsed=checked(db,buildUsageQuery);
    assert.deepEqual(reparsed,initial,'Same input reparse must keep facts and aggregates');
    await refresh('unchanged'); assert.equal(samples.unchanged.bodyBytes,0);
    const reads={};
    for(const group of groups){
      allUsage(db,group,filter);
      const start=performance.now(),result=allUsage(db,group,filter);
      const ms=performance.now()-start;
      independentCheck(db,filter,group,result);
      reads[group]={ms,rows:result.length,sha256:digest(result.map(helpers.normalized))};
    }
    process.send({result:{samples,initial,reads,sqlite:db.connection.prepare('SELECT sqlite_version() v').get().v}});
  } finally {db.close();}
}

async function run(workspace,variant,pair){
  return new Promise((done,fail)=>{
    const work=join(workspace,'runs',`pair-${pair}`,variant);
    const child=fork(__filename,['--worker',workspace,variant,work],{
      execArgv:['--expose-gc','--no-warnings'],stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,
    });
    let result,error='';
    child.stderr.on('data',data=>error+=data);
    child.on('message',message=>{result=message.result;});
    child.on('error',fail);
    child.on('exit',code=>{
      if(code!==0||!result)return fail(new Error(error.slice(-2500)||`Worker failed ${code}`));
      console.log(`${pair}/${variant}: initial=${result.samples.initial.ms.toFixed(2)} reparse=${result.samples.reparse.ms.toFixed(2)} requests=${result.initial.requests} tokens=${result.initial.tokens}`);
      done(result);
    });
  });
}

function comparison(a,b){
  const before=new Map(a.safeRows.map(row=>[row.key,row])),after=new Map(b.safeRows.map(row=>[row.key,row]));
  const removed=a.safeRows.filter(row=>!after.has(row.key)),added=b.safeRows.filter(row=>!before.has(row.key));
  const changed=b.safeRows.filter(row=>before.has(row.key)&&digest(row)!==digest(before.get(row.key)))
    .map(row=>({before:before.get(row.key),after:row}));
  return {totalsEqual:[a.input,a.output,a.tokens].every((value,index)=>value===[b.input,b.output,b.tokens][index]),
    modelTotalsEqual:a.modelsSha256===b.modelsSha256,factsEqual:a.factsSha256===b.factsSha256,
    aggregatesEqual:a.aggregatesSha256===b.aggregatesSha256,removed,added,changed};
}

async function main(){
  const options=Object.fromEntries(process.argv.slice(2).filter(arg=>arg.startsWith('--')&&arg.includes('=')).map(arg=>{
    const i=arg.indexOf('=');return [arg.slice(2,i),resolve(arg.slice(i+1))];
  }));
  assert.ok(options.workspace,'--workspace=<frozen workspace> required');
  const workspace=options.workspace,snapshot=JSON.parse(fs.readFileSync(join(workspace,'current/snapshot.json'),'utf8'));
  const products={A:join(workspace,'products/A'),B:join(workspace,'products/B')};
  if(options.after){
    assert.equal(fs.existsSync(products.B),false,'Never overwrite the frozen B build');
    await fsp.mkdir(products.B,{recursive:true});
    for(const folder of ['src','dist'])await fsp.cp(join(options.after,folder),join(products.B,folder),{recursive:true,preserveTimestamps:true});
  }
  await fsp.writeFile(join(workspace,'config.json'),JSON.stringify({products,roots:snapshot.roots,filter}));
  if(process.argv.includes('--upgrade-only')){
    const source=join(workspace,'runs/pair--1/A/summary.sqlite');
    assert.ok(!fs.existsSync(source+'-wal')||fs.statSync(source+'-wal').size===0,'Source DB must be closed and checkpointed');
    const upgradedPath=join(workspace,`upgrade-${Date.now()}.sqlite`);
    await fsp.copyFile(source,upgradedPath);
    const {SummaryDatabase}=require(join(products.B,'dist/src/summary/db'));
    const {refreshSummary}=require(join(products.B,'dist/src/summary/scanner'));
    const {buildUsageQuery}=require(join(products.B,'dist/src/summary/db/queries'));
    const upgraded=new SummaryDatabase(upgradedPath),fresh=new SummaryDatabase(join(workspace,'runs/pair--1/B/summary.sqlite'));
    const before=checked(upgraded,buildUsageQuery);
    const refresh=await refreshSummary(upgraded,{dbPath:upgradedPath,roots:snapshot.roots,timezone:'Asia/Seoul'});
    assert.equal(refresh.failed,0);assert.equal(refresh.interrupted,false);
    const after=checked(upgraded,buildUsageQuery),expected=checked(fresh,buildUsageQuery);
    assert.deepEqual(after,expected,'A DB refreshed by B must match a fresh B DB');
    const versions=upgraded.connection.prepare('SELECT parser_version,count(*) files FROM manifest GROUP BY parser_version ORDER BY parser_version').all();
    const result={before:{requests:before.requests,tokens:before.tokens},after:{requests:after.requests,tokens:after.tokens},
      failed:refresh.failed,parsed:refresh.parsed,bodyBytes:refresh.bodyBytes,versions,
      allFactsModelsToolsCostsNamesManifestMatchFreshB:true,allTenAggregatesMatchFreshB:true,
      perRequestTokenCacheVectorsMatchFreshB:true,independentJsAverages:true,foreignKeysAndIntegrity:true};
    await fsp.writeFile(join(workspace,'parent-dto-upgrade-result.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result,null,2));upgraded.close();fresh.close();return;
  }
  if(process.argv.includes('--baseline-only')){
    const result=await run(workspace,'A','baseline');
    await fsp.writeFile(join(workspace,'baseline-result.json'),JSON.stringify(result,null,2));return;
  }
  assert.ok(options.output,'--output=<new JSON> required');assert.equal(fs.existsSync(options.output),false,'Never overwrite measurements');
  const report={startedAtSeoul:seoul(),scope:'Current real snapshot only; one warmup pair and three alternating measured pairs. No synthetic data, added request, full suite, live quota, UI, or installation.',
    command:`node --no-warnings tests/benchmarks/parent-dto-delta-ab.cjs --workspace=<private frozen workspace> --output=<new JSON>`,
    runnerSha256:sha(fs.readFileSync(__filename)),helperHashes:Object.fromEntries(['incremental-refresh.cjs','temp-batch-ab.cjs'].map(file=>[file,sha(fs.readFileSync(join(__dirname,file)))])),
    builds:Object.fromEntries(['A','B'].map(variant=>[variant,fingerprints(products[variant],'dist/src')])),
    sources:Object.fromEntries(['A','B'].map(variant=>[variant,fingerprints(products[variant],'src')])),
    inputSha256:snapshot.sha256,inventory:snapshot.inventory,filter,warmups:1,pairs:3,
    environment:{platform:process.platform,node:process.version,cpu:cpus()[0]?.model,timezone:'Asia/Seoul'},trials:[]};
  for(let pair=-1;pair<3;pair++){
    const both={};
    for(const variant of (pair+1)%2?['B','A']:['A','B'])both[variant]=await run(workspace,variant,pair);
    const compared=comparison(both.A.initial,both.B.initial);
    if(pair===-1){report.warmupComparison=compared;report.baseline={A:both.A.initial,B:both.B.initial};}
    else report.trials.push({pair,...both,comparison:compared});
    report.environment.sqlite=both.A.sqlite;
    await fsp.writeFile(options.output+'.partial',JSON.stringify(report,null,2));
  }
  report.summary={};
  for(const metric of ['initial','reparse','unchanged',...groups]){
    const value=Object.fromEntries(['A','B'].map(variant=>[variant,stats(report.trials.map(trial=>groups.includes(metric)?trial[variant].reads[metric].ms:trial[variant].samples[metric].ms))]));
    value.improvementPercent=(value.A.medianMs-value.B.medianMs)/value.A.medianMs*100;report.summary[metric]=value;
  }
  for(const file of snapshot.files)assert.equal(sha(fs.readFileSync(file.path)),file.sha256,'Frozen input unchanged');
  report.completedAtSeoul=seoul();report.frozenInputUnchanged=true;
  // Per-request hashed differences are recorded once; omit duplicate row inventories from each timed trial.
  for(const trial of report.trials)for(const variant of ['A','B'])delete trial[variant].initial.safeRows;
  for(const variant of ['A','B'])delete report.baseline[variant].safeRows;
  await fsp.writeFile(options.output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  await fsp.unlink(options.output+'.partial');
  console.log(`Saved ${basename(options.output)}`);
}

if(process.argv[2]==='--worker')worker(...process.argv.slice(3)).catch(error=>{console.error(error);process.exitCode=1;});
else if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
