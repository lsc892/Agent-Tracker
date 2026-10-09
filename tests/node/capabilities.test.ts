import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { SummaryDatabase, type TurnSummaryInput } from '../../src/summary/db';
import { SummaryClient } from '../../src/summary/client';
import { refreshSummary } from '../../src/summary/scanner';
import { toolCapabilities } from '../../src/summary/parsers/capabilities';
import { parseDashboardMessage } from '../../src/ui/presentation';

const text=(rows:unknown[]):string=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
const call=(id:string,name:string,input:unknown):Record<string,unknown>=>({type:'tool_use',id,name,input});
const assistant=(id:string,content:unknown[],model='claude-sonnet-4-6'):Record<string,unknown>=>({
  type:'assistant',promptId:'r',requestId:id,message:{id,model,content,usage:{input_tokens:10,output_tokens:5}},
});

test('capability parsers recognize explicit invocations and static wrappers without counting tool output, listings or code text',()=>{
  const uses=(name:string,input:unknown)=>[...toolCapabilities(name,input)].map(({category,name})=>({category,name}));
  assert.deepEqual(uses('Skill',{skill:'review:check'}),[{category:'skill',name:'review:check'},{category:'plugin',name:'review'}]);
  assert.deepEqual(uses('mcp__my_server__lookup',{}),[{category:'plugin',name:'my_server'}]);
  assert.deepEqual(uses('Agent',{subagent_type:'Explore'}),[{category:'subagent',name:'Explore'}]);
  assert.deepEqual(uses('Read',{file_path:'C:/plugins/cache/market/review/1/skills/check/SKILL.md'}),[
    {category:'skill',name:'review:check'},{category:'plugin',name:'review'},
  ]);
  const code=`const ignored = "tools.spawn_agent({})";
    // tools.mcp__fake__call({})
    await Promise.all([tools.exec_command({cmd: "Get-Content -LiteralPath 'C:/my skills/commit/SKILL.md'"}),
      tools.exec_command({cmd: "rg --files -g SKILL.md"}),tools.mcp__docs__search({q:'x'})]);
    await tools.spawn_agent({agent_type:'explorer'});`;
  assert.deepEqual(uses('exec',code),[{category:'skill',name:'commit'},{category:'plugin',name:'docs'},{category:'subagent',name:'explorer'}]);
  assert.deepEqual(uses('apply_patch','Read /skills/commit/SKILL.md'),[]);
  assert.deepEqual(uses('exec_command',{cmd:"rg 'cat /skills/commit/SKILL.md' src"}),[]);
  assert.deepEqual(uses('exec_command',{cmd:"echo 'cat /skills/commit/SKILL.md'"}),[]);
  assert.deepEqual(uses('exec',"await tools.exec_command({cmd: `cat ${path}/SKILL.md`})"),[]);
  assert.deepEqual(uses('exec',"await tools.exec_command({cmd: 'cat /skills/commit/SKILL.md' + suffix})"),[]);
  assert.deepEqual(uses('Skill',{skill:':'}),[{category:'skill',name:':'}]);
});

