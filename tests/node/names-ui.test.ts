import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { dashboardHtml } from '../../src/ui/html';
import { parseDashboardMessage } from '../../src/ui/presentation';

class Element {
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

function view() {
  const elements = new Map<string,Element>();
  const get = (id: string): Element => {
    if (!elements.has(id)) elements.set(id,new Element());
    return elements.get(id)!;
  };
  const messages: {type:string;query?:Record<string,unknown>;requestId?:number}[] = [];
  let receive: ((event:{data:unknown})=>void) | undefined;
  get('group').value='session';
  new Script(readFileSync(join(__dirname,'../../../media/dashboard.js'),'utf8')).runInNewContext({
    acquireVsCodeApi:()=>({getState:()=>undefined,setState:()=>undefined,postMessage:(message:typeof messages[number])=>messages.push(message)}),
    document:{getElementById:get,createElement:()=>new Element(),querySelectorAll:()=>[]},
    window:{addEventListener:(event:string,listener:typeof receive)=>{if (event==='message') receive=listener;}},
  });
  const respond = (result: unknown, request = messages.at(-1)!) => receive!({data:{type:'names',kind:request.query?.kind,requestId:request.requestId,result}});
  return { get, messages, respond, receive: (data:unknown) => receive!({data}) };
}
const sessions = [
  {provider:'codex',project_key:'/project',project_name:'Project',session_id:'one',session_name:'같은 이름',session_started_at_ms:0},
  {provider:'codex',project_key:'/project',project_name:'Project',session_id:'two',session_name:'같은 이름',session_started_at_ms:1000},
  {provider:'claude',project_key:'/project',project_name:'Project',session_id:'three',session_name:null,session_started_at_ms:null},
];

test('cost toggle displays stored costs and unknown coverage in table and cumulative model rows without refreshing sources',()=>{
  const {get,messages,receive,respond} = view();
  get('show-costs').checked=true;get('show-costs').listeners.get('change')!();
  assert.equal(messages.at(-1)?.query?.includeCosts,true);assert.equal(get('cost-note').hidden,false);
  get('cumulative-model').listeners.get('click')!();
  assert.equal(messages.at(-1)?.query?.cumulativeBy,'model');assert.equal(get('cumulative-model').attributes.get('aria-pressed'),'true');
  const row = {...sessions[0],input_tokens:100,output_tokens:50,cache_write_input_tokens:20,cache_read_input_tokens:30,total_tokens:150,
    cost_usd:0.001,billing_mode:'api',unknown_costs:1,model:'claude-sonnet-4-6'};
  receive({type:'usage',result:{groupBy:'session',rows:[row],total:1,coverage:{files:1,done:1},cumulative:{by:'model',rows:[row],total:1}}});
  assert.match(get('usage-table').textContent,/API 추정 비용 \(USD\).*\$0.0010.*미확인 1건/);
  assert.match(get('cumulative-table').textContent,/모델.*claude-sonnet-4-6.*\$0.0010.*미확인 1건/);
  get('session-name').listeners.get('click')!();respond({rows:sessions,total:3});
  get('session-list').children[1].listeners.get('click')!();
  assert.equal(get('billing-control').hidden,false);
  receive({type:'usage',result:{groupBy:'session',rows:[{...row,cost_usd:0,billing_mode:'subscription',unknown_costs:0}],total:1,billing:'subscription',coverage:{files:1,done:1}}});
  assert.match(get('usage-table').textContent,/0원 \(구독\)/);
  assert.equal(get('billing-mode').value,'subscription');assert.equal(get('billing-mode').disabled,false);
  get('billing-mode').value='api';get('billing-mode').listeners.get('change')!();
  assert.equal(messages.at(-1)?.type,'setSessionBilling');
  get('show-costs').checked=false;get('show-costs').listeners.get('change')!();
  receive({type:'usage',result:{groupBy:'session',rows:[row],total:1,coverage:{files:1,done:1}}});
  assert.doesNotMatch(get('usage-table').textContent,/API 추정 비용|\$0.0010/);
  assert.equal(get('cost-note').hidden,true);assert.equal(get('billing-control').hidden,true);
  assert.ok(messages.every(message=>!['refreshUsage','refreshQuota'].includes(message.type)));
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
  assert.doesNotMatch(html,/이름으로 검색|프로젝트 ID|세션 ID/);
});
