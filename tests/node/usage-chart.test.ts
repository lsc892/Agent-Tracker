import { createTranslator } from '../../src/localization';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { SummaryDatabase, type TurnSummaryInput, type UsageRow, type TurnSummaryRow } from '../../src/summary/db';
import { SummaryClient } from '../../src/summary/client';
import { parseDashboardMessage } from '../../src/ui/presentation';

const start = Date.parse('2026-01-01T00:00:00Z');
function turn(index: number, changes: Partial<TurnSummaryInput> = {}): TurnSummaryInput {
  return { provider: 'claude', project_key: '/project', project_name: 'Project', session_id: 'session', session_name: 'Session',
    root_turn_id: `request-${index}`, started_at_ms: start + index * 86400000,
    input_tokens: 100, output_tokens: 50, cache_write_input_tokens: 20, cache_read_input_tokens: 30,
    total_tokens: 150, status: 'completed', duration_ms: 1000, duration_quality: 'exact', ...changes };
}
function database(t: TestContext, rows: TurnSummaryInput[], path = ':memory:'): SummaryDatabase {
  const db = new SummaryDatabase(path);
  t.after(() => db.close());
  seed(db, rows);
  return db;
}
function seed(db: SummaryDatabase, rows: TurnSummaryInput[]): void {
  const sessions = new Map(rows.map(row => [`${row.provider}/${row.session_id}`, { provider: row.provider, session_id: row.session_id }]));
  db.replaceSessions({ sessions: sessions.values(), files: [], summaries: rows });
}

test('empty unknown requests stay in all table groups but are excluded from averages and all chart metrics', t => {
  const db = database(t, [
    turn(0, { input_tokens: 0, output_tokens: 0, cache_write_input_tokens: 0, cache_read_input_tokens: 0, total_tokens: 0, duration_ms: 9000 }),
    turn(1),
    turn(2, { input_tokens: 0, output_tokens: 0, cache_write_input_tokens: 0, cache_read_input_tokens: 0, total_tokens: 0, duration_ms: 3000,
      model_usage: [{ model: 'known-zero', input_tokens: 0, output_tokens: 0, cache_write_input_tokens: 0, cache_read_input_tokens: 0 }] }),
  ]);
  for (const by of ['provider', 'model'] as const) {
    for (const group of ['total', 'day', 'month', 'project', 'session'] as const) {
      const full = db.queryUsage({}, group, 'UTC', {}, by);
      const selected = db.queryUsage({ excludeEmptyUsage: true }, group, 'UTC', {}, by);
      assert.equal(selected.length, full.length, 'table retains every group');
      assert.equal(selected.reduce((n, r) => n + r.turn_count, 0), 3);
      for (const metric of ['tokens', 'requests', 'averageTokens', 'averageDuration'] as const) {
        const chart = db.queryUsageChart({ excludeEmptyUsage: true }, group, 'UTC', metric, by);
        assert.equal(chart.rows.reduce((n, r) => n + ('turn_count' in r ? r.turn_count : 1), 0), 2);
      }
    }
    assert.equal(db.queryTurns({ excludeEmptyUsage: true }, {}, by).length, 3);
    assert.equal(db.queryUsageChart({ excludeEmptyUsage: true }, 'turn', 'UTC', 'tokens', by).rows.length, 2);
    assert.equal(db.queryUsageChart({}, 'turn', 'UTC', 'tokens', by).rows.length, 3);
  }
  const included = db.queryUsage()[0];
  const excluded = db.queryUsage({ excludeEmptyUsage: true })[0];
  assert.equal(included.avg_tokens_per_turn, 50);
  assert.equal(excluded.avg_tokens_per_turn, 75);
  assert.equal(excluded.avg_duration_ms, 2000);
  assert.equal(excluded.turns_with_duration, 2);
});

test('excluding empty usage keeps page boundaries and includes known zero-token models', t => {
  const zero = { input_tokens:0,output_tokens:0,total_tokens:0,cache_write_input_tokens:0,cache_read_input_tokens:0 };
  const db = database(t, Array.from({ length:105 }, (_,index)=>turn(index, {
    project_key:`/project-${String(index).padStart(3,'0')}`,session_id:`session-${index}`,
    ...(index%3===0 ? zero : index%3===1 ? {...zero,model_usage:[{model:'known-zero',...zero}]} : {}),
  })));
  for (const by of ['provider','model'] as const) {
    const tableRows = db.queryUsageChart({},'turn','UTC','tokens',by,{limit:1000}).rows as TurnSummaryRow[];
    const emptyOffset = tableRows.findIndex(row=>row.root_turn_id==='request-0');
    const knownOffset = tableRows.findIndex(row=>row.root_turn_id==='request-1');
    const excluded = db.queryUsageChart({excludeEmptyUsage:true},'turn','UTC','tokens',by,{limit:1,offset:emptyOffset});
    assert.equal(excluded.rows.length,0,'an empty page stays empty rather than borrowing from the next page');
    const known = db.queryUsageChart({excludeEmptyUsage:true},'turn','UTC','tokens',by,{limit:1,offset:knownOffset});
    assert.equal(known.rows.length,1);assert.equal(known.rows[0].total_tokens,0);
    const chart = db.queryUsageChart({excludeEmptyUsage:true},'turn','UTC','tokens',by,{offset:100});
    assert.equal(chart.total,105);
    const expectedIds = tableRows.slice(100).filter(row=>Number(row.root_turn_id.split('-')[1])%3!==0).map(row=>row.root_turn_id);
    assert.deepEqual(chart.rows.map(row=>(row as TurnSummaryRow).root_turn_id),expectedIds);
    const projectRows = db.queryUsage({},'project','UTC',{limit:1000},by);
    const projectOffset = projectRows.findIndex(row=>row.project_key==='/project-000');
    const projects = db.queryUsageChart({excludeEmptyUsage:true},'project','UTC','requests',by,{limit:1,offset:projectOffset});
    assert.equal(projects.rows.length,0,'aggregate pages also apply exclusion after paging');
  }
});