test('Claude counts deduplicate tool identities and model responses, survive reparse failures and follow request scope',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'tracker-capabilities-'));
  const root=join(directory,'projects');await mkdir(root);
  const db=new SummaryDatabase(join(directory,'db.sqlite'));
  t.after(async()=>{db.close();await rm(directory,{recursive:true,force:true});});
  const options={dbPath:join(directory,'db.sqlite'),roots:[{provider:'claude' as const,path:root}]};
  const row=assistant('one',[call('s','Skill',{skill:'review:check'}),call('a','Agent',{subagent_type:'Explore'})]);
  const file=join(root,'s.jsonl');
  await writeFile(file,text([
    {type:'user',sessionId:'s',promptId:'r',cwd:'/project',timestamp:'2026-10-03T15:00:00Z'},row,row,
    assistant('two',[call('s2','Skill',{skill:'commit'}),call('p','mcp__docs__search',{})],'claude-haiku-4-5'),
  ]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryCapabilities({},'skill').totalUses,2);
  assert.equal(db.queryCapabilities({},'model').totalUses,2);
  assert.equal(db.queryCapabilities({},'subagent').totalUses,1);
  assert.equal(db.queryCapabilities({},'plugin').totalUses,2);
  assert.ok(db.queryCapabilities({},'skill').rows.every(row=>row.percentage===50));
  assert.equal(db.queryCapabilities({projectKey:normalize('/project'),fromMs:Date.parse('2026-10-03T15:00:00Z'),toMs:Date.parse('2026-10-04T15:00:00Z')},'skill').totalUses,2);
  for (const filter of [{projectKey:'/other'},{providers:['codex' as const]},{sessionId:'other'},{toMs:Date.parse('2026-10-03T15:00:00Z')}]) {
    assert.equal(db.queryCapabilities(filter,'skill').totalUses,0);
  }
  assert.equal((await refreshSummary(db,options)).reused,1);
  db.connection.exec('DELETE FROM turn_capability_usage; UPDATE manifest SET parser_version=10;');
  assert.equal((await refreshSummary(db,options)).parsed,1,'previous parser versions rebuild unchanged sources');
  assert.equal(db.queryCapabilities({},'skill').totalUses,2);
  await appendFile(file,text([{type:'custom-title',customTitle:'new'}]));
  await refreshSummary(db,options);assert.equal(db.queryCapabilities({},'skill').totalUses,2);
  await appendFile(file,'{invalid}\n');
  assert.equal((await refreshSummary(db,options)).failed,1);
  assert.equal(db.queryCapabilities({},'skill').totalUses,2);
  const stored=JSON.stringify(db.connection.prepare('SELECT * FROM turn_capability_usage').all());
  assert.ok(!stored.includes('SKILL.md') && !stored.includes('subagent_type'));
  db.clearData();assert.equal(db.queryCapabilities({},'skill').totalUses,0);
});

test('Codex current and legacy model counts, exec calls, descendant calls and aborted exclusion share worker filters',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'tracker-capabilities-codex-'));
  const root=join(directory,'sessions');await mkdir(root);
  const options={dbPath:join(directory,'db.sqlite'),roots:[{provider:'codex' as const,path:root}]};
  const client=new SummaryClient(options);
  t.after(async()=>{await client.dispose();await rm(directory,{recursive:true,force:true});});
  const usage={type:'token_usage_record',payload:{root_turn_id:'r',turn_id:'r',response_id:'one',usage:{input_tokens:10,output_tokens:5}}};
  const exec={type:'response_item',payload:{type:'custom_tool_call',call_id:'exec',name:'exec',input:
    `await tools.exec_command({cmd: "cat /skills/commit/SKILL.md"});await tools.mcp__docs__search({});`}};
  await writeFile(join(root,'main.jsonl'),text([
    {type:'session_meta',payload:{id:'s',cwd:'/project'}},
    {type:'turn_context',payload:{turn_id:'r',model:'gpt-6.1-sol'}},
    {type:'event_msg',timestamp:'2026-10-03T00:00:00Z',payload:{type:'task_started',turn_id:'r'}},
    exec,exec,{type:'response_item',payload:{type:'function_call',call_id:'spawn',name:'spawn_agent',arguments:'{"agent_type":"explorer"}'}},
    usage,usage,
    {type:'event_msg',payload:{type:'task_started',turn_id:'aborted'}},
    {type:'response_item',payload:{type:'function_call',call_id:'excluded',name:'spawn_agent',arguments:'{}'}},
    {type:'event_msg',payload:{type:'turn_aborted',turn_id:'aborted'}},
  ]));
  await writeFile(join(root,'child.jsonl'),text([
    {type:'session_meta',payload:{id:'child',parent_thread_id:'s',cwd:'/project'}},
    {type:'turn_context',payload:{root_turn_id:'r',turn_id:'child-turn',model:'gpt-6-sol'}},
    {type:'response_item',payload:{type:'function_call',call_id:'skill',name:'exec_command',arguments:JSON.stringify({cmd:'cat /skills/testing/SKILL.md'})}},
    {type:'token_usage_record',payload:{root_turn_id:'r',turn_id:'child-turn',response_id:'child',usage:{input_tokens:2,output_tokens:1}}},
  ]));
  await writeFile(join(root,'legacy.jsonl'),text([
    {type:'session_meta',payload:{id:'legacy',cwd:'/other'}},
    {type:'turn_context',payload:{turn_id:'l'}},
    ...Array.from({length:2},()=>({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:10,output_tokens:5}}}})),
  ]));
  assert.equal((await client.refresh()).failed,0);
  const result=await client.query({section:'skills',projectKey:normalize('/project'),fromMs:Date.parse('2026-10-03'),toMs:Date.parse('2026-10-04')});
  assert.equal(result.capabilities?.skill.totalUses,2);
  assert.equal(result.capabilities?.subagent.totalUses,1);
  assert.equal(result.capabilities?.plugin.totalUses,1);
  assert.equal(result.capabilities?.model.totalUses,2);
  assert.ok(result.capabilities?.model.rows.every(row=>row.percentage===50));
  assert.deepEqual(result.capabilities?.skill.chartRows,result.capabilities?.skill.rows,'worker sends the filtered chart ranking');
  assert.equal((await client.query({section:'skills'})).capabilities?.model.totalUses,3);
  assert.equal((await client.query({section:'skills',projectKey:normalize('/other')})).capabilities?.model.rows[0].name,'');
  await rm(root,{recursive:true,force:true});
  assert.equal((await client.query({section:'skills',projectKey:normalize('/project')})).capabilities?.skill.totalUses,2,'queries reuse DB without source scanning');
});

