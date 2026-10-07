import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SummaryDatabase } from '../../src/summary/db';
import { PARSER_VERSION, refreshSummary } from '../../src/summary/scanner';

const jsonl = (rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

test('Claude error notices retain request outcomes without model responses and v11 caches rebuild unchanged sources', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracker-model-notices-'));
  const root = join(directory, 'projects');
  await mkdir(join(root, 'session', 'subagents'), { recursive: true });
  const db = new SummaryDatabase(join(directory, 'db.sqlite'));
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const options = { dbPath: join(directory, 'db.sqlite'), roots: [{ provider: 'claude' as const, path: root }] };
  const user = (promptId: string) => ({ type: 'user', sessionId: 'session', promptId, timestamp: '2026-10-07T00:00:00Z' });
  const response = (promptId: string, input: number) => ({ type: 'assistant', promptId, requestId: promptId,
    timestamp: '2026-10-07T00:00:03Z', message: { id: promptId, model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn', usage: { input_tokens: input, output_tokens: 5 } } });
  const notice = (promptId: string, id: string) => ({ type: 'assistant', promptId, isApiErrorMessage: true,
    timestamp: '2026-10-07T00:00:04Z', error: 'rate_limit', message: { id, model: '<synthetic>',
      stop_reason: 'stop_sequence', usage: { input_tokens: 0, output_tokens: 0 } } });
  await writeFile(join(root, 'session.jsonl'), jsonl([
    user('spent-before-error'), response('spent-before-error', 10), notice('spent-before-error', 'error-one'),
    user('notice-only'), notice('notice-only', 'error-two'), user('success'), response('success', 20),
  ]));
  await writeFile(join(root, 'session', 'subagents', 'agent-error.jsonl'), jsonl([notice('success', 'child-error')]));
  assert.equal((await refreshSummary(db, options)).failed, 0);
  const turns = db.queryTurns();
  assert.equal(turns.length, 3);
  assert.equal(turns.find(row => row.root_turn_id === 'spent-before-error')!.status, 'failed');
  assert.equal(turns.find(row => row.root_turn_id === 'notice-only')!.status, 'failed');
  assert.equal(turns.find(row => row.root_turn_id === 'success')!.status, 'completed');
  assert.equal(db.queryUsage()[0].total_tokens, 40);
  assert.equal(db.queryUsage()[0].avg_tokens_per_turn, 25);
  const models = db.queryCapabilities({}, 'model');
  assert.equal(models.totalUses, 2);
  assert.equal(models.rows[0].name, 'claude-sonnet-4-6');
  assert.equal(models.rows[0].percentage, 100);
  assert.equal(db.queryTurns({}, {}, 'model').find(row => row.root_turn_id === 'notice-only')!.model, null);
  assert.equal(db.queryUsage({}, 'total', 'UTC', {}, 'model').some(row => row.model === '<synthetic>'), false);

  db.connection.exec(`UPDATE manifest SET parser_version=11;
    INSERT INTO turn_model_usage SELECT id,'<synthetic>',0,0,0,0,NULL,'old' FROM turn_summary WHERE root_turn_id='notice-only';
    INSERT INTO turn_capability_usage SELECT id,'model','<synthetic>',1 FROM turn_summary WHERE root_turn_id='notice-only';`);
  assert.equal(db.queryCapabilities({}, 'model').totalUses, 3);
  const rebuilt = await refreshSummary(db, options);
  assert.equal(rebuilt.failed, 0);
  assert.equal(rebuilt.parsed, 2, 'both unchanged sources are reparsed');
  assert.equal(db.queryCapabilities({}, 'model').totalUses, 2);
  assert.equal(db.queryUsage()[0].total_tokens, 40);
  assert.ok(db.connection.prepare('SELECT parser_version FROM manifest').all().every(row => row.parser_version === PARSER_VERSION));
  assert.equal((await refreshSummary(db, options)).parsed, 0, 'the repair runs only once');
});

test('Codex empty snapshots do not add model uses or an empty model to real requests, while unknown tokens remain', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracker-model-empty-'));
  const root = join(directory, 'sessions');
  await mkdir(root);
  const db = new SummaryDatabase(join(directory, 'db.sqlite'));
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const options = { dbPath: join(directory, 'db.sqlite'), roots: [{ provider: 'codex' as const, path: root }] };
  const lifecycle = (type: string, turn_id: string) => ({ type: 'event_msg', timestamp: '2026-10-07T00:00:00Z', payload: { type, turn_id } });
  const count = (input: number, output: number) => ({ type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, output_tokens: output }, last_token_usage: { input_tokens: input, output_tokens: output },
  } } });
  await writeFile(join(root, 'session.jsonl'), jsonl([
    { type: 'session_meta', payload: { id: 'session', cwd: '/project' } },
    lifecycle('task_started', 'empty'), count(0, 0), lifecycle('task_complete', 'empty'),
    lifecycle('task_started', 'known'), count(0, 0),
    { type: 'turn_context', payload: { turn_id: 'known', model: 'gpt-6.1-sol' } }, count(80, 20), lifecycle('task_complete', 'known'),
    lifecycle('task_started', 'unknown'), { type: 'turn_context', payload: { turn_id: 'unknown' } },
    { type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 100, output_tokens: 25 }, last_token_usage: { input_tokens: 20, output_tokens: 5 },
    } } }, lifecycle('task_complete', 'unknown'),
    lifecycle('task_started', 'without-usage'), lifecycle('task_complete', 'without-usage'),
  ]));
  assert.equal((await refreshSummary(db, options)).failed, 0);
  assert.equal(db.queryUsage()[0].turn_count, 4);
  assert.equal(db.queryUsage()[0].total_tokens, 125);
  const turns = db.queryTurns({}, {}, 'model');
  assert.deepEqual(turns.map(row => row.model), [null, 'gpt-6.1-sol', '', null]);
  assert.equal(turns.find(row => row.model === '')!.total_tokens, 25);
  const models = db.queryCapabilities({}, 'model');
  assert.equal(models.totalUses, 2);
  assert.deepEqual(models.rows.map(row => [row.name, row.usage_count, row.percentage]), [['', 1, 50], ['gpt-6.1-sol', 1, 50]]);
});
