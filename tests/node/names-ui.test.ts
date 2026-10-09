import { createTranslator } from '../../src/localization';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { dashboardHtml } from '../../src/ui/html';
import { parseDashboardMessage } from '../../src/ui/presentation';

class Element {
  constructor(readonly tagName = '') {}
  private text = '';
  value = ''; title = ''; hidden = true; children: Element[] = [];
  checked = false; disabled = false;
  scrollTop = 0; scrollHeight = 500; clientHeight = 200;
  readonly options = [{value:'',disabled:false},{value:'claude',disabled:false},{value:'codex',disabled:false}];
  get selectedOptions(): {value:string;disabled:boolean}[] { return this.options.filter(option=>option.value===this.value); }
  readonly listeners = new Map<string,(event?: Record<string, unknown>)=>void>();
  readonly attributes = new Map<string, string>();
  get textContent(): string { return this.text+this.children.map(child=>child.textContent).join(''); }
  set textContent(value: string) { this.text=value;this.children=[]; }
  append(...children: Element[]): void { this.children.push(...children); }
  replaceChildren(): void { this.text='';this.children=[]; }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  addEventListener(event: string, listener: (event?: Record<string, unknown>)=>void): void { this.listeners.set(event,listener); }
  focus(): void {}
}

function view(saved?: Record<string,unknown>) {
  const elements = new Map<string,Element>();
  const get = (id: string): Element => {
    if (!elements.has(id)) elements.set(id,new Element());
    return elements.get(id)!;
  };
  const messages: {type:string;query?:Record<string,unknown>;requestId?:number}[] = [];
  let receive: ((event:{data:unknown})=>void) | undefined;
  let state: unknown;
  get('group').value='session';
  new Script(readFileSync(join(__dirname,'../../../media/dashboard.js'),'utf8')).runInNewContext({ agentTrackerI18n: createTranslator('ko'),
    acquireVsCodeApi:()=>({getState:()=>saved,setState:(value:unknown)=>{state=value;},postMessage:(message:typeof messages[number])=>messages.push(message)}),
    document:{getElementById:(id:string)=>id.startsWith('skill-chart') ? null : get(id),createElement:(tag:string)=>new Element(tag),createElementNS:(_namespace:string,tag:string)=>new Element(tag),querySelectorAll:()=>[]},
    window:{addEventListener:(event:string,listener:typeof receive)=>{if (event==='message') receive=listener;}},
  });
  const respond = (result: unknown, request = messages.at(-1)!) => receive!({data:{type:'names',kind:request.query?.kind,requestId:request.requestId,result}});
  return { get, messages, respond, state:()=>state, receive: (data:unknown) => receive!({data}) };
}
const sessions = [
  {provider:'codex',project_key:'/project',project_name:'Project',session_id:'one',session_name:'같은 이름',session_started_at_ms:0},
  {provider:'codex',project_key:'/project',project_name:'Project',session_id:'two',session_name:'같은 이름',session_started_at_ms:1000},
  {provider:'claude',project_key:'/project',project_name:'Project',session_id:'three',session_name:null,session_started_at_ms:null},
];