const summary=(root:string,project='/project',count=1):TurnSummaryInput=>({provider:'codex',project_key:project,project_name:project,
  session_id:'s',root_turn_id:root,duration_quality:'missing',status:'completed',input_tokens:1,output_tokens:1,total_tokens:2,
  capability_usage:[{category:'skill',name:root,usage_count:count}],
});

test('verified fork history excludes copied capability calls while keeping new calls in the same root',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'tracker-capabilities-fork-'));
  const db=new SummaryDatabase(join(directory,'db.sqlite'));
  t.after(async()=>{db.close();await rm(directory,{recursive:true,force:true});});
  const options={dbPath:join(directory,'db.sqlite'),roots:[{provider:'codex' as const,path:directory}]};
  const context={type:'turn_context',payload:{turn_id:'r',model:'gpt-6-sol'}};
  const tool=(id:string,skill:string)=>({type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:id,
    arguments:JSON.stringify({cmd:`cat /skills/${skill}/SKILL.md`})}});
  const usage=(input:number,output:number)=>({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:output}}}});
  const copied=[context,tool('copied','commit'),usage(10,5)];
  await writeFile(join(directory,'parent.jsonl'),text([{type:'session_meta',payload:{id:'parent',cwd:'/project'}},...copied]));
  await writeFile(join(directory,'fork.jsonl'),text([{type:'session_meta',payload:{id:'fork',forked_from_id:'parent',cwd:'/project'}},
    ...copied,tool('new','testing'),usage(20,10)]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  const page=db.queryCapabilities({},'skill');
  assert.equal(page.totalUses,2);assert.equal(page.rows.find(row=>row.name==='commit')?.usage_count,1);
  assert.equal(db.queryCapabilities({sessionId:'fork'},'skill').rows[0].name,'testing');
  assert.equal(db.queryCapabilities({},'model').totalUses,2);
});

test('capability ratios combine enabled providers within each category and recompute for the selected provider',()=>{
  const db=new SummaryDatabase(':memory:');
  try {
    const codex=summary('shared','/project',2);
    db.replaceSessions({sessions:[{provider:'codex',session_id:'s'},{provider:'claude',session_id:'s'}],files:[],
      summaries:[codex,{...summary('shared'),provider:'claude'}]});
    const page=db.queryCapabilities({},'skill');assert.equal(page.totalUses,3);
    assert.ok(Math.abs(page.rows[0].percentage-200/3)<1e-10);
    assert.equal(db.queryCapabilities({providers:['claude']},'skill').rows[0].percentage,100);
    assert.equal(db.queryCapabilities({providers:[]},'skill').totalUses,0);
    db.replaceSessions({sessions:[{provider:'codex',session_id:'s'}],files:[],summaries:[]});
    assert.equal(db.queryCapabilities({},'skill').totalUses,1,'session deletion cascades usage counts');
  } finally {db.close();}
});