test('project and session charts follow table pages across metrics and filters', t => {
  const rows = Array.from({ length: 130 }, (_, index) => turn(index, {
    project_key: `/project-${index}`, project_name: `Project ${index}`, session_id: `session-${index}`,
    session_name: 'Same title', input_tokens: index + 100, total_tokens: index + 150, duration_ms: (130 - index) * 1000,
  }));
  const db = database(t, rows);
  for (const group of ['project', 'session'] as const) for (const offset of [0, 100]) {
    const page = { offset, limit: 100 };
    const selected = db.queryUsage({}, group, 'UTC', page);
    assert.equal(selected.length, offset ? 30 : 100);
    for (const metric of ['tokens', 'requests', 'averageTokens', 'averageDuration'] as const) {
      const chart = db.queryUsageChart({}, group, 'UTC', metric, 'provider', page);
      assert.equal(chart.total, 130);
      assert.deepEqual(chart.rows, selected, 'changing metrics retains table membership and order');
    }
  }
  const filtered = db.queryUsageChart({ projectName: 'Project 129', providers: ['claude'] }, 'project', 'UTC', 'averageTokens');
  assert.equal(filtered.total, 1);
  assert.equal((filtered.rows[0] as UsageRow).avg_tokens_per_turn, 279);
  assert.equal(db.queryUsageChart({ providers: [] }, 'all', 'UTC', 'tokens').rows.length, 0);
});

test('model charts preserve every model, token totals and filters without tail grouping',t=>{
  const usage=(model:string,input:number)=>({model,input_tokens:input,output_tokens:0,cache_write_input_tokens:0,cache_read_input_tokens:0});
  const db=database(t,[
    turn(0,{input_tokens:300,output_tokens:0,total_tokens:300,cache_write_input_tokens:0,cache_read_input_tokens:0,model_usage:[usage('main',100),usage('helper',200)]}),
    turn(1,{provider:'codex',session_id:'codex',input_tokens:150,output_tokens:0,total_tokens:150,cache_write_input_tokens:0,cache_read_input_tokens:0,model_usage:[usage('codex-main',150)]}),
    turn(2,{project_key:'/other',session_id:'other',input_tokens:91,output_tokens:0,total_tokens:91,cache_write_input_tokens:0,cache_read_input_tokens:0,model_usage:Array.from({length:13},(_,i)=>usage(`extra-${i}`,7))}),
    turn(3,{started_at_ms:null}),
  ]);
  for (const group of ['day','month','all'] as const) {
    const chart=db.queryUsageChart({},group,'UTC','tokens','model');
    assert.equal(chart.by,'model');
    assert.equal(chart.rows.reduce((n,row)=>n+row.total_tokens,0),691);
    assert.ok(chart.rows.every(row=>!row.other_models));
    assert.equal(new Set(chart.rows.map(row=>row.model).filter(model=>model?.startsWith('extra-'))).size,13);
    assert.ok((chart.rows as UsageRow[]).some(row=>row.model==='' && !row.other_models),'missing model records remain visible');
    assert.deepEqual(chart.rows,db.queryUsage({},group==='all' ? 'total' : group,'UTC',{},'model'));
  }
  const filtered=db.queryUsageChart({projectKey:'/project',provider:'claude',fromMs:start,toMs:start+86400000},'project','UTC','tokens','model');
  assert.deepEqual(filtered.rows.map(row=>row.total_tokens),[200,100]);
  assert.equal(filtered.total,2);
  const monthly=db.queryUsageChart({provider:'codex'},'month','UTC','tokens','model');
  assert.equal((monthly.rows[0] as UsageRow).period,'2026-01');assert.equal(monthly.rows[0].total_tokens,150);
  for (const group of ['day','month','project','session','all','turn'] as const) {
    assert.deepEqual(db.queryUsageChart({providers:[]},group,'UTC','tokens','model').rows,[]);
  }
  const averages=db.queryUsageChart({projectKey:'/project',provider:'claude',fromMs:start,toMs:start+86400000},'all','UTC','averageTokens','model');
  assert.deepEqual(averages.rows.map(row=>(row as UsageRow).avg_tokens_per_turn),[200,100]);
});

