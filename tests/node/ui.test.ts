// 웹뷰 메시지의 허용 범위와 자산·보안 정책·요청 상태 표를 검증한다.
import { createTranslator } from '../../src/localization';
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
  assert.deepEqual(parseDashboardMessage({ type: 'queryUsage', query: { groupBy: 'turn', offset: -1, dbPath: '/secret', provider: 'claude' } }), {
    type: 'queryUsage', query: { groupBy: 'turn', limit: 100, offset: 0, provider: 'claude' },
  });
  assert.equal(parseDashboardMessage({ type: 'queryUsage', query: { groupBy: 'DROP TABLE' } }), null);
});

test('statistics page limits accept typed row counts and reject invalid values at the webview boundary', () => {
  for (const limit of [1, 37, 1000]) {
    const parsed = parseDashboardMessage({type:'queryUsage',query:{groupBy:'turn',limit,section:'skills',capabilityLimits:{skill:limit,model:73,unknown:10000}}});
    assert.ok(parsed?.type === 'queryUsage');
    assert.equal(parsed.query.limit,limit);
    assert.deepEqual(parsed.query.capabilityLimits,{skill:limit,model:73});
  }
  for (const limit of [0,-1,1.5,1001,NaN,Infinity,'25',null]) {
    assert.equal(parseDashboardMessage({type:'queryUsage',query:{groupBy:'day',limit}}),null);
    assert.equal(parseDashboardMessage({type:'queryUsage',query:{groupBy:'day',capabilityLimits:{plugin:limit}}}),null);
  }
  const html = dashboardHtml('script','style','source','nonce');
  for (const id of ['page-size','chart-page-size','skill-page-size','subagent-page-size','plugin-page-size','model-page-size']) {
    assert.ok(html.includes(`id="${id}" type="number" min="1" max="1000" step="1" value="100" required`));
  }
});

test('usage messages reject invalid query controls but omit invalid optional filters', () => {
  const base = { groupBy: 'day' };
  for (const fields of [
    { tableSort: null }, { tableSort: { key: 'tokens', direction: 'sideways' } },
    { section: null }, { section: 'other' }, { capabilityLimits: null },
  ]) {
    assert.equal(parseDashboardMessage({ type: 'queryUsage', query: { ...base, ...fields } }), null);
  }
  assert.deepEqual(parseDashboardMessage({ type: 'queryUsage', query: {
    ...base, provider: 'other', projectKey: '', sessionId: 'x'.repeat(2049),
    fromMs: '0', toMs: 8.64e15 + 1, fromDay: null, toDay: '2026-1-01',
    includeCosts: 1, chartMetric: 'other', chartBy: 'other', capabilityOffsets: null,
  } }), { type: 'queryUsage', query: { ...base, limit: 100, offset: 0 } });

  const id = 'x'.repeat(2048);
  assert.deepEqual(parseDashboardMessage({ type: 'queryUsage', query: {
    ...base, offset: 10_000_001, projectKey: id, sessionId: id,
    fromMs: -8.64e15, toMs: 8.64e15, fromDay: '2026-99-99',
    tableSort: { key: 'tokens', direction: 'desc', extra: true },
    capabilityOffsets: { skill: -1, model: 10_000_001, plugin: 1.5 }, capabilityLimits: {},
  } }), { type: 'queryUsage', query: {
    ...base, limit: 100, offset: 10_000_000, projectKey: id, sessionId: id,
    fromMs: -8.64e15, toMs: 8.64e15, tableSort: { key: 'tokens', direction: 'desc' },
    capabilityOffsets: { skill: 0, subagent: 0, plugin: 0, model: 10_000_000 }, capabilityLimits: {},
  }, fromDay: '2026-99-99' });
  const groupBy = { toString: () => 'day' };
  const parsed = parseDashboardMessage({ type: 'queryUsage', query: { groupBy } });
  assert.ok(parsed?.type === 'queryUsage');
  assert.equal(parsed.query.groupBy, groupBy);
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
  /** 요청 상태 표 검증에 필요한 DOM 요소와 자식 조작을 모사한다. */
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
  new Script(readFileSync(join(__dirname,'../../../media/dashboard.js'),'utf8')).runInNewContext({ agentTrackerI18n: createTranslator('ko'),
    acquireVsCodeApi:()=>({getState:()=>undefined,setState:()=>undefined,postMessage:()=>undefined}),
    document:{getElementById:getElement,createElement:()=>new Element(),createElementNS:()=>new Element(),querySelectorAll:()=>[]},
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