test('capability pagination uses the full denominator, date filters exclude unknown starts and v5 migration preserves summaries',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'tracker-capabilities-migration-'));
  const file=join(directory,'db.sqlite');let db=new SummaryDatabase(file);
  t.after(async()=>{db.close();await rm(directory,{recursive:true,force:true});});
  db.replaceSessions({sessions:[{provider:'codex',session_id:'s'}],files:[],summaries:Array.from({length:105},(_,i)=>summary(`skill-${i}`))});
  const first=db.queryCapabilities({},'skill'),second=db.queryCapabilities({},'skill',100);
  assert.equal(first.totalUses,105);assert.equal(second.totalUses,105);assert.equal(first.rows.length,100);assert.equal(second.rows.length,5);
  assert.equal(first.chartRows.length,20);assert.deepEqual(second.chartRows,first.chartRows,'chart ranking ignores table pagination');
  assert.deepEqual(first.chartRows,first.rows.slice(0,20),'ties use the same deterministic provider/name ordering');
  assert.deepEqual(db.queryCapabilities({},'skill',200).chartRows,first.chartRows,'even an empty table page retains the full chart');
  assert.ok(Math.abs([...first.rows,...second.rows].reduce((n,row)=>n+row.percentage,0)-100)<1e-10);
  assert.equal(db.queryCapabilities({fromMs:0},'skill').totalUses,0);
  assert.deepEqual(db.queryCapabilities({fromMs:0},'skill').chartRows,[]);
  const before=db.queryTurns();
  assert.throws(()=>db.replaceSessions({sessions:[{provider:'codex',session_id:'s'}],files:[],summaries:[summary('bad','/other',0)]}));
  assert.equal(db.queryCapabilities({},'skill').totalUses,105);
  db.connection.exec('DROP TABLE turn_capability_usage; PRAGMA user_version=5;');
  db.close();db=new SummaryDatabase(file);
  assert.deepEqual(db.queryTurns(),before);assert.equal(db.queryCapabilities({},'skill').totalUses,0);
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('capability chart ranks the filtered top 20 and retains the denominator of omitted entries',()=>{
  const db=new SummaryDatabase(':memory:');
  try {
    const startedAt=Date.parse('2026-10-07T00:00:00Z');
    db.replaceSessions({sessions:[{provider:'codex',session_id:'s'},{provider:'claude',session_id:'other'}],files:[],summaries:[
      ...Array.from({length:25},(_,i)=>({...summary(`rank-${i}`,'/project',25-i),started_at_ms:startedAt})),
      {...summary('outside','/other',1000),provider:'claude',session_id:'other',started_at_ms:startedAt-86_400_000},
    ]});
    assert.equal(db.queryCapabilities({},'skill').chartRows[0].name,'outside');
    for (const filter of [{provider:'codex' as const},{projectKey:'/project'},{sessionId:'s'},{fromMs:startedAt,toMs:startedAt+1}]) {
      const page=db.queryCapabilities(filter,'skill',100);
      assert.equal(page.rows.length,0);assert.equal(page.chartRows.length,20);assert.equal(page.totalUses,325);
      assert.deepEqual(page.chartRows.map(row=>row.name),Array.from({length:20},(_,i)=>`rank-${i}`));
      assert.ok(Math.abs(page.chartRows[0].percentage-25/325*100)<1e-10);
      assert.ok(page.chartRows.reduce((sum,row)=>sum+row.percentage,0)<100,'unshown entries stay in the denominator');
    }
  } finally {db.close();}
});

