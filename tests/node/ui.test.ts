import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { dashboardHtml, diagnosticsHtml } from '../../src/ui/html';
import { parseDashboardMessage } from '../../src/ui/presentation';

test('webview boundary only permits bounded known queries and provider commands', () => {
  assert.equal(parseDashboardMessage({ type: 'executeCommand', command: 'arbitrary' }), null);
  assert.equal(parseDashboardMessage({ type: 'refreshQuota', provider: '../../credential' }), null);
  assert.equal(parseDashboardMessage({ type: 'settings', provider: 'other' }), null);
  assert.equal(parseDashboardMessage({ type: 'refreshUsage' }), null);
  assert.equal(parseDashboardMessage({ type: 'tab', tab: 'quota' }), null);
  assert.equal(parseDashboardMessage({ type: 'tab', tab: 'diagnostics' }), null);
  assert.deepEqual(parseDashboardMessage({ type: 'queryUsage', query: { groupBy: 'turn', limit: 1000000, offset: -1, dbPath: '/secret', provider: 'claude' } }), {
    type: 'queryUsage', query: { groupBy: 'turn', limit: 100, offset: 0, provider: 'claude' },
  });
  assert.equal(parseDashboardMessage({ type: 'queryUsage', query: { groupBy: 'DROP TABLE' } }), null);
});

test('webview uses external local assets, a nonce CSP, and text-only dynamic labels', () => {
  const html = dashboardHtml('local/script.js', 'local/style.css', 'local:', 'safe');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-safe'/);
  assert.doesNotMatch(html, /unsafe-inline|onclick=/);
  assert.match(dashboardHtml('" onload="bad', 'style', 'local:', 'nonce'), /&quot; onload=&quot;bad/);
  assert.doesNotMatch(html, /id="quota"|data-tab="quota"|id="refresh-usage"/);
  const diagnosticHtml = diagnosticsHtml('local/diagnostics.js', 'local/style.css', 'local:', 'safe');
  assert.match(diagnosticHtml, /default-src 'none'/);
  assert.match(diagnosticHtml, /script-src 'nonce-safe'/);
  assert.doesNotMatch(diagnosticHtml, /unsafe-inline|onclick=/);
  for (const file of ['dashboard.js', 'diagnostics.js']) {
    const source = readFileSync(join(__dirname, '../../../media', file), 'utf8');
    assert.doesNotThrow(() => new Script(source));
    assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML/);
  }
});

test('request table renders API failures separately from completed and running requests', () => {
  class Element {
    textContent = '';value = '';children: Element[] = [];
    append(...children: Element[]): void {this.children.push(...children);}
    replaceChildren(): void {this.children = [];}
    setAttribute(): void {}
    addEventListener(): void {}
  }
  const elements = new Map<string,Element>();
  const getElement = (id: string): Element => {
    if (!elements.has(id)) elements.set(id,new Element());
    return elements.get(id)!;
  };
  getElement('group').value = 'turn';
  let receive: ((event: {data:unknown})=>void) | undefined;
  new Script(readFileSync(join(__dirname,'../../../media/dashboard.js'),'utf8')).runInNewContext({
    acquireVsCodeApi:()=>({getState:()=>undefined,setState:()=>undefined,postMessage:()=>undefined}),
    document:{getElementById:getElement,createElement:()=>new Element(),querySelectorAll:()=>[]},
    window:{addEventListener:(_name:string,listener:typeof receive)=>{receive=listener;}},
  });
  assert.ok(receive);
  receive({data:{type:'usage',result:{groupBy:'turn',total:3,
    rows:['completed','failed','in_progress'].map(status=>({provider:'claude',project_name:'Project',
      root_turn_id:status,session_id:'session',started_at_ms:null,duration_ms:null,duration_quality:'missing',status})),
    coverage:{files:1,done:1,error:0,interrupted:0,stale_summaries:0},
  }}});
  const rows = getElement('usage-table').children[0].children[1].children;
  assert.deepEqual(rows.map(row=>row.children.at(-1)!.textContent),['완료 · missing','실패 · missing','진행 중 · missing']);
});