test('calendar charts keep exact table periods and averages without combining dates', t => {
  const rows = Array.from({ length: 90 }, (_, index) => turn(index));
  rows.push(turn(1000, { started_at_ms: start, provider: 'codex', session_id: 'codex', duration_ms: null, duration_quality: 'missing' }));
  // The first date has uneven completion counts and includes failed tokens.
  rows.push(turn(1001, { started_at_ms: start, input_tokens: 900, total_tokens: 950, duration_ms: 9000 }));
  rows.push(turn(1002, { started_at_ms: start, status: 'failed', input_tokens: 9900, total_tokens: 9950, duration_ms: null }));
  rows.push(turn(1003, { started_at_ms: null, cache_read_input_tokens: null }));
  const db = database(t, rows);
  const chart = db.queryUsageChart({}, 'day', 'Asia/Seoul', 'tokens');
  const bars = chart.rows as UsageRow[];
  assert.equal(bars.reduce((sum, row) => sum + row.total_tokens, 0), rows.reduce((sum, row) => sum + row.total_tokens, 0));
  assert.equal(bars.length, 92, '90 Claude dates, one Codex date and one undated row');
  assert.deepEqual(bars, db.queryUsage({}, 'day', 'Asia/Seoul'));
  const first = bars.find(row=>row.provider==='claude' && row.period==='2026-01-01')!;
  assert.equal(first.avg_tokens_per_turn, (150 + 950) / 2);
  assert.equal(first.avg_duration_ms, (1000 + 9000) / 2);
  assert.equal(first.completed_turns, 2);
  assert.equal(first.turn_count, 3, 'failed tokens count toward totals but not averages');
  assert.equal(bars.find(row=>row.provider==='codex')!.avg_duration_ms, null);
  assert.equal(bars.find(row=>row.period===null)!.cache_read_input_tokens, null);
  const filtered = db.queryUsageChart({ fromMs: start, toMs: start + 86400000, providers: ['claude'] }, 'day', 'Asia/Seoul', 'requests');
  assert.equal(filtered.rows.length, 2, 'dated and undated rows both obey calendar table semantics');
  assert.equal((filtered.rows as UsageRow[]).find(row=>row.period!==null)!.turn_count, 3);
  assert.equal((filtered.rows as UsageRow[]).find(row=>row.period===null)!.unknown_time_turns, 1);
});

test('model tables retain each model, request averages, unknown totals, costs and filters in every grouping', t => {
  const usage = (model: string, input: number, output: number, write = 0, read = 0) => ({
    model,input_tokens:input,output_tokens:output,cache_write_input_tokens:write,cache_read_input_tokens:read,
  });
  const main = 'claude-sonnet-4-6', helper = 'claude-haiku-4-5';
  const db = database(t, [
    turn(0,{input_tokens:140,output_tokens:30,total_tokens:170,cache_write_input_tokens:20,cache_read_input_tokens:40,
      model_usage:[usage(main,100,20,20,30),usage(helper,40,10,0,10)]}),
    turn(1,{input_tokens:80,output_tokens:20,total_tokens:100,cache_write_input_tokens:0,cache_read_input_tokens:0,duration_ms:null,
      model_usage:[usage(main,80,20)]}),
    turn(2,{input_tokens:40,output_tokens:10,total_tokens:50,cache_write_input_tokens:0,cache_read_input_tokens:0,status:'failed',duration_ms:9000,
      model_usage:[usage(helper,40,10)]}),
    turn(3,{started_at_ms:null,cache_read_input_tokens:null}),
  ]);
  db.setSessionBilling('claude','session','api');
  for (const grouping of ['total','day','month','project','session'] as const) {
    const rows = db.queryUsage({includeCosts:true},grouping,'Asia/Seoul',{},'model');
    assert.equal(rows.reduce((sum,row)=>sum+row.total_tokens,0),470,grouping);
    assert.equal(rows.length,db.queryUsageCount({},grouping,'Asia/Seoul','model'),grouping);
    assert.ok(Math.abs(rows.reduce((sum,row)=>sum+(row.cost_usd ?? 0),0)-db.queryUsage({includeCosts:true})[0].cost_usd!)<1e-12);
    assert.equal(rows.reduce((sum,row)=>sum+row.unknown_costs!,0),1);
  }
  const totals = db.queryUsage({},'total','UTC',{},'model');
  const mainRow = totals.find(row=>row.model===main)!;
  assert.equal(mainRow.total_tokens,220);assert.equal(mainRow.turn_count,2);assert.equal(mainRow.completed_turns,2);
  assert.equal(mainRow.avg_tokens_per_turn,110);assert.equal(mainRow.avg_duration_ms,1000);assert.equal(mainRow.turns_with_duration,1);
  const helperRow = totals.find(row=>row.model===helper)!;
  assert.equal(helperRow.total_tokens,100);assert.equal(helperRow.turn_count,2);assert.equal(helperRow.completed_turns,1);
  assert.equal(helperRow.avg_tokens_per_turn,50);assert.equal(helperRow.avg_duration_ms,1000);
  const unknown = totals.find(row=>row.model==='')!;
  assert.equal(unknown.total_tokens,150);assert.equal(unknown.cache_read_input_tokens,null);
  const turns = db.queryTurns({includeCosts:true},{},'model');
  assert.equal(turns.length,5);assert.equal(db.queryTurnsCount({},'model'),5);
  assert.equal(turns.reduce((sum,row)=>sum+row.total_tokens,0),470);
  assert.deepEqual(turns.slice(0,2).map(row=>row.total_tokens),[50,120]);
  assert.ok(turns.every(row=>row.project_name==='Project' && row.session_name==='Session'));
  assert.equal(db.queryTurns({},{}).length,4,'provider grouping keeps one row per request');
  for (const filter of [{providers:[]},{provider:'codex' as const},{projectKey:'/elsewhere'},{sessionId:'other'}]) {
    assert.deepEqual(db.queryUsage(filter,'total','UTC',{},'model'),[]);
    assert.equal(db.queryTurnsCount(filter,'model'),0);
  }
  const dated = {fromMs:start,toMs:start+86400000};
  assert.equal(db.queryUsage(dated,'day','UTC',{},'model').reduce((sum,row)=>sum+row.total_tokens,0),320,'calendar tables retain the unknown-time group');
  assert.equal(db.queryUsage(dated,'project','UTC',{},'model').reduce((sum,row)=>sum+row.total_tokens,0),170);
  assert.equal(db.queryTurnsCount(dated,'model'),2);
});

