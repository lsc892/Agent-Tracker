import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { SummaryDatabase, type TurnSummaryInput } from '../../src/summary/db';
import { SCHEMA_VERSION } from '../../src/summary/db/schema';
import { refreshSummary, PARSER_VERSION } from '../../src/summary/scanner';
import { codexTokens } from '../../src/summary/parsers';
import type { Provider, SummaryOptions } from '../../src/summary/types';

const jsonl = (rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const claudeUsage = (id: string, input = 100, write = 30, read = 60, output = 10) => ({
  type: 'assistant', promptId: 'turn', requestId: `request-${id}`, timestamp: '2026-10-01T00:00:03Z',
  message: { id, stop_reason: 'end_turn', usage: {
    input_tokens: input, output_tokens: output, cache_creation_input_tokens: write, cache_read_input_tokens: read,
  } },
});
const claudeUser = { type: 'user', sessionId: 'session', promptId: 'turn', cwd: '/project',
  timestamp: '2026-10-01T00:00:00Z', message: { content: 'synthetic' } };

async function fixture(t: TestContext, provider: Provider = 'claude') {
  const parent = await realpath(tmpdir());
  const base = await mkdtemp(join(parent, 'agent-tracker-token-test-'));
  const root = join(base, 'logs');
  await mkdir(root);
  const options: SummaryOptions = { dbPath: join(base, 'summary.sqlite'), roots: [{ provider, path: root }] };
  const state = { database: new SummaryDatabase(options.dbPath), options, root };
  t.after(async () => {
    state.database.close();
    const target = resolve(base);
    assert.ok(target.startsWith(`${parent}${sep}`) && target.split(sep).at(-1)?.startsWith('agent-tracker-token-test-'));
    await rm(target, { recursive: true, force: true });
  });
  return state;
}

function breakdown(row: { input_tokens: number; output_tokens: number; cache_write_input_tokens?: number | null; cache_read_input_tokens?: number | null }) {
  return [row.input_tokens - row.cache_write_input_tokens! - row.cache_read_input_tokens!, row.output_tokens,
    row.cache_write_input_tokens, row.cache_read_input_tokens];
}

test('Claude cache components survive response deduplication, subagents and every aggregate grouping', async t => {
  const { database, options, root } = await fixture(t);
  const response = claudeUsage('main');
  await writeFile(join(root, 'session.jsonl'), jsonl([claudeUser, response, response]));
  await mkdir(join(root, 'session', 'subagents'), { recursive: true });
  await writeFile(join(root, 'session', 'subagents', 'child.jsonl'), jsonl([claudeUsage('child', 20, 10, 40, 5)]));
  assert.equal((await refreshSummary(database, options)).failed, 0);
  const turn = database.queryTurns()[0];
  assert.deepEqual(breakdown(turn), [120, 15, 40, 100]);
  assert.equal(turn.total_tokens, 275);
  for (const grouping of ['total', 'day', 'month', 'project', 'session'] as const) {
    const usage = database.queryUsage({}, grouping, 'Asia/Seoul')[0];
    assert.deepEqual(breakdown(usage), [120, 15, 40, 100], grouping);
    assert.equal(usage.total_tokens, 275);
  }
  assert.equal((await refreshSummary(database, options)).bodyBytes, 0, 'unchanged summaries reuse saved components');
});

test('Codex reads its official flat and API detail cache fields without adding them to total input twice', async t => {
  const { database, options, root } = await fixture(t, 'codex');
  const flat = { input_tokens: 1000, output_tokens: 100, cached_input_tokens: 600, cache_write_input_tokens: 200 };
  const nested = { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 600, cache_write_tokens: 200 } };
  assert.deepEqual(codexTokens(flat), codexTokens(nested));
  const usage = (id: string, tokens: unknown) => ({ type: 'token_usage_record', payload: {
    thread_id: 'session', turn_id: 'turn', root_turn_id: 'turn', response_id: id, usage: tokens,
  } });
  await writeFile(join(root, 'session.jsonl'), jsonl([
    { type: 'session_meta', payload: { id: 'session', cwd: '/project' } },
    { type: 'event_msg', timestamp: '2026-10-01T00:00:00Z', payload: { type: 'task_started', turn_id: 'turn' } },
    usage('one', flat), usage('one', flat), usage('two', nested),
  ]));
  assert.equal((await refreshSummary(database, options)).failed, 0);
  const turn = database.queryTurns()[0];
  assert.deepEqual(breakdown(turn), [400, 200, 400, 1200]);
  assert.equal(turn.total_tokens, 2200);
  assert.deepEqual(breakdown(database.queryUsage()[0]), breakdown(turn));
});