test('Skill section shares project and period filters, renders four count/percentage tables and pages categories independently',()=>{
  const {get,messages,receive,respond,state}=view();
  get('from-day').value='2026-10-01';get('to-day').value='2026-10-07';
  get('project-name').listeners.get('click')!();respond({rows:[sessions[0]],total:1});
  get('project-list').children[1].listeners.get('click')!();
  get('section-skills').listeners.get('click')!();
  const query=messages.at(-1)?.query;
  assert.equal(query?.section,'skills');assert.equal(query?.projectKey,'/project');
  assert.equal(query?.fromDay,'2026-10-01');assert.equal(query?.toDay,'2026-10-07');
  assert.equal(get('token-section').hidden,true);assert.equal(get('skill-section').hidden,false);
  assert.equal(get('group-control').hidden,true);assert.equal(get('section-skills').attributes.get('aria-pressed'),'true');
  const page={rows:[{provider:'codex',name:'commit',usage_count:3,percentage:75}],total:105,totalUses:4};
  receive({type:'usage',result:{capabilities:{skill:page,subagent:page,plugin:page,model:page},rows:[],total:0}});
  for (const category of ['skill','subagent','plugin','model']) {
    assert.match(get(`${category}-table`).textContent,/사용 횟수.*전체 비율.*commit.*3.*75%/);
    assert.equal(get(`${category}-total`).textContent,'전체 4회');
  }
  get('skill-next').listeners.get('click')!();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1)?.query?.capabilityOffsets)),{skill:100,subagent:0,plugin:0,model:0});
  get('plugin-next').listeners.get('click')!();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1)?.query?.capabilityOffsets)),{skill:100,subagent:0,plugin:100,model:0});
  get('usage-filters').listeners.get('submit')!({preventDefault:()=>{}});
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1)?.query?.capabilityOffsets)),{skill:0,subagent:0,plugin:0,model:0});
  assert.equal((state() as {section:string}).section,'skills');
  get('section-tokens').listeners.get('click')!();
  assert.equal(get('token-section').hidden,false);assert.equal(get('skill-section').hidden,true);
  assert.equal(messages.at(-1)?.query?.projectKey,'/project');
});

test('Skill section selection is restored and reset returns to token defaults',()=>{
  const {get,messages,state}=view({section:'skills',skillChartCategory:'plugin',skillChartMetric:'percentage'});
  assert.equal(messages[0].query?.section,'skills');assert.equal(get('skill-section').hidden,false);
  assert.equal((state() as Record<string,unknown>).skillChartCategory,undefined);
  assert.equal((state() as Record<string,unknown>).skillChartMetric,undefined);
  get('reset-filters').listeners.get('click')!();
  assert.equal(messages.at(-1)?.query?.section,'tokens');assert.equal(get('skill-section').hidden,true);
  assert.equal((state() as {section:string}).section,'tokens');
});

test('Skill statistics keep the four tables and descriptions without the removed usage chart',()=>{
  const html=dashboardHtml('script','style','source','nonce');
  assert.doesNotMatch(html,/skill-chart|스킬 사용 횟수|Skill 사용 도표/);
  for (const category of ['skill','subagent','plugin','model']) assert.ok(html.includes(`id="${category}-table"`));
  assert.ok(html.indexOf('id="model-next"')<html.indexOf('선택한 제공자·프로젝트·세션·기간의 사용 횟수입니다.'));
});

test('Skill off clears cached counts, shows settings guidance and leaves token statistics available',()=>{
  const {get,messages,receive}=view({section:'skills'});
  const rows=[{provider:'codex',name:'commit',usage_count:3,percentage:100}];
  const page={rows,chartRows:rows,total:1,totalUses:3};
  receive({type:'usage',result:{capabilitiesEnabled:true,capabilities:{skill:page,subagent:page,plugin:page,model:page},rows:[],total:0}});
  assert.match(get('skill-table').textContent,/commit/);
  receive({type:'state',timezone:'UTC',capabilitiesEnabled:false});
  assert.equal(get('skill-content').hidden,true);assert.equal(get('skill-disabled').hidden,false);
  assert.equal(get('skill-table').textContent,'','old counts cannot reappear during a state update');
  receive({type:'usage',result:{capabilitiesEnabled:false,rows:[],total:0}});
  get('skill-settings').listeners.get('click')!();assert.equal(messages.at(-1)?.type,'settings');
  get('section-tokens').listeners.get('click')!();assert.equal(get('token-section').hidden,false);
  receive({type:'state',timezone:'UTC',capabilitiesEnabled:true});
  assert.equal(get('skill-disabled').hidden,true);assert.equal(get('skill-content').hidden,false);
});

