import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

test('transaction benchmark measures the actual refresh and verifies before/after without personal logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-transaction-test-'));
  try {
    const report = join(directory, 'report.md');
    await promisify(execFile)(process.execPath, [resolve(__dirname, '../../../tests/benchmarks/summary-transactions.cjs'),
      '--pairs', '1', '--report', report], { timeout:60000, windowsHide:true });
    const lines = (await readFile(join(directory, 'benchmarks/report.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line));
    assert.equal(lines[0].input, 'fixture');
    assert.equal(lines[0].inventory[0].files, 1);
    const prepares = lines.filter(row => row.kind === 'prepare');
    assert.equal(prepares.length, 4);
    for (const row of prepares) {
      assert.equal(row.insideExplicitTransaction, false);
      assert.equal(row.requests, 30);
      assert.equal(row.titleCandidates, 30);
      assert.ok(row.elapsedMs > 0);
      assert.equal(row.usesTitleIndex, row.variant === 'partial-index');
      assert.equal(row.indexBytes > 0, row.variant === 'partial-index');
    }
    const transactions = lines.filter(row => row.kind === 'transaction');
    assert.ok(transactions.some(row => row.mode === 'BEGIN DEFERRED' && row.purpose === 'temp-parse-batch'));
    assert.ok(transactions.some(row => row.mode === 'BEGIN IMMEDIATE' && row.purpose === 'replace-sessions'));
    for (const row of transactions) {
      assert.equal(row.outcome, 'COMMIT');
      assert.ok(row.elapsedMs >= 0 && row.before.rssBytes > 0 && row.after.main.allocatedBytes > 0);
    }
    const refreshes = lines.filter(row => row.kind === 'refresh');
    assert.equal(refreshes.length, 6);
    for (const scenario of ['initial', 'rebuild', 'unchanged']) {
      const pair = refreshes.filter(row => row.scenario === scenario);
      assert.equal(pair[0].outputDigest, pair[1].outputDigest);
      assert.equal(pair[0].requests, 30);
      assert.equal(pair[0].tokens, 450);
      if (scenario === 'unchanged') for (const row of pair) {
        assert.equal(row.bodyBytes, 0);
        assert.equal(row.components, 0);
        assert.equal(row.prepareMs, 0);
      }
    }
    const log = JSON.stringify(lines);
    for (const sensitive of ['Title 0', 'fixture.jsonl', tmpdir(), 'session_id', 'request_title']) {
      assert.ok(!log.includes(sensitive), `Log must omit transcript values and paths: ${sensitive}`);
    }
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('agent-tracker-transaction-test-'));
    await rm(directory, { recursive:true, force:true });
  }
});