test('model queries separate unrecorded usage from unknown tokens in every grouping without changing provider totals', t => {
  const usage = (model: string, input: number) => ({model,input_tokens:input,output_tokens:0,cache_write_input_tokens:0,cache_read_input_tokens:0});
  const empty = {input_tokens:0,output_tokens:0,total_tokens:0,cache_write_input_tokens:0,cache_read_input_tokens:0};
  const db = database(t, [
    turn(0,{...empty}), turn(1,{...empty,model_usage:[usage('',0)]}),
    turn(2,{input_tokens:10,output_tokens:0,total_tokens:10,cache_write_input_tokens:0,cache_read_input_tokens:0,model_usage:[usage('',10)]}),
    turn(3,{...empty,model_usage:[usage('known-zero',0)]}), turn(4),
  ]);
  for (const group of ['total','day','month','project','session'] as const) {
    const rows = db.queryUsage({},group,'UTC',{},'model');
    assert.equal(rows.length,db.queryUsageCount({},group,'UTC','model'));
    assert.equal(rows.reduce((sum,row)=>sum+row.total_tokens,0),160);
    assert.equal(rows.filter(row=>row.model===null).reduce((sum,row)=>sum+row.turn_count,0),2);
    assert.equal(rows.filter(row=>row.model==='').reduce((sum,row)=>sum+row.turn_count,0),2);
    const chart = db.queryUsageChart({},group,'UTC','requests','model');
    assert.equal(chart.rows.reduce((sum,row)=>sum+row.total_tokens,0),160);
    assert.equal((chart.rows as UsageRow[]).filter(row=>row.model===null).reduce((sum,row)=>sum+row.turn_count,0),2);
    assert.equal((chart.rows as UsageRow[]).filter(row=>row.model==='').reduce((sum,row)=>sum+row.turn_count,0),2);
    assert.equal(db.queryUsage({},group,'UTC').reduce((sum,row)=>sum+row.turn_count,0),5);
  }
  const turns = db.queryTurns({}, {}, 'model');
  assert.deepEqual(turns.map(row=>row.model),[null,null,'','known-zero','']);
  assert.equal(db.queryTurnsCount({},'model'),5);
  const chart = db.queryUsageChart({},'turn','UTC','tokens','model');
  assert.equal(chart.total,5);assert.equal(chart.rows.filter(row=>row.model===null).length,2);
  const cumulative = db.queryCumulative({},'model');
  assert.equal(cumulative.total,3);assert.equal(cumulative.rows.find(row=>row.model===null)!.total_tokens,0);
  assert.equal(cumulative.rows.find(row=>row.model==='')!.total_tokens,160);
  const filtered = db.queryUsage({fromMs:start,toMs:start+86400000},'total','UTC',{},'model');
  assert.equal(filtered.length,1);assert.equal(filtered[0].model,null);
});

test('model table and chart pagination show the same models in every grouping', async t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()),'agent-tracker-model-table-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path = join(directory,'summary.sqlite');
  const db = new SummaryDatabase(path);
  seed(db,Array.from({length:105},(_,index)=>turn(index,{
    model_usage:[{model:`model-${String(index).padStart(3,'0')}`,input_tokens:100,output_tokens:50,cache_write_input_tokens:20,cache_read_input_tokens:30}],
  })));
  db.close();
  const client = new SummaryClient({dbPath:path,roots:[]});
  try {
    for (const groupBy of ['all','day','month','project','session','turn'] as const) {
      const result = await client.query({groupBy,timezone:'UTC',chartBy:'model',chartMetric:'tokens',offset:100});
      assert.equal(result.by,'model');assert.equal(result.total,105);assert.equal(result.rows.length,5,groupBy);
      assert.ok(result.rows.every(row=>row.model?.startsWith('model-') && !row.other_models));
      assert.equal(result.chart!.by,'model');
      assert.deepEqual(result.chart!.rows,result.rows);
      assert.equal(result.chart!.rows.reduce((sum,row)=>sum+row.total_tokens,0),750);
    }
    const first = await client.query({groupBy:'all',chartBy:'model',chartMetric:'tokens'});
    const last = await client.query({groupBy:'all',chartBy:'model',chartMetric:'tokens',offset:100});
    assert.equal(first.rows.length,100);assert.deepEqual(first.chart!.rows,first.rows);assert.deepEqual(last.chart!.rows,last.rows);
    assert.equal(new Set([...first.rows,...last.rows].map(row=>row.model)).size,105);
    const provider = await client.query({groupBy:'all',chartBy:'provider'});
    assert.equal(provider.by,'provider');assert.equal(provider.total,1);assert.equal(provider.rows[0].total_tokens,15750);
    assert.equal((await client.query({groupBy:'all',chartBy:'model',providers:[]})).total,0);
  } finally { await client.dispose(); }
});

