import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { SummaryDatabase, type TurnSummaryInput, type UsageRow, type TurnSummaryRow } from '../src/summary/db';
import { SummaryClient } from '../src/summary/client';
import { parseDashboardMessage } from '../src/ui/presentation';

const start = Date.parse('2026-01-01T00:00:00Z');
function turn(index: number, changes: Partial<TurnSummaryInput> = {}): TurnSummaryInput {
  return { provider: 'claude', project_key: '/project', project_name: 'Project', session_id: 'session', session_name: 'Session',
    root_turn_id: `request-${index}`, turn_index: index + 1, started_at_ms: start + index * 86400000,
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

test('chart ranks the entire matching project/session scope by the selected metric', t => {
  const rows = Array.from({ length: 130 }, (_, index) => turn(index, {
    project_key: `/project-${index}`, project_name: `Project ${index}`, session_id: `session-${index}`,
    session_name: 'Same title', input_tokens: index + 100, total_tokens: index + 150, duration_ms: (130 - index) * 1000,
  }));
  const db = database(t, rows);
  const chart = db.queryUsageChart({}, 'session', 'UTC', 'tokens');
  assert.equal(chart.total, 130);
  assert.equal(chart.rows.length, 10);
  assert.equal((chart.rows[0] as UsageRow).session_id, 'session-129');
  assert.equal(db.queryUsage({}, 'session', 'UTC', { limit: 100 }).length, 100);
  assert.equal((db.queryUsageChart({}, 'session', 'UTC', 'averageDuration').rows[0] as UsageRow).session_id, 'session-0');
  const filtered = db.queryUsageChart({ projectName: 'Project 129', providers: ['claude'] }, 'project', 'UTC', 'averageTokens');
  assert.equal(filtered.total, 1);
  assert.equal((filtered.rows[0] as UsageRow).avg_tokens_per_turn, 279);
  assert.equal(db.queryUsageChart({ providers: [] }, 'all', 'UTC', 'tokens').rows.length, 0);
});

test('long calendar charts preserve every token, align provider bins and weight averages by actual samples', t => {
  const rows = Array.from({ length: 90 }, (_, index) => turn(index));
  rows.push(turn(1000, { started_at_ms: start, provider: 'codex', session_id: 'codex', duration_ms: null, duration_quality: 'missing' }));
  // The first three dates fall in the same bucket. Their counts are deliberately uneven.
  rows.push(turn(1001, { started_at_ms: start, input_tokens: 900, total_tokens: 950, duration_ms: 9000 }));
  rows.push(turn(1002, { started_at_ms: start, status: 'failed', input_tokens: 9900, total_tokens: 9950, duration_ms: null }));
  rows.push(turn(1003, { started_at_ms: null, cache_read_input_tokens: null }));
  const db = database(t, rows);
  const chart = db.queryUsageChart({}, 'day', 'Asia/Seoul', 'tokens');
  const bars = chart.rows as UsageRow[];
  assert.equal(bars.reduce((sum, row) => sum + row.total_tokens, 0), rows.reduce((sum, row) => sum + row.total_tokens, 0));
  assert.equal(bars.length, 32, '30 Claude buckets, one Codex bucket and one undated bucket');
  assert.equal(bars[0].period, '2026-01-01 ~ 2026-01-03');
  assert.equal(bars[1].period, bars[0].period, 'providers share the whole bucket label even with sparse dates');
  assert.equal(bars[0].avg_tokens_per_turn, (150 * 3 + 950) / 4);
  assert.equal(bars[0].avg_duration_ms, (1000 * 3 + 9000) / 4);
  assert.equal(bars[0].completed_turns, 4);
  assert.equal(bars[0].turn_count, 5, 'failed tokens count toward totals but not averages');
  assert.equal(bars[1].avg_duration_ms, null);
  assert.equal(bars.at(-1)!.period, null);
  assert.equal(bars.at(-1)!.cache_read_input_tokens, null);
  const filtered = db.queryUsageChart({ fromMs: start, toMs: start + 86400000, providers: ['claude'] }, 'day', 'Asia/Seoul', 'requests');
  assert.equal(filtered.rows.length, 2, 'dated and undated rows both obey calendar table semantics');
  assert.equal((filtered.rows[0] as UsageRow).turn_count, 3);
  assert.equal((filtered.rows[1] as UsageRow).unknown_time_turns, 1);
});

test('short calendar and monthly charts retain exact periods, zeros, and empty results', t => {
  const db = database(t, [turn(0), turn(1, { input_tokens: 0, output_tokens: 0, cache_write_input_tokens: 0, cache_read_input_tokens: 0, total_tokens: 0 })]);
  assert.deepEqual(db.queryUsageChart({}, 'day', 'UTC', 'tokens').rows.map(row => (row as UsageRow).period), ['2026-01-01', '2026-01-02']);
  assert.equal((db.queryUsageChart({}, 'month', 'UTC', 'tokens').rows[0] as UsageRow).total_tokens, 150);
  for (const group of ['day', 'month', 'project', 'session', 'all', 'turn'] as const) {
    assert.deepEqual(db.queryUsageChart({ providers: [] }, group, 'UTC', 'tokens').rows, []);
  }
});

test('request charts select the latest 60 by start time and render them chronologically', t => {
  const rows = Array.from({ length: 100 }, (_, index) => turn(index));
  const db = database(t, rows.reverse());
  const chart = db.queryUsageChart({}, 'turn', 'UTC', 'averageDuration');
  assert.equal(chart.total, 100);
  assert.equal(chart.rows.length, 60);
  assert.equal((chart.rows[0] as TurnSummaryRow).root_turn_id, 'request-40');
  assert.equal((chart.rows.at(-1) as TurnSummaryRow).root_turn_id, 'request-99');
  assert.equal(db.queryUsageChart({}, 'turn', 'UTC', 'requests').metric, 'tokens');
});

test('worker returns chart results independently of table limit, offset and filters', async t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'agent-tracker-chart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'summary.sqlite');
  const db = new SummaryDatabase(path);
  seed(db, Array.from({ length: 120 }, (_, index) => turn(index)));
  db.close();
  const client = new SummaryClient({ dbPath: path, roots: [] });
  try {
    const result = await client.query({ groupBy: 'day', timezone: 'UTC', limit: 1, offset: 100, chartMetric: 'tokens' });
    assert.equal(result.rows.length, 1);
    assert.equal(result.total, 120);
    assert.equal(result.chart!.rows.reduce((sum, row) => sum + row.total_tokens, 0), 18000);
    assert.deepEqual((await client.query({ groupBy: 'all', providers: [], chartMetric: 'tokens' })).chart!.rows, []);
  } finally { await client.dispose(); }
});

class Element {
  private text = '';
  value = ''; disabled = false; title = ''; children: Element[] = [];
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
  new Script(readFileSync(join(__dirname, '../../media/dashboard.js'), 'utf8')).runInNewContext({
    acquireVsCodeApi: () => ({ getState: () => undefined, setState: () => undefined, postMessage: (value: typeof messages[number]) => messages.push(value) }),
    document: { getElementById: get, createElement: (tag: string) => new Element(tag), createElementNS: (_ns: string, tag: string) => new Element(tag), querySelectorAll: () => [] },
    window: { addEventListener: (_event: string, listener: typeof receive) => { receive = listener; } },
  });
  return { get, messages, render: (groupBy: string, mode: string, metric: string, rows: unknown[]) => receive!({ data: { type: 'usage', result: {
    groupBy, rows: [], total: 0, coverage: {}, chart: { rows, mode, metric, total: rows.length },
  } } }) };
}

test('all chart groupings stack cache-exclusive Input with the other three components', () => {
  const view = ui();
  const row = { ...turn(1), period: '2026-01-02', avg_duration_ms: 1000, avg_tokens_per_turn: 150, completed_turns: 1, turn_count: 1, turns_with_duration: 1 };
  for (const [group, mode] of [['day', 'calendar'], ['month', 'calendar'], ['project', 'ranking'], ['session', 'ranking'], ['all', 'total'], ['turn', 'turn']]) {
    view.render(group, mode, 'tokens', [row]);
    const marks = view.get('usage-chart').descendants().filter(node => node.attributes.get('class')?.includes('chart-segment'));
    assert.equal(marks.length, 4, group);
    const size = mode === 'calendar' || mode === 'turn' ? 'height' : 'width';
    assert.equal(Number(marks[0].attributes.get(size)), Number(marks[1].attributes.get(size)), 'Input excludes both cache components: 50 equals Output');
    const bar = view.get('usage-chart').descendants().find(node => node.attributes.get('class') === 'chart-bar')!;
    assert.match(bar.attributes.get('aria-label')!, /Input 50 \/ Output 50 \/ Cache Write 20 \/ Cache Read 30/);
    bar.listeners.get('focus')!();
    assert.match(view.get('chart-detail').textContent, /150 토큰/);
  }
});

test('unknown compositions keep total bars neutral while zero components remain known', () => {
  const view = ui();
  view.render('all', 'total', 'tokens', [turn(0, { cache_read_input_tokens: null }), turn(1, { cache_read_input_tokens: 0, cache_write_input_tokens: 0 })]);
  const marks = view.get('usage-chart').descendants().filter(node => node.attributes.get('class')?.includes('chart-segment'));
  assert.equal(marks.length, 3);
  assert.match(marks[0].attributes.get('class')!, /chart-unknown/);
  assert.match(view.get('chart-detail').textContent, /구성 미확인/);
  assert.match(view.get('chart-legend').textContent, /구성 미확인/);
  view.render('all', 'total', 'tokens', []);
  assert.match(view.get('usage-chart').textContent, /표시할 기록이 없습니다/);
  assert.equal(view.get('chart-legend').textContent, '');
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
});
