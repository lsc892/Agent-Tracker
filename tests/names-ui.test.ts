import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { dashboardHtml } from '../src/ui/html';
import { parseDashboardMessage } from '../src/ui/presentation';

class Element {
  private text = '';
  value = '';title = '';children: Element[] = [];
  readonly options = [{value:'',disabled:false},{value:'claude',disabled:false},{value:'codex',disabled:false}];
  get selectedOptions(): {value:string;disabled:boolean}[] { return this.options.filter(option=>option.value===this.value); }
  readonly listeners = new Map<string,()=>void>();
  get textContent(): string { return this.text+this.children.map(child=>child.textContent).join(''); }
  set textContent(value: string) { this.text=value;this.children=[]; }
  append(...children: Element[]): void { this.children.push(...children); }
  replaceChildren(): void { this.text='';this.children=[]; }
  setAttribute(): void {}
  addEventListener(event: string, listener: ()=>void): void { this.listeners.set(event,listener); }
}

test('duplicate session labels display names and each click filters by its own provider and ID', () => {
  const elements = new Map<string,Element>();
  const get = (id: string): Element => {
    if (!elements.has(id)) elements.set(id,new Element());
    return elements.get(id)!;
  };
  const messages: {type:string;query?:{projectKey?:string;sessionId?:string;provider?:string;sessionName?:string;projectName?:string}}[] = [];
  let receive: ((event:{data:unknown})=>void) | undefined;
  get('group').value='session';
  new Script(readFileSync(join(__dirname,'../../media/dashboard.js'),'utf8')).runInNewContext({
    acquireVsCodeApi:()=>({getState:()=>undefined,setState:()=>undefined,postMessage:(message:typeof messages[number])=>messages.push(message)}),
    document:{getElementById:get,createElement:()=>new Element(),querySelectorAll:()=>[]},
    window:{addEventListener:(_event:string,listener:typeof receive)=>{receive=listener;}},
  });
  assert.ok(receive);
  receive({data:{type:'usage',result:{groupBy:'session',total:3,rows:[
    {provider:'codex',project_key:'/project',project_name:'Project',session_id:'one',session_name:'같은 이름',session_started_at_ms:0},
    {provider:'codex',project_key:'/project',project_name:'Project',session_id:'two',session_name:'같은 이름',session_started_at_ms:1000},
    {provider:'claude',project_key:'/project',project_name:'Project',session_id:'three',session_name:null,session_started_at_ms:null},
  ],coverage:{files:3,done:3}}}});
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
  get('session-name').value='이름';get('session-name').listeners.get('input')!();
  get('next').listeners.get('click')!();
  assert.equal(messages.at(-1)?.query?.sessionId,undefined);
  assert.equal(messages.at(-1)?.query?.sessionName,'이름');
  get('project-name').value='Project';get('project-name').listeners.get('input')!();
  get('previous').listeners.get('click')!();
  assert.equal(messages.at(-1)?.query?.projectKey,undefined);
  assert.equal(messages.at(-1)?.query?.projectName,'Project');
  second.listeners.get('click')!();
  receive({data:{type:'state',timezone:'Asia/Seoul',providers:['claude']}});
  assert.equal(messages.at(-1)?.query?.sessionId,undefined,'disabled providers cannot leave a selected ID targeting a different provider');
  assert.equal(messages.at(-1)?.query?.provider,undefined);
});

test('name queries pass the webview boundary and HTML exposes name filters', () => {
  const message = parseDashboardMessage({type:'queryUsage',query:{groupBy:'session',projectName:'Project',sessionName:'같은 이름'}});
  assert.ok(message?.type==='queryUsage');
  assert.equal(message.query.projectName,'Project');assert.equal(message.query.sessionName,'같은 이름');
  const html = dashboardHtml('script','style','local:','nonce');
  assert.match(html,/프로젝트명<input id="project-name"/);assert.match(html,/세션명<input id="session-name"/);
  assert.doesNotMatch(html,/프로젝트 ID|세션 ID/);
});