test('legacy Codex cumulative cache snapshots are differenced and repeated snapshots are ignored', async t => {
  const { database, options, root } = await fixture(t, 'codex');
  const count = (input: number, read: number, write: number, output: number) => ({ type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: {
      input_tokens: input, cached_input_tokens: read, cache_write_input_tokens: write, output_tokens: output,
    } },
  } });
  await writeFile(join(root, 'session.jsonl'), jsonl([
    { type: 'session_meta', payload: { id: 'session', cwd: '/project' } },
    { type: 'event_msg', timestamp: '2026-10-01T00:00:00Z', payload: { type: 'task_started', turn_id: 'turn' } },
    count(1000, 600, 200, 100), count(1000, 600, 200, 100), count(1500, 900, 300, 150),
  ]));
  assert.equal((await refreshSummary(database, options)).failed, 0);
  assert.deepEqual(breakdown(database.queryTurns()[0]), [300, 150, 300, 900]);
  assert.equal(database.queryUsage()[0].total_tokens, 1650);
});

test('v3 migration preserves totals and marks cache counts unknown until unchanged sources are rebuilt', async t => {
  const state = await fixture(t);
  const file = join(state.root, 'session.jsonl');
  await writeFile(file, jsonl([claudeUser, claudeUsage('main')]));
  await refreshSummary(state.database, state.options);
  state.database.connection.exec(`ALTER TABLE turn_summary DROP COLUMN cache_write_input_tokens;
    ALTER TABLE turn_summary DROP COLUMN cache_read_input_tokens;
    ALTER TABLE turn_summary ADD COLUMN turn_index INTEGER NOT NULL DEFAULT 1;
    DROP INDEX IF EXISTS idx_summary_session;
    CREATE INDEX idx_summary_session ON turn_summary(provider,session_id,turn_index);
    UPDATE manifest SET parser_version=4;
    PRAGMA user_version=3;`);
  state.database.close();
  state.database = new SummaryDatabase(state.options.dbPath);
  assert.equal(state.database.connection.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
  assert.equal(state.database.queryTurns()[0].total_tokens, 200);
  assert.equal(state.database.queryTurns()[0].cache_read_input_tokens, null);
  assert.equal(state.database.queryUsage()[0].cache_write_input_tokens, null);
  const refreshed = await refreshSummary(state.database, state.options);
  assert.equal(refreshed.failed, 0);
  assert.equal(refreshed.parsed, 1, 'parser version rebuilds even when file size and mtime match');
  assert.deepEqual(breakdown(state.database.queryTurns()[0]), [100, 10, 30, 60]);
  assert.equal(state.database.findManifest('claude', file)!.parser_version, PARSER_VERSION);
  await appendFile(file, '{bad}\n');
  assert.equal((await refreshSummary(state.database, state.options)).failed, 1);
  assert.deepEqual(breakdown(state.database.queryTurns()[0]), [100, 10, 30, 60], 'failed scans preserve the last successful breakdown');
});

test('aggregate cache counts stay unknown when any included turn has not been rebuilt', async t => {
  const { database, options, root } = await fixture(t);
  await writeFile(join(root, 'session.jsonl'), jsonl([claudeUser, claudeUsage('main')]));
  await refreshSummary(database, options);
  database.connection.exec('UPDATE turn_summary SET cache_write_input_tokens=NULL,cache_read_input_tokens=NULL');
  const old = database.queryTurns()[0];
  const next: TurnSummaryInput = { ...old, root_turn_id: 'next', cache_write_input_tokens: 30, cache_read_input_tokens: 60 };
  database.replaceSessions({ sessions: [{ provider: 'claude', session_id: 'session' }], files: [], summaries: [old, next] });
  const usage = database.queryUsage()[0];
  assert.equal(usage.total_tokens, 400);
  assert.equal(usage.cache_write_input_tokens, null);
  assert.equal(usage.cache_read_input_tokens, null);
  assert.throws(() => database.replaceSessions({ sessions: [{ provider: 'claude', session_id: 'session' }], files: [],
    summaries: [{ ...next, cache_read_input_tokens: 200 }] }), /Cache components cannot exceed input tokens/);
  assert.equal(database.queryUsage()[0].total_tokens, 400, 'invalid components roll back replacement');
});

test('invalid cache components are clamped per response while preserving totals and quality flags', async t => {
  const { database, options, root } = await fixture(t, 'codex');
  await writeFile(join(root, 'session.jsonl'), jsonl([
    { type: 'session_meta', payload: { id: 'session', cwd: '/project' } },
    { type: 'token_usage_record', payload: { thread_id: 'session', turn_id: 'turn', root_turn_id: 'turn',
      response_id: 'bad-components', usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 120, cache_write_input_tokens: 20 } } },
  ]));
  assert.equal((await refreshSummary(database, options)).failed, 0);
  const turn = database.queryTurns()[0];
  assert.deepEqual(breakdown(turn), [0, 10, 0, 100]);
  assert.equal(turn.total_tokens, 110);
  assert.match(turn.quality_flags!, /component-clamped/);
});

