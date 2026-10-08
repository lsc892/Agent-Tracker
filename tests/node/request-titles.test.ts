import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SummaryDatabase } from '../../src/summary/db';
import { refreshSummary } from '../../src/summary/scanner';
import { project, requestTitle } from '../../src/summary/parsers/common';

test('Windows project keys merge drive, separator and directory case while POSIX case stays distinct', () => {
  const canonical = project('C:\\Users\\Example\\ProjectFarm');
  assert.equal(canonical.projectName, 'ProjectFarm');
  for (const path of ['c:\\Users\\Example\\ProjectFarm', 'C:/users/example/ProjectFarm/', 'c:\\users\\EXAMPLE\\projectfarm']) {
    assert.equal(project(path).projectKey, canonical.projectKey);
  }
  assert.notEqual(project('/ProjectFarm').projectKey, project('/projectfarm').projectKey);
  assert.equal(project('\\\\Server\\Share\\Project').projectKey, project('\\\\server\\share\\project').projectKey);
});

test('request titles are bounded text and prefer user requests over Codex editor context', () => {
  assert.equal(requestTitle('# Context from my IDE setup:\n\n## My request:\nFix this title\nFull body omitted'), 'Fix this title');
  assert.equal(requestTitle([{ type: 'image', data: 'ignored' }, { type: 'text', text: 'Title\nBody' }]), 'Title');
  assert.equal(requestTitle('x'.repeat(200))!.length, 80);
  assert.equal(requestTitle([{ type: 'tool_result', content: 'not a request' }]), undefined);
});

test('v7 summaries migrate without losing tokens or session metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracker-title-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'db.sqlite');
  const previous = new SummaryDatabase(path);
  previous.replaceSessions({ files: [], sessions: [{ provider: 'claude', session_id: 's' }], summaries: [{
    provider: 'claude', project_key: '/project', project_name: 'Project', session_id: 's', session_name: 'Session',
    root_turn_id: 'r', duration_quality: 'missing', input_tokens: 10, output_tokens: 5,
    total_tokens: 15, status: 'completed',
  }] });
  previous.connection.exec('ALTER TABLE turn_summary DROP COLUMN request_title; PRAGMA user_version=7');
  previous.close();
  const migrated = new SummaryDatabase(path);
  try {
    assert.equal(migrated.queryTurns()[0].request_title, null);
    assert.equal(migrated.queryTurns()[0].session_name, 'Session');
    assert.equal(migrated.queryUsage()[0].total_tokens, 15);
  } finally { migrated.close(); }
});

test('rebuild merges ProjectFarm model rows and persists bounded titles through both parsers and model charts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracker-titles-'));
  const root = join(directory, 'logs'); await mkdir(root);
  const db = new SummaryDatabase(join(directory, 'db.sqlite'));
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const options = { dbPath: join(directory, 'db.sqlite'), roots: [{ provider: 'codex' as const, path: root }] };
  const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  for (const [id, cwd] of [['a', 'C:\\Work\\ProjectFarm'], ['b', 'c:/work/ProjectFarm']]) {
    await writeFile(join(root, `${id}.jsonl`), jsonl([
      { type: 'session_meta', payload: { id, cwd } },
      { type: 'event_msg', timestamp: '2026-10-08T00:00:00Z', payload: { type: 'task_started', turn_id: 'r' } },
      { type: 'event_msg', payload: { type: 'user_message', message: `Request ${id}\nPrivate body omitted` } },
      { type: 'turn_context', payload: { turn_id: 'r', model: 'gpt-5.6-sol' } },
      { type: 'token_usage_record', payload: { turn_id: 'r', response_id: id, usage: { input_tokens: 10, output_tokens: 5 } } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'r' } },
    ]));
  }
  assert.equal((await refreshSummary(db, options)).failed, 0);
  assert.deepEqual(db.queryTurns().map(row => row.request_title), ['Request a', 'Request b']);
  assert.equal(db.queryUsage({}, 'project', 'UTC', {}, 'model').length, 1);
  assert.equal(db.queryUsage({}, 'project', 'UTC', {}, 'model')[0].total_tokens, 30);
  assert.equal(db.queryCapabilities({}, 'model').totalUses, 2);
  assert.equal(db.queryNames({ kind: 'project' }).total, 1);
  assert.deepEqual(db.queryUsageChart({}, 'turn', 'UTC', 'tokens', 'model').rows.map(row => 'request_title' in row ? row.request_title : null).sort(), ['Request a', 'Request b']);
  db.connection.prepare('INSERT INTO projects VALUES (?,?)').run('C:\\Work\\ProjectFarm', 'ProjectFarm');
  db.connection.prepare('UPDATE turn_summary SET project_key=? WHERE session_id=?').run('C:\\Work\\ProjectFarm', 'a');
  db.connection.exec('UPDATE manifest SET parser_version=12');
  assert.equal(db.queryUsage({}, 'project', 'UTC', {}, 'model').length, 2, 'old case-sensitive keys reproduce the duplicate');
  assert.equal((await refreshSummary(db, options)).parsed, 2);
  assert.equal(db.queryUsage({}, 'project', 'UTC', {}, 'model').length, 1);
  assert.equal(db.queryUsage({}, 'project', 'UTC', {}, 'model')[0].total_tokens, 30);
  const claudeRoot = join(directory, 'claude'); await mkdir(claudeRoot);
  await writeFile(join(claudeRoot, 'claude.jsonl'), jsonl([
    { type: 'user', sessionId: 'claude', promptId: 'c', cwd: '/project', message: { content: [{ type: 'text', text: 'Claude title\nHidden body' }] } },
    { type: 'assistant', promptId: 'c', requestId: 'response', message: { id: 'response', model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } } },
  ]));
  assert.equal((await refreshSummary(db, { ...options, roots: [{ provider: 'claude', path: claudeRoot }] })).failed, 0);
  assert.equal(db.queryTurns({ provider: 'claude' })[0].request_title, 'Claude title');
  assert.ok(!JSON.stringify(db.connection.prepare('SELECT request_title FROM turn_summary').all()).includes('Hidden body'));
});
