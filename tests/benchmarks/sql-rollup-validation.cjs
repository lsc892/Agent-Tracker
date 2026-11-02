// 독립 합성 데이터로 롤업 시제품의 평균·필터·집계 의미를 검증한다.
// Deterministic semantic/rollback checks independent of benchmark timing.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const { buildUsageQuery } = require('../../dist/src/summary/db/queries');
const rollup = require('./sql-rollup-prototype.cjs');
const { compareResults } = require('./sql-rollup.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');

function fixture() {
  const values = [
    [100,10,'completed',10,'exact','A',null,20],
    [0,0,'completed',null,'derived','A',0,0],
    [0,0,'completed',null,'missing',null,0,0],
    [50,5,'failed',null,'missing','B',0,0],
    [20,2,'in_progress',null,'missing','',0,0],
    [200,20,'completed',30,'approximate','AB',0,0],
    [0,0,'completed',50,'exact','',0,0],
    [10,1,'completed',10,'exact',null,0,0],
  ];
  const summaries=values.map(([input,output,status,duration,quality,model,cacheWrite,cacheRead],index)=>({
    provider:'claude',project_key:'/fixture/project',project_name:'project',session_id:'fixture-session',session_name:'fixture',root_turn_id:`turn-${index}`,
    started_at_ms:[2,6].includes(index)?null:Date.UTC(2026,6,1+index%3,2),duration_ms:duration,duration_quality:quality,input_tokens:input,output_tokens:output,total_tokens:input+output,
    cache_write_input_tokens:cacheWrite,cache_read_input_tokens:cacheRead,status,updated_at:'2026-10-15T00:00:00.000Z',last_error:index===7?'fixture stale':null,
    model_usage:model===null?undefined:model==='AB'?[
      {model:'A',input_tokens:150,output_tokens:15,cache_write_input_tokens:0,cache_read_input_tokens:0},
      {model:'B',input_tokens:50,output_tokens:5,cache_write_input_tokens:0,cache_read_input_tokens:0},
    ]:[{model,input_tokens:input,output_tokens:output,cache_write_input_tokens:cacheWrite,cache_read_input_tokens:cacheRead}],
  }));
  return {sessions:[{provider:'claude',session_id:'fixture-session'}],files:[],summaries};
}

function allRows(db,query) {return db.connection.prepare(query.sql).all(...query.values,10000000,0);}
function fullSnapshot(db) {
  const names=db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  return sha(JSON.stringify(names.map(name=>[name,db.connection.prepare(`SELECT * FROM ${name}`).all()])));
}

function runValidation() {
  const db=new SummaryDatabase(':memory:');
  try {
    const input=fixture();db.replaceSessions(input);rollup.install(db);db.transaction(()=>rollup.refresh(db));
    for(const excludeEmptyUsage of [false,true]) {
      const row=allRows(db,rollup.build({excludeEmptyUsage},'total',rollup.TIMEZONE,'provider').rows)[0];
      assert.equal(row.total_tokens,418);assert.equal(row.turn_count,8);assert.equal(row.completed_turns,6);
      assert.equal(row.recorded_turns,6);assert.equal(row.recorded_completed_turns,4);
      assert.equal(row.avg_tokens_per_turn,excludeEmptyUsage?85.25:341/6);
      assert.equal(row.avg_duration_ms,excludeEmptyUsage?50/3:25);
      assert.equal(row.turns_with_duration,excludeEmptyUsage?3:4);
      assert.equal(row.derived_duration_turns,1);assert.equal(row.approximate_duration_turns,1);
      assert.equal(row.exact_duration_turns,excludeEmptyUsage?2:3);
      assert.equal(row.missing_duration_turns,excludeEmptyUsage?1:2);
      assert.equal(row.cache_write_input_tokens,null);assert.equal(row.avg_cache_write_input_tokens,null);
      assert.equal(row.unknown_time_turns,2);assert.equal(row.stale_turns,1);
    }
    let compared=0;
    for(const by of ['provider','model'])for(const groupBy of ['total','day','month','project','session'])for(const excludeEmptyUsage of [false,true])for(const unknownTime of [undefined,'include','exclude','only']) {
      const filter={excludeEmptyUsage,unknownTime,fromMs:Date.UTC(2026,6,1,1),toMs:Date.UTC(2026,6,3,3)};
      compareResults(allRows(db,buildUsageQuery(filter,groupBy,rollup.TIMEZONE,by)),allRows(db,rollup.build(filter,groupBy,rollup.TIMEZONE,by).rows),`independent fixture ${compared++}`);
    }
    for(const fromMs of [1.5,Number.NaN,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>rollup.build({fromMs},'total',rollup.TIMEZONE,'provider'),RangeError);
    assert.equal(rollup.build({fromMs:Number.MAX_SAFE_INTEGER},'total',rollup.TIMEZONE,'provider').mode,'raw-fallback');
    const before=fullSnapshot(db),changed=structuredClone(input);
    const extra=structuredClone(changed.summaries[0]);extra.root_turn_id='new-turn';extra.project_key='/fixture/moved';extra.project_name='moved';changed.summaries.push(extra);
    const originalExec=db.connection.exec;
    let refreshed=false;
    db.connection.exec=function(sql){
      if(sql.trim()==='COMMIT') {
        rollup.refresh(db,changed.sessions);refreshed=true;
        assert.notEqual(fullSnapshot(db),before);
        throw new Error('failure after detail and both rollups changed');
      }
      return originalExec.call(this,sql);
    };
    try {assert.throws(()=>db.replaceSessions(changed),/failure after detail/);}
    finally {db.connection.exec=originalExec;}
    assert.equal(refreshed,true);assert.equal(fullSnapshot(db),before);
    return {independentExpectedTotalsAndAverages:true,fullGroupCases:compared,integerRangeValidation:true,
      fullPersistentTableRollbackAfterBothRollupsChanged:true,
      rollbackScope:'all columns/all rows of every persistent table, including projects, sessions, details, model usage, turn costs and both rollups; changed snapshots asserted before injected failure',
      sourceSha256:sha(readFileSync(__filename)),prototypeSha256:sha(readFileSync(resolve(__dirname,'sql-rollup-prototype.cjs')))};
  } finally {db.close();}
}

if(require.main===module) {
  const result=runValidation();
  if(process.argv[2]==='--append') {
    const path=resolve(__dirname,'../../docs/benchmarks/2026-10-15/SqlRollupABBenchmark-2026-10-15.json');
    const report=JSON.parse(readFileSync(path,'utf8'));
    report.supplementaryValidation=result;
    writeFileSync(path,JSON.stringify(report,null,2)+'\n');
  }
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
module.exports={runValidation};