test('short calendar and monthly charts retain exact periods, zeros, and empty results', t => {
  const db = database(t, [turn(0), turn(1, { input_tokens: 0, output_tokens: 0, cache_write_input_tokens: 0, cache_read_input_tokens: 0, total_tokens: 0 })]);
  assert.deepEqual(db.queryUsageChart({}, 'day', 'UTC', 'tokens').rows.map(row => (row as UsageRow).period), ['2026-01-01', '2026-01-02']);
  assert.equal((db.queryUsageChart({}, 'month', 'UTC', 'tokens').rows[0] as UsageRow).total_tokens, 150);
  for (const group of ['day', 'month', 'project', 'session', 'all', 'turn'] as const) {
    assert.deepEqual(db.queryUsageChart({ providers: [] }, group, 'UTC', 'tokens').rows, []);
  }
});

test('request charts render rows 1–100, 101–200 and the final page in table order', t => {
  const rows = Array.from({ length: 205 }, (_, index) => turn(index));
  const db = database(t, rows.reverse());
  for (const offset of [0, 100, 200]) {
    const chart = db.queryUsageChart({}, 'turn', 'UTC', 'averageDuration', 'provider', { offset });
    assert.equal(chart.total, 205);
    assert.equal(chart.rows.length, offset === 200 ? 5 : 100);
    assert.deepEqual(chart.rows, db.queryTurns({}, { offset }));
    assert.equal((chart.rows[0] as TurnSummaryRow).root_turn_id, `request-${204-offset}`);
  }
  assert.equal(db.queryUsageChart({}, 'turn', 'UTC', 'requests').metric, 'tokens');
});

test('worker returns the current table page as chart data for all groupings and both bases', async t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'agent-tracker-chart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'summary.sqlite');
  const db = new SummaryDatabase(path);
  seed(db, Array.from({ length: 205 }, (_, index) => turn(index, {
    project_key: `/project-${index}`, session_id: `session-${index}`, started_at_ms: start + index * 32 * 86400000,
    model_usage: [{ model: `model-${index}`, input_tokens: 100, output_tokens: 50, cache_write_input_tokens: 20, cache_read_input_tokens: 30 }],
  })));
  db.close();
  const client = new SummaryClient({ dbPath: path, roots: [] });
  try {
    for (const groupBy of ['day', 'month', 'project', 'session', 'all', 'turn'] as const) {
      for (const chartBy of ['provider', 'model'] as const) for (const offset of [0, 100, 200]) {
        const result = await client.query({ groupBy, chartBy, timezone: 'UTC', offset, chartMetric: 'tokens' });
        assert.equal(result.chart!.by, chartBy);
        assert.equal(result.chart!.total, result.total);
        assert.deepEqual(result.chart!.rows, result.rows, `${groupBy}/${chartBy}/${offset}`);
        assert.equal(result.rows.length, groupBy === 'all' && chartBy === 'provider' ? offset ? 0 : 1 : offset === 200 ? 5 : 100);
      }
    }
    const result = await client.query({ groupBy: 'day', timezone: 'UTC', limit: 1, offset: 100, chartMetric: 'tokens' });
    assert.equal(result.rows.length, 1); assert.equal(result.chart!.rows[0].total_tokens, 150);
    assert.deepEqual((await client.query({ groupBy: 'all', providers: [], chartMetric: 'tokens' })).chart!.rows, []);
    const filtered = await client.query({ groupBy: 'session', projectKey: '/project-204', chartBy: 'model', chartMetric: 'averageDuration' });
    assert.equal(filtered.total, 1); assert.deepEqual(filtered.chart!.rows, filtered.rows);
  } finally { await client.dispose(); }
});

class Element {
  private text = '';
  value = ''; className = ''; disabled = false; hidden = false; title = ''; children: Element[] = [];
  options = ['tokens', 'requests', 'averageTokens', 'averageDuration'].map(value => ({ value, disabled: false, textContent: '' }));
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, () => void>();
  constructor(readonly tag = 'div') {}
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...children: Element[]): void { this.children.push(...children); }
  replaceChildren(): void { this.text = ''; this.children = []; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
}
function ui() {
  const elements = new Map<string, Element>();
  const get = (id: string): Element => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  get('group').value = 'day'; get('chart-metric').value = 'tokens';
  let receive: ((event: { data: unknown }) => void) | undefined;
  const messages: { type: string; query?: { chartMetric?: string; offset?: number } }[] = [];
  new Script(readFileSync(join(__dirname, '../../../media/dashboard.js'), 'utf8')).runInNewContext({ agentTrackerI18n: createTranslator('ko'),
    acquireVsCodeApi: () => ({ getState: () => undefined, setState: () => undefined, postMessage: (value: typeof messages[number]) => messages.push(value) }),
    document: { getElementById: get, createElement: (tag: string) => new Element(tag), createElementNS: (_ns: string, tag: string) => new Element(tag), querySelectorAll: () => [] },
    window: { addEventListener: (_event: string, listener: typeof receive) => { receive = listener; } },
  });
  return { get, messages, render: (groupBy: string, mode: string, metric: string, rows: unknown[], by = 'provider', total = rows.length) => receive!({ data: { type: 'usage', result: {
    groupBy, by, rows, total, coverage: {}, chart: { rows, mode, metric, total, by },
  } } }) };
}