test('reset returns query controls and chart grouping to defaults while retaining extension cost settings',()=>{
  const {get,messages,receive,respond,state} = view({group:'month',chartMetric:'averageTokens',chartBy:'model',showCosts:true});
  assert.equal(messages[0].query?.chartBy,'model');assert.equal(messages[0].query?.includeCosts,undefined);
  receive({type:'state',timezone:'UTC',showApiCosts:true});
  get('from-day').value='2026-10-01';get('to-day').value='2026-10-02';
  get('session-name').listeners.get('click')!();respond({rows:sessions,total:3});
  get('session-list').children[2].listeners.get('click')!();
  assert.equal(messages.at(-1)?.query?.sessionId,'two');
  get('next').listeners.get('click')!();
  get('project-name').listeners.get('click')!();
  get('reset-filters').listeners.get('click')!();
  const query = messages.at(-1)?.query;
  assert.equal(query?.groupBy,'day');assert.equal(query?.chartMetric,'tokens');
  for (const name of ['provider','sessionId','projectKey','fromDay','toDay']) assert.equal(query?.[name],undefined);
  assert.equal(query?.offset,0);assert.equal(query?.chartBy,'provider');assert.equal(query?.cumulativeBy,undefined);
  assert.equal(get('cost-note').hidden,false);assert.equal(get('project-options').hidden,true);
  assert.equal(get('billing-control').hidden,true);assert.equal(get('project-name').textContent,'전체 프로젝트');
  assert.equal(get('session-name').textContent,'전체 세션');
  assert.deepEqual(JSON.parse(JSON.stringify(state())),{section:'tokens',group:'day',chartMetric:'tokens',chartBy:'provider'});
});

test('extension cost settings display stored costs and session billing without refreshing sources',()=>{
  const {get,messages,receive,respond} = view();
  receive({type:'state',timezone:'UTC',showApiCosts:true});
  assert.equal(get('cost-note').hidden,false);
  get('chart-model').listeners.get('click')!();
  assert.equal(messages.at(-1)?.query?.chartBy,'model');assert.equal(get('chart-model').attributes.get('aria-pressed'),'true');
  const row = {...sessions[0],input_tokens:100,output_tokens:50,cache_write_input_tokens:20,cache_read_input_tokens:30,total_tokens:150,
    cost_usd:0.001,billing_mode:'api',unknown_costs:1,model:'claude-sonnet-4-6'};
  receive({type:'usage',result:{groupBy:'session',rows:[row],total:1,coverage:{files:1,done:1}}});
  assert.match(get('usage-table').textContent,/API 추정 비용 \(USD\).*\$0.0010.*미확인 1건/);
  get('session-name').listeners.get('click')!();respond({rows:sessions,total:3});
  get('session-list').children[1].listeners.get('click')!();
  assert.equal(get('billing-control').hidden,false);
  receive({type:'usage',result:{groupBy:'session',rows:[{...row,cost_usd:0,billing_mode:'subscription',unknown_costs:0}],total:1,billing:'subscription',coverage:{files:1,done:1}}});
  assert.match(get('usage-table').textContent,/0원 \(구독\)/);
  assert.equal(get('billing-mode').value,'subscription');assert.equal(get('billing-mode').disabled,false);
  get('billing-mode').value='api';get('billing-mode').listeners.get('change')!();
  assert.equal(messages.at(-1)?.type,'setSessionBilling');
  receive({type:'state',timezone:'UTC',showApiCosts:false});
  receive({type:'usage',result:{groupBy:'session',rows:[row],total:1,coverage:{files:1,done:1}}});
  assert.doesNotMatch(get('usage-table').textContent,/API 추정 비용|\$0.0010/);
  assert.equal(get('cost-note').hidden,true);assert.equal(get('billing-control').hidden,true);
  assert.ok(messages.every(message=>!['refreshUsage','refreshQuota'].includes(message.type)));
});