test('capability messages allow only known sections and bounded category offsets',()=>{
  const parsed=parseDashboardMessage({type:'queryUsage',query:{groupBy:'day',section:'skills',capabilityOffsets:{skill:100,subagent:-10,plugin:Infinity,model:1e20}}});
  assert.equal(parsed?.type,'queryUsage');
  if (parsed?.type==='queryUsage') assert.deepEqual(parsed.query.capabilityOffsets,{skill:100,subagent:0,plugin:0,model:0});
  assert.equal(parseDashboardMessage({type:'queryUsage',query:{groupBy:'day',section:'invalid'}}),null);
});

test('default collection includes autonomous AI calls; disabling freezes counts while tokens update and re-enabling backfills once',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'tracker-capabilities-switch-'));
  const root=join(directory,'projects');await mkdir(root);
  const file=join(root,'session.jsonl'),dbPath=join(directory,'db.sqlite');
  const options={dbPath,roots:[{provider:'claude' as const,path:root}]};
  let client=new SummaryClient(options);
  t.after(async()=>{await client.dispose();await rm(directory,{recursive:true,force:true});});
  await writeFile(file,text([
    {type:'user',sessionId:'s',promptId:'r',cwd:'/project',timestamp:'2026-10-03T00:00:00Z',message:{content:'Fix the bug'}},
    assistant('one',[call('skill','Skill',{skill:'review:check'})]),
  ]));
  await client.refresh();await client.setSessionBilling('claude','s','subscription');
  assert.equal((await client.query({section:'skills'})).capabilities?.skill.totalUses,1,'AI chose the skill without a user skill mention');
  await client.setCapabilityCollectionEnabled(false);
  let result=await client.query({section:'skills'});
  assert.equal(result.capabilitiesEnabled,false);assert.equal(result.capabilities,undefined);
  await appendFile(file,text([assistant('two',[
    call('new-skill','Read',{file_path:'/skills/testing/SKILL.md'}),call('child','Agent',{subagent_type:'Explore'}),
  ])]));
  assert.equal((await client.refresh()).parsed,1);
  const tokens=await client.query({groupBy:'turn',includeCosts:true});
  assert.equal(tokens.rows[0].total_tokens,30);assert.equal(tokens.rows[0].cost_usd,0);
  let db=new SummaryDatabase(dbPath);
  try {
    assert.equal(db.queryCapabilities({},'skill').totalUses,1,'off preserves previous counts through a token rebuild');
    assert.equal(db.queryCapabilities({},'model').totalUses,1,'off does not accumulate model response counts');
    assert.equal(db.findManifest('claude',file)?.capabilities_collected,0);
  } finally {db.close();}
  assert.equal((await client.refresh()).reused,1,'off does not repeatedly reparse an unchanged source');
  await client.dispose();client=new SummaryClient({...options,collectCapabilities:false});
  assert.equal((await client.query({section:'skills'})).capabilitiesEnabled,false,'off persists after worker restart');
  await client.setCapabilityCollectionEnabled(true);
  assert.equal((await client.refresh()).parsed,1,'coverage restores calls skipped during off');
  result=await client.query({section:'skills'});
  assert.equal(result.capabilitiesEnabled,true);assert.equal(result.capabilities?.skill.totalUses,2);
  assert.equal(result.capabilities?.model.totalUses,2);assert.equal(result.capabilities?.subagent.totalUses,1);
  assert.equal((await client.refresh()).reused,1);
  assert.equal((await client.query({section:'skills'})).capabilities?.skill.totalUses,2,'backfill does not add previous counts twice');
  await client.dispose();
  db=new SummaryDatabase(dbPath);
  try {
    const before=db.queryTurns();
    db.connection.exec('ALTER TABLE manifest DROP COLUMN capabilities_collected; PRAGMA user_version=6;');
    db.close();db=new SummaryDatabase(dbPath);
    assert.deepEqual(db.queryTurns(),before,'v6 migration preserves tokens and request identities');
    assert.equal(db.queryCapabilities({},'skill').totalUses,2,'v6 migration preserves historical counts');
    assert.equal(db.findManifest('claude',file)?.capabilities_collected,0,'legacy coverage is rebuilt on the next enabled scan');
  } finally {db.close();}
});