test('request axes show titles and project/session charts place categories next to each other', () => {
  const view = ui();
  const rows = [turn(0, { request_title: '카드 UI 위치 수정', session_name: 'Session One' }),
    turn(1, { request_title: '<img src=x> 긴 제목', session_id: 'second', session_name: 'Session Two' })];
  for (const by of ['provider', 'model']) {
    view.render('turn', 'turn', 'tokens', rows.map(row=>({...row,...(by==='model' ? {model:'claude-opus-5-5'} : {})})), by);
    for (const id of ['usage-table', 'usage-chart', 'chart-detail']) {
      assert.match(view.get(id).textContent, /카드 UI 위치 수정/);
      assert.doesNotMatch(view.get(id).textContent, /요청\s*\d+/);
    }
    assert.equal(view.get('usage-table').descendants().filter(node => node.tag === 'img').length, 0);
    const bar = view.get('usage-chart').descendants().find(node=>node.attributes.get('class')==='chart-bar')!;
    assert.doesNotMatch(bar.attributes.get('aria-label')!, /요청\s*\d+/);
  }
  for (const group of ['project', 'session']) for (const metric of ['tokens', 'requests', 'averageTokens', 'averageDuration']) {
    view.render(group, 'ranking', metric, rows.map((row,index)=>({ ...row,project_key:`/project-${index}`,project_name:`Project ${index}`,
      turn_count:1,avg_tokens_per_turn:150,avg_duration_ms:1000 })));
    const bars = view.get('usage-chart').descendants().filter(node => node.attributes.get('class') === 'chart-bar');
    const marks = bars.map(bar => bar.children.find(node => node.attributes.get('class')?.includes('chart-segment'))!);
    assert.notEqual(marks[0].attributes.get('x'), marks[1].attributes.get('x'), `${group}/${metric}: separate horizontal positions`);
    assert.equal(marks[0].attributes.get('width'), '36', 'values use upright bars');
    assert.match(view.get('usage-chart').textContent, group === 'session' ? /Session One.*Session Two/ : /Project 0.*Project 1/);
  }
});

test('chart and table pagination share page labels and offsets across every grouping', () => {
  const view = ui();
  for (const [group,mode] of [['day','calendar'],['month','calendar'],['project','ranking'],['session','ranking'],['all','total'],['turn','turn']]) {
    view.get('group').value = group;
    const first = Array.from({ length: 100 }, (_,index)=>turn(index));
    view.render(group, mode, 'tokens', first, 'provider', 205);
    for (const prefix of ['', 'chart-']) {
      assert.equal(view.get(`${prefix}page-label`).textContent, '1–100 / 205');
      assert.equal(view.get(`${prefix}previous`).disabled, true);
      assert.equal(view.get(`${prefix}next`).disabled, false);
    }
    view.get('chart-next').listeners.get('click')!();
    assert.equal(view.messages.at(-1)!.query!.offset, 100);
    view.render(group, mode, 'tokens', Array.from({ length: 100 }, (_,index)=>turn(index+100)), 'provider', 205);
    assert.equal(view.get('chart-page-label').textContent, '101–200 / 205');
    assert.equal(view.get('page-label').textContent, '101–200 / 205');
    assert.match(view.get('chart-scope').textContent, /현재 표 101–200/);
    view.get('next').listeners.get('click')!();
    view.render(group, mode, 'tokens', first.slice(0,5), 'provider', 205);
    for (const prefix of ['', 'chart-']) {
      assert.equal(view.get(`${prefix}page-label`).textContent, '201–205 / 205');
      assert.equal(view.get(`${prefix}next`).disabled, true);
    }
    view.get('chart-previous').listeners.get('click')!();
    assert.equal(view.messages.at(-1)!.query!.offset, 100);
    view.get('previous').listeners.get('click')!();
    assert.equal(view.messages.at(-1)!.query!.offset, 0);
  }
});

test('period/project/session labels keep full text and filter actions inside clamped labels', () => {
  const view = ui();
  const longName = '매우 긴 이름 '.repeat(150);
  const row = { ...turn(0),project_name:longName,session_name:longName,period:longName };
  for (const group of ['day','month','project','session','turn']) {
    view.render(group, group==='turn' ? 'turn' : 'ranking', 'tokens', [{...row,period: ['day','month'].includes(group) ? longName : null,
      session_id: group==='project' ? null : row.session_id,project_key:['day','month'].includes(group) ? null : row.project_key}]);
    const labels = view.get('usage-table').descendants().filter(node=>node.className==='table-label');
    assert.ok(labels.length>0, group);
    assert.ok(labels.some(node=>node.textContent.includes(longName)), 'clipping preserves the original text');
    assert.ok(labels.some(node=>node.title.includes(longName)), 'full names remain available in hover text');
    if (group==='project' || group==='session') {
      const button = view.get('usage-table').descendants().find(node=>node.tag==='button')!;
      button.listeners.get('click')!();
      assert.equal((view.messages.at(-1)!.query as Record<string,unknown>).projectKey, '/project');
    }
  }
});

