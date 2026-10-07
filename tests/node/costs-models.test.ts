import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SummaryDatabase, type TurnSummaryInput } from '../../src/summary/db';
import { SummaryClient } from '../../src/summary/client';
import { refreshSummary } from '../../src/summary/scanner';
import { estimateCost, PRICING_VERSION } from '../../src/summary/pricing';
import { parseDashboardMessage } from '../../src/ui/presentation';

const text = (rows: unknown[]): string => rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
const user = {type:'user',sessionId:'session',promptId:'request',timestamp:'2026-10-03T00:00:00Z',cwd:'/project'};
const response = (id: string, model: string, input = 50): Record<string,unknown> => ({
  type:'assistant',promptId:'request',requestId:id,timestamp:'2026-10-03T00:00:01Z',
  message:{id,model,stop_reason:'end_turn',usage:{input_tokens:input,output_tokens:50,cache_creation_input_tokens:20,cache_read_input_tokens:30}},
});

test('model totals deduplicate whole responses, retain subagent models and preserve billing through rebuilds and failures',async t => {
  const directory = await mkdtemp(join(tmpdir(),'tracker-costs-'));
  const root = join(directory,'projects');
  await mkdir(join(root,'session','subagents'),{recursive:true});
  const options = {dbPath:join(directory,'summary.sqlite'),roots:[{provider:'claude' as const,path:root}]};
  let db = new SummaryDatabase(options.dbPath);
  t.after(async()=>{db.close();await rm(directory,{recursive:true,force:true});});
  const file = join(root,'session.jsonl');
  await writeFile(file,text([user,response('one','claude-sonnet-4-6'),response('one','claude-sonnet-4-6'),response('two','claude-opus-4-6')]));
  await writeFile(join(root,'session','subagents','child.jsonl'),text([user,response('child','claude-haiku-4-5')]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  const filter = {includeCosts:true};
  let models = db.queryCumulative(filter,'model');
  assert.equal(models.total,3);
  assert.equal(models.rows.reduce((sum,row)=>sum+row.total_tokens,0),450);
  assert.equal(db.queryCumulative(filter,'provider').rows[0].total_tokens,450);
  assert.ok(models.rows.every(row=>row.cost_usd === null && row.unknown_costs===1));
  db.setSessionBilling('claude','session','api');
  const expected = 0.000984+0.00164+0.000328;
  models = db.queryCumulative(filter,'model');
  assert.ok(Math.abs(models.rows.reduce((sum,row)=>sum+(row.cost_usd ?? 0),0)-expected)<1e-12);
  assert.ok(Math.abs(db.queryUsage(filter)[0].cost_usd!-expected)<1e-12);
  assert.equal(db.queryUsage(filter)[0].unknown_costs,0);
  assert.equal(db.queryTurns(filter)[0].billing_mode,'api');
  assert.equal(db.connection.prepare('SELECT pricing_version FROM turn_costs').get()?.pricing_version,PRICING_VERSION);
  for (const group of ['day','month','project','session','total'] as const) {
    const grouped = db.queryUsage(filter,group,'Asia/Seoul');
    assert.ok(Math.abs(grouped.reduce((sum,row)=>sum+(row.cost_usd ?? 0),0)-expected)<1e-12);
    assert.equal(grouped.reduce((sum,row)=>sum+row.turn_count,0),1);
  }
  assert.equal(db.queryCumulative({fromMs:Date.parse('2027-01-01')},'model').total,0);
  assert.equal(db.queryCumulative({providers:['codex']},'model').total,0);
  assert.equal(db.queryCumulative({projectKey:'/elsewhere'},'model').total,0);
  db.close();db = new SummaryDatabase(options.dbPath);
  assert.equal(db.sessionBilling('claude','session'),'api');
  assert.ok(Math.abs(db.queryUsage(filter)[0].cost_usd!-expected)<1e-12);
  await appendFile(file,text([{type:'custom-title',customTitle:'Renamed'}]));
  await refreshSummary(db,options);
  assert.equal(db.sessionBilling('claude','session'),'api');
  assert.ok(Math.abs(db.queryUsage(filter)[0].cost_usd!-expected)<1e-12);
  await appendFile(file,'{bad}\n');
  assert.equal((await refreshSummary(db,options)).failed,1);
  assert.ok(Math.abs(db.queryUsage(filter)[0].cost_usd!-expected)<1e-12);
  db.setSessionBilling('claude','session','subscription');
  assert.equal(db.queryUsage(filter)[0].cost_usd,0);
  assert.equal(db.queryUsage(filter)[0].unknown_costs,0);
  assert.ok(db.queryCumulative(filter,'model').rows.every(row=>row.cost_usd===0));
  assert.equal(db.queryTurns().length,1,'model breakdown never multiplies request counts');
  assert.equal(db.queryUsage()[0].completed_turns,1);
  db.clearData();
  for (const table of ['turn_model_usage','turn_costs','session_billing']) assert.equal(db.connection.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count,0);
});

test('Codex current and legacy metadata attribute actual model tokens and explicit billing without guessing missing authentication',async t => {
  const directory = await mkdtemp(join(tmpdir(),'tracker-codex-costs-'));
  const db = new SummaryDatabase(join(directory,'db.sqlite'));
  t.after(async()=>{db.close();await rm(directory,{recursive:true,force:true});});
  const options = {dbPath:join(directory,'db.sqlite'),roots:[{provider:'codex' as const,path:directory}]};
  await writeFile(join(directory,'current.jsonl'),text([
    {type:'session_meta',payload:{id:'current',cwd:'/project',auth_mode:'chatgpt'}},
    {type:'turn_context',payload:{turn_id:'r',model:'gpt-5.4'}},
    {type:'token_usage_record',payload:{turn_id:'r',root_turn_id:'r',response_id:'one',usage:{input_tokens:100,output_tokens:50,cached_input_tokens:50}}},
    {type:'token_usage_record',payload:{turn_id:'r',root_turn_id:'r',response_id:'two',model:'gpt-6.1-sol',usage:{input_tokens:100,output_tokens:50,cached_input_tokens:50}}},
  ]));
  await writeFile(join(directory,'legacy.jsonl'),text([
    {type:'session_meta',payload:{id:'legacy',cwd:'/project',auth_mode:'api_key'}},
    {type:'turn_context',payload:{turn_id:'l',model:'gpt-5.4'}},
    {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,output_tokens:50,cached_input_tokens:50}}}},
    {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,output_tokens:50,cached_input_tokens:50}}}},
  ]));
  await writeFile(join(directory,'unknown.jsonl'),text([
    {type:'session_meta',payload:{id:'unknown',cwd:'/project'}},
    {type:'token_usage_record',payload:{turn_id:'u',root_turn_id:'u',response_id:'unknown',usage:{input_tokens:1,output_tokens:1}}},
  ]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  const turns = db.queryTurns({includeCosts:true});
  assert.equal(turns.find(row=>row.session_id==='current')?.cost_usd,0);
  assert.equal(db.sessionBilling('codex','current'),'subscription');
  assert.equal(turns.find(row=>row.session_id==='unknown')?.cost_usd,null);
  assert.ok(Math.abs(turns.find(row=>row.session_id==='legacy')!.cost_usd!-0.0008875)<1e-12);
  const models = db.queryCumulative({includeCosts:true},'model').rows;
  assert.equal(models.reduce((sum,row)=>sum+row.total_tokens,0),452);
  assert.equal(models.find(row=>row.model==='gpt-6.1-sol')?.cost_usd,0);
  assert.equal(models.find(row=>row.model==='')?.total_tokens,2);
});