test('all dashboard groups render four named token columns with unknown and zero values distinguished', () => {
  class Element {
    textContent = ''; value = ''; title = ''; children: Element[] = [];
    append(...children: Element[]): void { this.children.push(...children); }
    replaceChildren(): void { this.children = []; }
    addEventListener(): void {}
    setAttribute(): void {}
  }
  const elements = new Map<string, Element>();
  const getElement = (id: string): Element => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  let receive: ((event: { data: unknown }) => void) | undefined;
  new Script(readFileSync(join(__dirname, '../../../media/dashboard.js'), 'utf8')).runInNewContext({
    acquireVsCodeApi: () => ({ getState: () => undefined, setState: () => undefined, postMessage: () => undefined }),
    document: { getElementById: getElement, createElement: () => new Element(), querySelectorAll: () => [] },
    window: { addEventListener: (_name: string, listener: typeof receive) => { receive = listener; } },
  });
  assert.ok(receive);
  const row = { provider: 'claude', project_name: 'Project', root_turn_id: 'turn', session_id: 'session',
    input_tokens: 1000, output_tokens: 50, cache_write_input_tokens: 300, cache_read_input_tokens: 600, total_tokens: 1050 };
  for (const groupBy of ['day', 'month', 'project', 'session', 'turn', 'all']) {
    receive({ data: { type: 'usage', result: { groupBy, total: 3,
      rows: [row, { ...row, cache_write_input_tokens: 0, cache_read_input_tokens: 0 },
        { ...row, cache_write_input_tokens: null, cache_read_input_tokens: null }],
      coverage: { files: 1, done: 1, error: 0, interrupted: 0, stale_summaries: 0 },
    } } });
    const table = getElement('usage-table').children[0];
    const start = groupBy === 'turn' ? 3 : 2;
    const headers = table.children[0].children[0].children.slice(start, start + 4);
    assert.deepEqual(headers.map(cell => cell.textContent), ['Input', 'Output', 'Cache Write', 'Cache Read']);
    assert.ok(headers.every(cell => cell.title.length > 0));
    const values = table.children[1].children.map(tr => tr.children.slice(start, start + 5).map(cell => cell.textContent));
    assert.deepEqual(values, [
      ['100', '50', '300', '600', '1,050'], ['1,000', '50', '0', '0', '1,050'], ['—', '50', '—', '—', '1,050'],
    ], groupBy);
  }
});