test('model charts and tables display compact model names with provider markers in every grouping', () => {
  const view = ui();
  const row = {...turn(0),model:'claude-opus-5-5',period:'2026-01-01'};
  const codex = {...turn(1),provider:'codex',model:'gpt-5.6-sol',period:'2026-01-01'};
  for (const [group,mode] of [['day','calendar'],['month','calendar'],['project','ranking'],['session','ranking'],['all','total'],['turn','turn']]) {
    view.render(group,mode,'tokens',[row,codex],'model');
    assert.deepEqual(view.get('chart-legend').children.map(item => item.textContent), ['Input', 'Output', 'Cache Write', 'Cache Read'],
      'model charts use one shared token composition legend');
    const labels = view.get('usage-chart').descendants().filter(node=>['chart-provider','chart-label'].includes(node.attributes.get('class') ?? ''));
    assert.equal(labels.length,2);assert.ok(labels[0].textContent.includes('opus5.5'));assert.ok(labels[1].textContent.includes('gpt-5.6-sol'));
    assert.ok(labels.every(node=>!node.textContent.includes('Claude')));
    for (const id of ['usage-chart','usage-table']) {
      const markers = view.get(id).descendants().filter(node=>node.attributes.get('class')?.includes('provider-marker'));
      assert.deepEqual(markers.map(marker=>marker.attributes.get('class')),['provider-marker chart-provider-claude','provider-marker chart-provider-codex']);
      assert.ok(markers.every(marker=>marker.attributes.get('width') === '8' && marker.attributes.get('height') === '8'));
    }
    const bars = view.get('usage-chart').descendants().filter(node=>node.attributes.get('class') === 'chart-bar');
    assert.match(bars[0].attributes.get('aria-label')!,/^Claude · /);
    assert.match(bars[1].attributes.get('aria-label')!,/^Codex · /);
    assert.match(view.get('usage-table').textContent,/모델.*opus5\.5/);
    assert.doesNotMatch(view.get('usage-table').textContent,/제공자|Claude/);
  }
  view.render('all','total','tokens',[{...row,model:''}],'model');
  assert.match(view.get('usage-table').textContent,/미상/);
  view.render('all','total','tokens',[{...row,model:'gpt-6.1-sol'}],'model');
  assert.match(view.get('usage-table').textContent,/gpt-6\.1-sol/);
  view.render('all','total','tokens',[turn(0)],'provider');
  assert.match(view.get('usage-table').textContent,/제공자.*Claude/);
});

test('model charts and tables label both unrecorded usage and unknown models as 미상 in every grouping', () => {
  const view = ui();
  const unknown = {...turn(0),model:'',period:'2026-01-01'};
  const empty = {...turn(1),model:null,input_tokens:0,output_tokens:0,total_tokens:0,cache_write_input_tokens:0,cache_read_input_tokens:0,period:'2026-01-01'};
  for (const [group,mode] of [['day','calendar'],['month','calendar'],['project','ranking'],['session','ranking'],['all','total'],['turn','turn']]) {
    view.render(group,mode,'tokens',[unknown,empty],'model');
    for (const id of ['usage-chart','usage-table']) {
      assert.match(view.get(id).textContent,/미상/);
      assert.doesNotMatch(view.get(id).textContent,/사용량 기록 없음|모델 미상/);
    }
  }
});

test('all chart groupings stack cache-exclusive Input and expose the hovered component token count', () => {
  const view = ui();
  const row = { ...turn(1), period: '2026-01-02', avg_duration_ms: 1000, avg_tokens_per_turn: 150, completed_turns: 1, turn_count: 1, turns_with_duration: 1 };
  for (const [group, mode] of [['day', 'calendar'], ['month', 'calendar'], ['project', 'ranking'], ['session', 'ranking'], ['all', 'total'], ['turn', 'turn']]) {
    view.render(group, mode, 'tokens', [row]);
    const marks = view.get('usage-chart').descendants().filter(node => node.attributes.get('class')?.includes('chart-segment'));
    assert.equal(marks.length, 4, group);
    const legend = view.get('chart-legend');
    assert.equal(legend.hidden, false, `${group}: token composition legend is visible`);
    assert.deepEqual(legend.children.map(item => item.textContent), ['Input', 'Output', 'Cache Write', 'Cache Read']);
    assert.deepEqual(legend.descendants().filter(node => node.tag === 'rect').map(node => node.attributes.get('class')),
      marks.map(mark => mark.attributes.get('class')!.replace('chart-segment ', '')), `${group}: legend swatches share the bar colors`);
    assert.match(legend.children[0].title, /캐시 읽기·쓰기를 제외/);
    const size = mode === 'calendar' || mode === 'turn' ? 'height' : 'width';
    assert.equal(Number(marks[0].attributes.get(size)), Number(marks[1].attributes.get(size)), 'Input excludes both cache components: 50 equals Output');
    const bar = view.get('usage-chart').descendants().find(node => node.attributes.get('class') === 'chart-bar')!;
    assert.match(bar.attributes.get('aria-label')!, /Input 50 \/ Output 50 \/ Cache Write 20 \/ Cache Read 30/);
    bar.listeners.get('focus')!();
    assert.match(view.get('chart-detail').textContent, /150 토큰/);
    const queriesBeforeHover = view.messages.length;
    for (const [index, detail] of ['Input: 50 토큰', 'Output: 50 토큰', 'Cache Write: 20 토큰', 'Cache Read: 30 토큰'].entries()) {
      assert.ok(marks[index].children.find(child => child.tag === 'title')?.textContent.endsWith(detail), `${group}: native tooltip names the hovered component`);
      marks[index].listeners.get('mouseenter')!();
      assert.ok(view.get('chart-detail').textContent.endsWith(detail), `${group}: hover displays only the selected component count`);
      marks[index].listeners.get('mouseleave')!();
      assert.match(view.get('chart-detail').textContent, /Input 50 \/ Output 50 \/ Cache Write 20 \/ Cache Read 30/);
    }
    assert.equal(view.messages.length, queriesBeforeHover, 'component hover reuses the rendered data');
  }
});

