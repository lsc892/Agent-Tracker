import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { acquireRefreshLock } from '../src/summary/lock';
import { SummaryDatabase } from '../src/summary/db';

const fixture = resolve(__dirname, '../../tests/fixtures/summary-lock.cjs');
const config = (databasePath: string) => ({ databasePath, lockModule: require.resolve('../src/summary/lock') });

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Lock fixture timed out')), 5000); })]); }
  finally { clearTimeout(timer); }
}

function track(target: Worker | ChildProcess): { acquired: Promise<void>; waiting: Promise<void>; events: string[] } {
  const events: string[] = [];
  let acquired!: () => void;
  let waiting!: () => void;
  const result = { events, acquired: new Promise<void>(resolve => { acquired = resolve; }), waiting: new Promise<void>(resolve => { waiting = resolve; }) };
  target.on('message', value => { events.push(value as string); if (value === 'acquired') acquired(); if (value === 'waiting') waiting(); });
  return result;
}

test('a killed lock owner and terminated waiter release OS locks without deleting another owner', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tracker-lock-crash-'));
  const databasePath = join(directory, 'summary.sqlite');
  const owner = fork(fixture, [JSON.stringify(config(databasePath))], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const ownerState = track(owner);
  const workers: Worker[] = [];
  try {
    await within(ownerState.acquired);
    const first = new Worker(fixture, { workerData: config(databasePath) }); workers.push(first);
    const second = new Worker(fixture, { workerData: config(databasePath) }); workers.push(second);
    const states = [track(first), track(second)];
    await within(Promise.all(states.map(state => state.waiting)));
    await delay(150);
    assert.ok(states.every(state => !state.events.includes('acquired')));
    const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
    const winner = await within(Promise.race(states.map((state, index) => state.acquired.then(() => index))));
    await delay(150);
    assert.equal(states[1 - winner].events.includes('acquired'), false, 'only one waiter holds the lock');
    await workers[winner].terminate();
    await within(states[1 - winner].acquired);
    await workers[1 - winner].terminate();
    const release = await acquireRefreshLock(databasePath);
    await release(); await release();
    const lock = new DatabaseSync(`${databasePath}.refresh-lock.sqlite`);
    try { assert.equal(lock.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get()!.n, 0); }
    finally { lock.close(); }
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) { const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited; }
    await Promise.all(workers.map(worker => worker.terminate()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('waiting for a refresh lock is cancellable and leaves the active owner intact', { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tracker-lock-cancel-'));
  const databasePath = join(directory, 'summary.sqlite');
  const release = await acquireRefreshLock(databasePath);
  const controller = new AbortController();
  try {
    const waiting = acquireRefreshLock(databasePath, controller.signal);
    controller.abort();
    await assert.rejects(waiting, /interrupted/);
    const competitor = new DatabaseSync(`${databasePath}.refresh-lock.sqlite`);
    try { competitor.exec('PRAGMA busy_timeout=0'); assert.throws(() => competitor.exec('BEGIN EXCLUSIVE'), /locked/); }
    finally { competitor.close(); }
  } finally { await release(); await rm(directory, { recursive: true, force: true }); }
});

test('refresh locking leaves summary writes available and ignores legacy owner files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tracker-lock-separate-'));
  const databasePath = join(directory, 'summary.sqlite');
  await writeFile(`${databasePath}.lock`, '');
  const database = new SummaryDatabase(databasePath);
  const release = await acquireRefreshLock(databasePath);
  try {
    database.connection.exec('PRAGMA busy_timeout=0');
    database.observeFile({ provider: 'claude', source_root: directory, path: join(directory, 'fixture.jsonl'), session_id: null,
      size_bytes: 0, mtime_ms: 0, dev: null, inode: null, parser_version: 1 }, 'test');
    assert.equal(database.diagnostics().counts.files, 1);
    assert.equal(await readFile(`${databasePath}.lock`, 'utf8'), '');
  } finally { await release(); database.close(); await rm(directory, { recursive: true, force: true }); }
});
