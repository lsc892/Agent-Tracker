// prefix 전체 검증·완성 줄 재개·중간 변경 복구를 독립 전체 파싱 및 DB 결과와 대조한다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, appendFile, stat, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SummaryDatabase } from '../../src/summary/db';
import { refreshSummary, PARSER_VERSION } from '../../src/summary/scanner';
import { prepareSource, type SourceCheckpoint, type SourceFile } from '../../src/summary/scanner/sourcePreparation';
import { SourceReaderPool } from '../../src/summary/scanner/sourcePool';

const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const meta = { type: 'session_meta', payload: { id: 'session', cwd: '/prefix/project' } };
const turn = (id: string) => ({ type: 'turn_context', payload: { root_turn_id: id, turn_id: id } });
const usage = (id: string, input = 123) => ({ type: 'token_usage_record', payload: { root_turn_id: id,
  turn_id: id, response_id: `response-${id}`, usage: { input_tokens: input, output_tokens: 7 } } });
const sha = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');

async function source(path: string, id = 1): Promise<SourceFile> {
  const info = await stat(path);
  return { id, provider: 'codex', source_root: join(path, '..'), path, session_id: null,
    size_bytes: info.size, mtime_ms: info.mtimeMs, dev: String(info.dev), inode: String(info.ino), parser_version: PARSER_VERSION };
}

test('prefix hash covers raw UTF-8, CRLF and filtered images; only complete appended rows are parsed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracker-prefix-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'session.jsonl');
  const prefix = jsonl([meta, turn('one'), usage('one'), { type: 'response_item', payload: { text: '한글 😀', image: 'data:image/png;base64,' + 'A'.repeat(150000) } }]).replaceAll('\n', '\r\n');
  const suffix = JSON.stringify(usage('one', 150));
  await writeFile(path, prefix + suffix.slice(0, 25));
  const checkpoints = new Map<string, SourceCheckpoint>();
  const pool = new SourceReaderPool({ workers: 1, checkpoints, collectCapabilities: true, cancelled: () => false });
  t.after(() => pool.dispose());
  const initial = await pool.read(await source(path)); assert.ok(initial.ok);
  assert.equal(initial.read.position, Buffer.byteLength(prefix)); assert.equal(initial.read.prefixHash, sha(prefix));
  assert.equal(initial.read.contentHash, sha(prefix + suffix.slice(0, 25)));
  await appendFile(path, suffix.slice(25) + '\n');
  const appended = await pool.read(await source(path)); assert.ok(appended.ok);
  assert.equal(appended.read.resumed, true); assert.equal(appended.read.parsedRows, 1);
  assert.equal(appended.read.prefixHash, sha(prefix + suffix + '\n'));
  const complete = await prepareSource(await source(path), { collectCapabilities: true, cancelled: () => false }); assert.ok(complete.ok);
  assert.deepEqual(appended.winners, complete.winners); assert.deepEqual(appended.read.identity, complete.read.identity);
  const unchanged = await pool.read(await source(path)); assert.ok(unchanged.ok);
  assert.equal(unchanged.read.parsedRows, 0); assert.equal(unchanged.bytes, Buffer.byteLength(prefix + suffix + '\n'));
});