test('unknown compositions keep total bars neutral while zero components remain known', () => {
  const view = ui();
  view.render('all', 'total', 'tokens', [turn(0, { cache_read_input_tokens: null }), turn(1, { cache_read_input_tokens: 0, cache_write_input_tokens: 0 })]);
  const marks = view.get('usage-chart').descendants().filter(node => node.attributes.get('class')?.includes('chart-segment'));
  assert.equal(marks.length, 3);
  assert.match(marks[0].attributes.get('class')!, /chart-unknown/);
  const legend = view.get('chart-legend');
  assert.equal(legend.hidden, false);
  assert.equal(legend.children.at(-1)?.textContent, '구성 미확인');
  assert.equal(legend.descendants().filter(node => node.tag === 'rect').at(-1)?.attributes.get('class'), 'chart-unknown');
  assert.match(view.get('chart-detail').textContent, /구성 미확인/);
  marks[0].listeners.get('mouseenter')!();
  assert.match(view.get('chart-detail').textContent, /총 토큰 \(구성 미확인\): 150 토큰/);
  assert.doesNotMatch(view.get('chart-detail').textContent, /Input:|Cache Read:/);
  marks[1].listeners.get('mouseenter')!();
  assert.match(view.get('chart-detail').textContent, /Input: 100 토큰/);
  marks[2].listeners.get('mouseenter')!();
  assert.match(view.get('chart-detail').textContent, /Output: 50 토큰/);
  view.render('all', 'total', 'tokens', []);
  assert.match(view.get('usage-chart').textContent, /표시할 기록이 없습니다/);
  assert.equal(legend.hidden, true);
  assert.equal(legend.children.length, 0, 'empty results clear the previous composition legend');
});

test('monthly and project comparisons use the same token-component colors for both providers',()=>{
  const view=ui();
  const rows=[turn(0,{provider:'codex'}),turn(1,{provider:'claude'})].map(row=>({...row,period:'2026-01',turn_count:1,avg_tokens_per_turn:150,avg_duration_ms:1000}));
  for (const [group,mode] of [['month','calendar'],['project','ranking']]) for (const metric of ['tokens','requests','averageTokens','averageDuration']) {
    view.render(group,mode,metric,rows);
    const bars=view.get('usage-chart').descendants().filter(node=>node.attributes.get('class')==='chart-bar');
    for (const bar of bars) {
      const marks=bar.descendants().filter(node=>node.attributes.get('class')?.includes('chart-segment'));
      assert.deepEqual(marks.map(mark=>mark.attributes.get('class')),metric==='tokens'
        ? [0,1,2,3].map(index=>`chart-segment chart-series-${index}`) : ['chart-segment chart-measure']);
    }
    const legend = view.get('chart-legend');
    assert.equal(legend.hidden, metric !== 'tokens');
    assert.equal(legend.children.length, metric === 'tokens' ? 4 : 0, 'non-token metrics clear the token legend');
  }
  const css=readFileSync(join(__dirname,'../../../media/dashboard.css'),'utf8');
  for (const [index,color] of ['blue','orange','purple','green'].entries()) assert.match(css,new RegExp(`\\.chart-series-${index}\\s*\\{[^}]*--vscode-charts-${color}`));
  assert.doesNotMatch(css,/chart-component|fill-opacity:\s*\.(?:8|6)/);
  assert.match(css,/\.chart-provider-codex\s*\{[^}]*--vscode-charts-blue/);
  assert.match(css,/\.chart-provider-claude\s*\{[^}]*#d97757/);
});

test('duration averages expose samples, missing values have no bar and metric changes preserve pagination', () => {
  const view = ui();
  view.render('project', 'ranking', 'averageDuration', [{ ...turn(0), avg_duration_ms: null, turns_with_duration: 0 }]);
  assert.equal(view.get('usage-chart').descendants().filter(node => node.attributes.get('class')?.includes('chart-segment')).length, 0);
  assert.match(view.get('chart-detail').textContent, /— · 시간 표본 0개/);
  view.get('next').listeners.get('click')!();
  view.get('chart-metric').value = 'averageTokens';
  view.get('chart-metric').listeners.get('change')!();
  assert.equal(view.messages.at(-1)!.query!.offset, 100);
  assert.equal(view.messages.at(-1)!.query!.chartMetric, 'averageTokens');
  view.get('group').value = 'turn';
  view.get('chart-metric').listeners.get('change')!();
  assert.equal(view.messages.at(-1)!.query!.chartMetric, 'tokens');
});

test('webview only accepts known chart metrics', () => {
  const message = parseDashboardMessage({ type: 'queryUsage', query: { groupBy: 'day', chartMetric: 'tokens' } });
  assert.ok(message?.type === 'queryUsage'); assert.equal(message.query.chartMetric, 'tokens');
  const invalid = parseDashboardMessage({ type: 'queryUsage', query: { groupBy: 'day', chartMetric: 'DROP TABLE' } });
  assert.ok(invalid?.type === 'queryUsage'); assert.equal(invalid.query.chartMetric, undefined);
  const model=parseDashboardMessage({type:'queryUsage',query:{groupBy:'month',chartBy:'model'}});
  assert.ok(model?.type==='queryUsage');assert.equal(model.query.chartBy,'model');
  const badBy=parseDashboardMessage({type:'queryUsage',query:{groupBy:'month',chartBy:'invalid'}});
  assert.ok(badBy?.type==='queryUsage');assert.equal(badBy.query.chartBy,undefined);
});