test('cost estimates charge each cache component once, match model snapshots and retain unsupported prices as unknown',()=>{
  const usage = {model:'claude-sonnet-4-6-20260101',input_tokens:1_000_000,output_tokens:1_000_000,cache_write_input_tokens:200_000,cache_read_input_tokens:300_000};
  assert.equal(estimateCost('claude',usage),17.34);
  assert.equal(estimateCost('codex',{...usage,model:'gpt-6.1-sol'}),11.53);
  assert.equal(estimateCost('codex',{...usage,model:'gpt-5.4'}),null,'an undocumented cache write price is not guessed');
  for (const model of ['unknown','__proto__','toString']) assert.equal(estimateCost('claude',{...usage,model}),null);
  assert.equal(estimateCost('claude',{...usage,cache_read_input_tokens:null}),null);
});

const summary = (root: string, model: string): TurnSummaryInput => ({
  provider:'claude',project_key:'/project',project_name:'Project',session_id:'s',root_turn_id:root,turn_index:1,
  duration_quality:'missing',input_tokens:100,output_tokens:10,total_tokens:110,status:'completed',
  model_usage:[{model,input_tokens:100,output_tokens:10,cache_read_input_tokens:0,cache_write_input_tokens:0}],
});

test('v4 migration retains historical totals and ids while model and billing coverage remain unknown until rebuilt',async t => {
  const directory = await mkdtemp(join(tmpdir(),'tracker-cost-migration-'));
  const path = join(directory,'db.sqlite');
  let db = new SummaryDatabase(path);
  t.after(async()=>{db.close();await rm(directory,{recursive:true,force:true});});
  db.replaceSessions({sessions:[{provider:'claude',session_id:'s'}],files:[],summaries:[summary('r','claude-sonnet-4-6')]});
  const id = db.queryTurns()[0].id;
  db.connection.exec('DROP TABLE turn_costs; DROP TABLE turn_model_usage; DROP TABLE session_billing; PRAGMA user_version=4;');
  db.close();db = new SummaryDatabase(path);
  assert.equal(db.queryTurns()[0].id,id);assert.equal(db.queryTurns()[0].total_tokens,110);
  const cumulative = db.queryCumulative({includeCosts:true},'model').rows[0];
  assert.equal(cumulative.model,'');assert.equal(cumulative.total_tokens,110);
  assert.equal(cumulative.cost_usd,null);assert.equal(cumulative.unknown_costs,1);
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('model cumulative pages include the full scope, retain unknown legacy totals and roll back invalid splits',()=>{
  const db = new SummaryDatabase(':memory:');
  try {
    const rows = Array.from({length:105},(_,index)=>summary(String(index),`model-${String(index).padStart(3,'0')}`));
    db.replaceSessions({sessions:[{provider:'claude',session_id:'s'}],files:[],summaries:rows});
    const first = db.queryCumulative({},'model');
    const second = db.queryCumulative({},'model',100);
    assert.equal(first.total,105);assert.equal(first.rows.length,100);assert.equal(second.rows.length,5);
    assert.equal(new Set([...first.rows,...second.rows].map(row=>row.model)).size,105);
    assert.equal([...first.rows,...second.rows].reduce((sum,row)=>sum+row.total_tokens,0),db.queryCumulative({},'provider').rows[0].total_tokens);
    assert.throws(()=>db.replaceSessions({sessions:[{provider:'claude',session_id:'s'}],files:[],summaries:[{...rows[0],total_tokens:999}]}));
    assert.equal(db.queryCumulative({},'model').total,105);
    db.replaceSessions({sessions:[{provider:'claude',session_id:'s'}],files:[],summaries:[{...rows[0],model_usage:undefined}]});
    assert.equal(db.queryCumulative({},'model').rows[0].model,'');
    db.setSessionBilling('claude','s','api');
    assert.equal(db.queryUsage({includeCosts:true})[0].cost_usd,null);
    assert.equal(db.queryUsage({includeCosts:true})[0].unknown_costs,1);
    db.setSessionBilling('claude','s','subscription');
    assert.equal(db.queryTurns({includeCosts:true})[0].cost_usd,0);
    assert.throws(()=>db.replaceSessions({sessions:[{provider:'claude',session_id:'s'}],files:[],summaries:[{...rows[0],model_usage:[]}]}),/Model totals/);
    assert.equal(db.queryTurns({includeCosts:true})[0].cost_usd,0,'invalid replacement preserves earlier costs and billing');
  } finally {db.close();}
});

test('worker stores billing and returns costs and cumulative pages without rescanning sources',async t => {
  const directory = await mkdtemp(join(tmpdir(),'tracker-cost-worker-'));
  const client = new SummaryClient({dbPath:join(directory,'db.sqlite'),roots:[{provider:'claude',path:directory}]});
  t.after(async()=>{await client.dispose();await rm(directory,{recursive:true,force:true});});
  const file = join(directory,'session.jsonl');
  await writeFile(file,text([user,response('one','claude-sonnet-4-6')]));
  await client.refresh();
  await client.setSessionBilling('claude','session','api');
  await appendFile(file,'{bad}\n');
  const result = await client.query({groupBy:'turn',includeCosts:true,cumulativeBy:'model',provider:'claude',sessionId:'session',limit:1,offset:100});
  assert.equal(result.rows.length,0);assert.equal(result.cumulative?.rows[0].total_tokens,150);
  assert.equal(result.billing,'api');assert.equal(result.coverage.error,0,'queries do not parse newly malformed data');
  assert.equal((await client.query({groupBy:'all',includeCosts:true})).rows[0].cost_usd,0.000984);
});

test('webview boundary limits cumulative queries and accepts only exact supported billing changes',()=>{
  const query = parseDashboardMessage({type:'queryUsage',query:{groupBy:'all',includeCosts:true,cumulativeBy:'model',cumulativeOffset:-5}});
  assert.ok(query?.type==='queryUsage');assert.equal(query.query.includeCosts,true);assert.equal(query.query.cumulativeOffset,0);
  const invalid = parseDashboardMessage({type:'queryUsage',query:{groupBy:'all',includeCosts:'true',cumulativeBy:'invalid'}});
  assert.ok(invalid?.type==='queryUsage');assert.equal(invalid.query.includeCosts,undefined);assert.equal(invalid.query.cumulativeBy,undefined);
  for (const mode of ['subscription','api','unknown']) assert.ok(parseDashboardMessage({type:'setSessionBilling',provider:'claude',sessionId:'s',mode}));
  for (const change of [{provider:'other',sessionId:'s',mode:'api'},{provider:'claude',sessionId:'',mode:'api'},{provider:'claude',sessionId:'s',mode:'free'}]) {
    assert.equal(parseDashboardMessage({type:'setSessionBilling',...change}),null);
  }
});