test('changing the token grouping basis resets pagination and uses the returned table basis',()=>{
  const {get,messages,receive}=view();
  get('next').listeners.get('click')!();assert.equal(messages.at(-1)?.query?.offset,100);
  get('chart-model').listeners.get('click')!();assert.equal(messages.at(-1)?.query?.offset,0);
  const row={...sessions[0],model:'claude-opus-5-5',total_tokens:150};
  receive({type:'usage',result:{by:'model',groupBy:'session',rows:[row],total:1,coverage:{}}});
  assert.match(get('usage-table').textContent,/모델.*opus5\.5/);
  get('next').listeners.get('click')!();
  get('chart-provider').listeners.get('click')!();assert.equal(messages.at(-1)?.query?.offset,0);
  receive({type:'usage',result:{by:'provider',groupBy:'session',rows:[row],total:1,coverage:{}}});
  assert.match(get('usage-table').textContent,/제공자.*Codex/);
  assert.doesNotMatch(get('usage-table').textContent,/opus5\.5/);
});

test('every capability table paints ratios relative to the full-scope leader across pages',()=>{
  const {get,receive}=view({section:'skills'});
  const leader={provider:'claude',name:'leader',usage_count:200,percentage:20};
  const second={provider:'codex',name:'second',usage_count:100,percentage:10};
  const page={rows:[leader,second],chartRows:[leader,second],total:105,totalUses:1000};
  const sendPage=(value:typeof page)=>receive({type:'usage',result:{capabilities:Object.fromEntries(['skill','subagent','plugin','model'].map(category=>[category,value])),rows:[],total:0}});
  const fills=(category:string)=>get(`${category}-table`).children[0].children[1].children.map(row=>row.children[3].children[0].children[0].children[2]);
  sendPage(page);
  for (const category of ['skill','subagent','plugin','model']) {
    assert.deepEqual(fills(category).map(fill=>Number(fill.attributes.get('width'))),[160,80]);
    assert.match(get(`${category}-table`).textContent,/20%.*10%/);
    assert.match(fills(category)[0].attributes.get('class')!,/claude/);
    assert.match(fills(category)[1].attributes.get('class')!,/codex/);
  }
  sendPage({...page,rows:[{...second,usage_count:1,percentage:0.1}]});
  for (const category of ['skill','subagent','plugin','model']) {
    assert.equal(Number(fills(category)[0].attributes.get('width')),0.8,'a later page does not normalize its own leader to full width');
    assert.match(get(`${category}-table`).textContent,/0.1%/);
  }
});

test('table names and list selections use exact IDs and whole-list choices clear filters immediately', () => {
  const {get,messages,receive,respond} = view();
  receive({type:'usage',result:{groupBy:'session',total:3,rows:sessions,coverage:{files:3,done:3}}});
  const rows = get('usage-table').children[0].children[1].children;
  const first = rows[0].children[1].children[0];
  const second = rows[1].children[1].children[0];
  assert.match(first.textContent,/Project \/ 같은 이름/);assert.match(second.textContent,/Project \/ 같은 이름/);
  assert.match(first.title,/세션 ID: one/);assert.match(second.title,/세션 ID: two/);
  assert.match(rows[2].children[1].textContent,/이름 없는 세션/);
  second.listeners.get('click')!();
  assert.equal(messages.at(-1)?.query?.sessionId,'two');
  assert.equal(messages.at(-1)?.query?.projectKey,'/project');
  assert.equal(messages.at(-1)?.query?.provider,'codex');
  assert.equal(get('session-name').textContent,'같은 이름');
  get('session-name').listeners.get('click')!();
  assert.equal(messages.at(-1)?.query?.projectKey,'/project');
  respond({rows:sessions.slice(0,2),total:2});
  assert.equal(get('session-list').children[2].attributes.get('aria-pressed'),'true');
  get('session-list').children[0].listeners.get('click')!();
  assert.equal(messages.at(-1)?.query?.sessionId,undefined);
  assert.equal(messages.at(-1)?.query?.projectKey,'/project');
  assert.equal(get('session-name').textContent,'전체 세션');
  get('project-name').listeners.get('click')!();
  respond({rows:[],total:0});
  get('project-list').children[0].listeners.get('click')!();
  assert.equal(messages.at(-1)?.query?.projectKey,undefined);
  assert.equal(messages.at(-1)?.query?.projectName,undefined);
  assert.equal(messages.at(-1)?.query?.offset,0);
  second.listeners.get('click')!();
  receive({type:'state',timezone:'Asia/Seoul',providers:['claude']});
  assert.equal(messages.at(-1)?.query?.sessionId,undefined,'disabled providers cannot leave an exact session selection behind');
  assert.equal(messages.at(-1)?.query?.provider,undefined);
  assert.equal(get('session-name').textContent,'전체 세션');
});