test('same-size same-mtime rewrites, insertions, truncation and failure retry match full parsing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracker-prefix-edits-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'session.jsonl');
  const checkpoints = new Map<string, SourceCheckpoint>();
  const pool = new SourceReaderPool({ workers: 1, checkpoints, collectCapabilities: true, cancelled: () => false }); t.after(() => pool.dispose());
  const initial = jsonl([meta, turn('one'), usage('one')]);
  await writeFile(path, initial); assert.ok((await pool.read(await source(path))).ok);
  const before = await stat(path);
  const rewritten = initial.replace('123', '456');
  await writeFile(path, rewritten); await utimes(path, before.atime, before.mtime);
  const rewrite = await pool.read(await source(path)); assert.ok(rewrite.ok);
  assert.equal(rewrite.read.resumed, false); assert.equal(rewrite.read.fallback, true);
  for (const value of [jsonl([meta, turn('two'), usage('two')]) + rewritten.slice(JSON.stringify(meta).length + 1),
    jsonl([meta, turn('one')]), initial + '{broken}\n', initial + jsonl([usage('one', 789)])]) {
    await writeFile(path, value);
    const actual = await pool.read(await source(path));
    const expected = await prepareSource(await source(path), { collectCapabilities: true, cancelled: () => false });
    assert.equal(actual.ok, expected.ok);
    if (actual.ok && expected.ok) {
      assert.deepEqual(actual.winners, expected.winners); assert.deepEqual(actual.read.identity, expected.read.identity);
      assert.equal(actual.read.prefixHash, sha(value));
    } else assert.equal(checkpoints.size, 0, 'Failed mutable state is discarded');
  }
});

test('worker preparation resumes checkpoints and returns the same winners as full sequential parsing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracker-prefix-worker-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = [join(directory, 'one.jsonl'), join(directory, 'two.jsonl')];
  for (const path of paths) await writeFile(path, jsonl([meta, turn('one'), usage('one'), { padding: 'x'.repeat(600000) }]));
  const checkpoints = new Map<string, SourceCheckpoint>();
  for (let round = 0; round < 2; round++) {
    const pool = new SourceReaderPool({ workers: 2, checkpoints, collectCapabilities: true, cancelled: () => false });
    try {
      if (round) for (const path of paths) await appendFile(path, jsonl([usage('one', 456)]));
      const files = await Promise.all(paths.map((path, i) => source(path, i + 1))); pool.prefetch(files);
      for (const file of files) {
        const actual = await pool.read(file), expected = await prepareSource(file, { collectCapabilities: true, cancelled: () => false });
        assert.ok(actual.ok && expected.ok); assert.deepEqual(structuredClone(actual.winners), structuredClone(expected.winners));
        assert.equal(actual.read.resumed, round === 1); if (round) assert.equal(actual.read.parsedRows, 1);
      }
    } finally { await pool.dispose(); }
  }
});

test('DB migrates the former manifest, detects restored-mtime edits, and rebuilds after reopening', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracker-prefix-db-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'session.jsonl'), dbPath = join(directory, 'summary.sqlite');
  const options = { dbPath, roots: [{ provider: 'codex' as const, path: directory }], sourceWorkers: 1 };
  const text = jsonl([meta, turn('one'), usage('one')]); await writeFile(path, text);
  let db = new SummaryDatabase(dbPath);
  try {
    assert.equal((await refreshSummary(db, options)).failed, 0);
    assert.equal(db.queryTurns()[0].total_tokens, 130);
    const info = await stat(path); await writeFile(path, text.replace('123', '456')); await utimes(path, info.atime, info.mtime);
    assert.equal((await refreshSummary(db, options)).failed, 0); assert.equal(db.queryTurns()[0].total_tokens, 463);
    assert.equal(db.findSourceFile('codex', path)?.complete_position, Buffer.byteLength(text));
    db.connection.exec(`ALTER TABLE source_file DROP COLUMN complete_position; ALTER TABLE source_file DROP COLUMN prefix_hash;
      ALTER TABLE source_file RENAME TO manifest; PRAGMA user_version=19;`);
    db.close(); db = new SummaryDatabase(dbPath);
    assert.equal(db.connection.prepare("SELECT count(*) n FROM sqlite_master WHERE name='manifest'").get()?.n, 0);
    assert.equal(db.queryTurns()[0].total_tokens, 463);
    const reopened = await refreshSummary(db, options); assert.equal(reopened.failed, 0); assert.equal(reopened.parsed, 1);
    assert.equal(db.queryTurns()[0].total_tokens, 463);
    assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
    db.clearData(); assert.equal(db.sourceCheckpoints.size, 0);
  } finally { db.close(); }
});