test('scrolling loads remaining names independent of date and table filters and ignores stale responses', () => {
  const {get,messages,respond} = view();
  get('from-day').value='2099-01-01';
  get('next').listeners.get('click')!();
  get('session-name').listeners.get('click')!();
  const initial = messages.at(-1)!;
  assert.equal(initial.type,'queryNames');
  assert.equal(initial.query?.offset,0);
  assert.equal(initial.query?.fromDay,undefined);
  respond({rows:sessions.slice(0,2),total:3});
  get('session-options').scrollTop=300;
  get('session-options').listeners.get('scroll')!();
  const next = messages.at(-1)!;
  assert.equal(next.query?.offset,2);
  const count = messages.length;
  get('session-options').listeners.get('scroll')!();
  assert.equal(messages.length,count,'one page remains in flight');
  respond({rows:sessions.slice(2),total:3});
  assert.equal(get('session-list').children.length,4);
  assert.match(get('session-list').children[3].textContent,/이름 없는 세션.*Claude.*Project/);
  get('session-list').children[2].listeners.get('click')!();
  assert.equal(messages.at(-1)?.query?.sessionId,'two');
  assert.equal(messages.at(-1)?.query?.provider,'codex');
  assert.equal(messages.at(-1)?.query?.sessionName,undefined);
  assert.equal(messages.at(-1)?.query?.offset,0);
  assert.equal(get('session-options').hidden,true);
  get('session-name').listeners.get('click')!();
  respond({rows:[sessions[2]],total:1},initial);
  assert.equal(get('session-list').children.length,1,'old results cannot overwrite a newly opened picker');
  respond({rows:[sessions[0]],total:1});
  assert.equal(get('session-list').children.length,2);
  get('session-name').listeners.get('click')!();
  get('session-name').listeners.get('click')!();
  respond({rows:[],total:0});
  assert.equal(get('session-list').children.length,1);
  assert.match(get('session-list-status').textContent,/선택할 기록이 없습니다/);
});

test('name list requests are bounded and statistics accept only selected IDs at the webview boundary', () => {
  const message = parseDashboardMessage({type:'queryNames',requestId:3,query:{kind:'session',provider:'codex',projectKey:'/project',providers:['other'],limit:999999,offset:-1,fromMs:42}});
  assert.deepEqual(message,{type:'queryNames',requestId:3,query:{kind:'session',provider:'codex',projectKey:'/project',limit:100,offset:0}});
  assert.equal(parseDashboardMessage({type:'queryNames',requestId:0,query:{kind:'DROP TABLE'}}),null);
  assert.equal(parseDashboardMessage({type:'queryNames',requestId:-1,query:{kind:'project'}}),null);
  const query = parseDashboardMessage({type:'queryUsage',query:{groupBy:'session',projectName:'Project',sessionName:'같은 이름',projectKey:'/project',sessionId:'two'}});
  assert.ok(query?.type==='queryUsage');
  assert.equal(query.query.projectName,undefined);assert.equal(query.query.sessionName,undefined);
  assert.equal(query.query.sessionId,'two');
  const html = dashboardHtml('script','style','local:','nonce');
  assert.match(html,/id="project-name" type="button"/);assert.match(html,/id="session-name" type="button"/);
  assert.match(html,/aria-controls="project-options"/);
  assert.doesNotMatch(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''),/이름으로 검색|프로젝트 ID|세션 ID/);
});
