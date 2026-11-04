// 세션 시간 인덱스 하나의 전체 갱신·쓰기 트랜잭션·DB/WAL 공간 비용을 고정 로그 사본으로 비교한다.
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { mkdir, mkdtemp, readFile, writeFile, rm, truncate, utimes } = require('node:fs/promises');
const { tmpdir, cpus } = require('node:os');
const { join, resolve, dirname, basename, relative } = require('node:path');
const { performance } = require('node:perf_hooks');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const { refreshSummary } = require('../../dist/src/summary/scanner');
const { buildUsageQuery } = require('../../dist/src/summary/db/queries');
const { makeSnapshot, verify, chooseTarget, inspectCodexTarget, appendRows, claudeRows, codexAppendRows } = require('./incremental-refresh.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul';
const variants = ['A', 'B'];
const scenarios = ['initial', 'unchanged', 'reparse-same', 'codex-append', 'claude-append', 'codex-extend'];
const indexName = 'bench_summary_session_time';
const indexSql = `CREATE INDEX ${indexName} ON turn_summary(provider,session_id,started_at_ms)`;
const sha = value => createHash('sha256').update(value).digest('hex');
const time = () => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());

function fingerprint() {
  const files = [__filename, join(__dirname, 'incremental-refresh.cjs'), join(root, 'package-lock.json')];
  for (const base of ['src', 'dist/src']) for (const name of fs.readdirSync(join(root, base), { recursive: true })) {
    if (/\.(ts|js)$/.test(name)) files.push(join(root, base, name));
  }
  return Object.fromEntries(files.sort().map(file => [relative(root, file).replaceAll('\\', '/'), sha(fs.readFileSync(file))]));
}

function stats(values) {
  assert.ok(values.length);
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0], max: sorted.at(-1), samples: values };
}

function space(db, path) {
  const c = db.connection;
  const checkpoint = c.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  assert.equal(checkpoint.busy, 0);
  const size = c.prepare('PRAGMA page_size').get().page_size;
  const pages = c.prepare('PRAGMA page_count').get().page_count;
  const free = c.prepare('PRAGMA freelist_count').get().freelist_count;
  return { fileBytes: fs.statSync(path).size, liveBytes: (pages - free) * size, freeBytes: free * size,
    indexBytes: c.prepare('SELECT coalesce(sum(pgsize),0) n FROM dbstat WHERE name=?').get(indexName).n };
}

function observe(db) {
  const exec = db.connection.exec.bind(db.connection), replace = db.replaceSessions.bind(db);
  const monitor = { current: undefined, replacing: false, transaction: undefined };
  db.connection.exec = sql => {
    if (!monitor.current) return exec(sql);
    if (sql === 'BEGIN IMMEDIATE') {
      assert.equal(monitor.transaction, undefined);
      const start = performance.now(), result = exec(sql), acquired = performance.now();
      monitor.transaction = { start, acquired, store: monitor.replacing };
      return result;
    }
    if ((sql === 'COMMIT' || sql === 'ROLLBACK') && monitor.transaction) {
      const start = performance.now(), result = exec(sql), end = performance.now(), tx = monitor.transaction;
      monitor.current.transactions.push({ elapsedMs: end - tx.start, beginMs: tx.acquired - tx.start,
        writeSpanMs: end - tx.acquired, commitMs: end - start, store: tx.store, rollback: sql === 'ROLLBACK' });
      monitor.transaction = undefined;
      return result;
    }
    return exec(sql);
  };
  db.replaceSessions = input => {
    if (!monitor.current) return replace(input);
    const start = performance.now(); monitor.replacing = true; monitor.current.storeCalls++;
    try { return replace(input); }
    finally { monitor.replacing = false; monitor.current.storeMs += performance.now() - start; }
  };
  return monitor;
}

function transactionTotals(transactions) {
  const sum = key => transactions.reduce((value, row) => value + row[key], 0);
  return { count: transactions.length, sumMs: sum('elapsedMs'), maxMs: Math.max(0, ...transactions.map(row => row.elapsedMs)),
    beginSumMs: sum('beginMs'), commitSumMs: sum('commitMs'), writeSpanSumMs: sum('writeSpanMs'),
    storeSumMs: transactions.filter(row => row.store).reduce((value, row) => value + row.elapsedMs, 0) };
}

async function worker(configPath, variant, pairText, directory) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'summary.sqlite'), db = new SummaryDatabase(path), targets = [];
  const samples = [], monitor = observe(db);
  try {
    if (variant === 'B') db.connection.exec(indexSql);
    db.connection.exec('PRAGMA main.optimize=0x10002');
    const schemaHash = () => sha(JSON.stringify(db.connection.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE name<>? ORDER BY type,name`).all(indexName)));
    const schemaSha256 = schemaHash();
    for (const [ordinal, scenario] of scenarios.entries()) {
      if (scenario === 'reparse-same') db.connection.exec('UPDATE manifest SET parser_version=0');
      if (scenario === 'codex-append') {
        const target = chooseTarget(db, 'codex', config.directory); targets.push(target);
        await inspectCodexTarget(target, root);
        await appendRows(target, codexAppendRows(target, 'benchmark-incremental-codex', 'benchmark-codex-response'), config.directory, ordinal);
      }
      if (scenario === 'claude-append') {
        const target = chooseTarget(db, 'claude', config.directory); targets.push(target);
        const rows = claudeRows(target.session_id);
        rows[0].cwd = db.connection.prepare('SELECT project_key FROM turn_summary WHERE provider=? AND session_id=? LIMIT 1').get('claude', target.session_id).project_key;
        await appendRows(target, rows, config.directory, ordinal);
      }
      if (scenario === 'codex-extend') await appendRows(targets[0], codexAppendRows(targets[0], 'benchmark-incremental-codex', 'benchmark-codex-extension', 19), config.directory, ordinal);
      space(db, path); global.gc?.();
      const current = { transactions: [], storeMs: 0, storeCalls: 0 };
      monitor.current = current;
      const start = performance.now();
      const result = await refreshSummary(db, { dbPath: path, roots: config.roots }, undefined, progress => {
        if (progress.phase === 'parsing') process.send({ kind: 'progress', scenario });
      });
      const refreshMs = performance.now() - start;
      monitor.current = undefined;
      assert.equal(monitor.transaction, undefined);
      assert.ok(current.transactions.every(tx => !tx.rollback));
      assert.equal(result.interrupted, false); assert.equal(result.error, undefined);
      const queryStart = performance.now();
      db.queryUsagePage({}, 'month', timezone, { limit: 100 }, 'provider');
      const firstPageMs = performance.now() - queryStart;
      const walBytes = fs.existsSync(path + '-wal') ? fs.statSync(path + '-wal').size : 0;
      const checked = verify(db, buildUsageQuery);
      const counts = db.connection.prepare(`SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens,
        count(DISTINCT project_key) projects FROM turn_summary`).get();
      counts.sessions = db.connection.prepare('SELECT count(*) n FROM sessions').get().n;
      if (scenario === 'initial' && config.expected) {
        assert.equal(result.failed, 0); assert.equal(counts.requests, config.expected.requests); assert.equal(counts.tokens, config.expected.tokens);
      }
      if (scenario === 'unchanged') {
        assert.equal(result.bodyBytes, 0); assert.equal(current.storeCalls, 0);
        assert.equal(checked.factsSha256, samples.at(-1).factsSha256);
      }
      if (scenario === 'codex-append' || scenario === 'claude-append') {
        assert.equal(counts.requests, samples.at(-1).requests + 1); assert.equal(counts.tokens, samples.at(-1).tokens + 130);
      }
      if (scenario === 'codex-extend') {
        assert.equal(counts.requests, samples.at(-1).requests); assert.equal(counts.tokens, samples.at(-1).tokens + 26);
      }
      const sample = { scenario, variant, pair: Number(pairText), refreshMs, firstPageMs, refreshAndPageMs: refreshMs + firstPageMs,
        storeMs: current.storeMs, storeCalls: current.storeCalls, transaction: transactionTotals(current.transactions),
        transactions: current.transactions, walBytes, storage: space(db, path),
        parsed: result.parsed, reused: result.reused, discovered: result.discovered, failed: result.failed, bodyBytes: result.bodyBytes,
        ...counts, ...checked, targetRequests: scenario.endsWith('append') ? targets.at(-1).requests : undefined };
      samples.push(sample); process.send({ kind: 'sample', sample });
    }
    assert.equal(schemaHash(), schemaSha256, 'Unexpected schema change');
    let creation;
    if (variant === 'A') {
      const before = space(db, path), start = performance.now();
      db.transaction(() => db.connection.exec(indexSql));
      const createAndCommitMs = performance.now() - start, optimizeStart = performance.now();
      db.connection.exec('PRAGMA main.optimize=0x10002');
      creation = { createAndCommitMs, optimizeMs: performance.now() - optimizeStart, before, after: space(db, path),
        requests: samples.at(-1).requests };
      assert.deepEqual(verify(db, buildUsageQuery), {
        factsSha256: samples.at(-1).factsSha256, aggregatesSha256: samples.at(-1).aggregatesSha256, rawChecks: samples.at(-1).rawChecks });
    }
    process.send({ kind: 'result', samples, creation, schemaSha256,
      pragmas: { synchronous: db.connection.prepare('PRAGMA synchronous').get().synchronous,
        walAutoCheckpoint: db.connection.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint },
      sqlite: db.connection.prepare('SELECT sqlite_version() v').get().v });
  } finally {
    monitor.current = undefined; db.close();
    for (const target of targets) {
      assert.ok(resolve(target.path).startsWith(resolve(config.directory) + require('node:path').sep));
      await truncate(target.path, target.originalBytes); await utimes(target.path, target.originalAtime, target.originalMtime);
    }
  }
}

function runWorker(configPath, variant, pair, directory, label) {
  return new Promise((accept, reject) => {
    const child = fork(__filename, ['--worker', configPath, variant, String(pair), directory],
      { execArgv: ['--expose-gc'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let result, errors = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
    child.on('message', message => {
      if (message.kind === 'result') result = message;
      if (message.kind === 'progress') console.log(`${label} ${pair < 0 ? 'warmup' : `pair ${pair + 1}`} ${variant} ${message.scenario}: parsing`);
      if (message.kind === 'sample') console.log(`${label} ${pair < 0 ? 'warmup' : `pair ${pair + 1}`} ${variant} ${message.sample.scenario}: refresh=${message.sample.refreshMs.toFixed(3)}ms tx=${message.sample.transaction.sumMs.toFixed(3)}ms`);
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 && result ? accept(result) : reject(new Error(`Benchmark worker failed (${code}): ${errors}`)));
  });
}

const metrics = {
  refreshMs: row => row.refreshMs, firstPageMs: row => row.firstPageMs, refreshAndPageMs: row => row.refreshAndPageMs,
  storeMs: row => row.storeMs, transactionSumMs: row => row.transaction.sumMs, transactionMaxMs: row => row.transaction.maxMs,
  storeTransactionSumMs: row => row.transaction.storeSumMs, beginSumMs: row => row.transaction.beginSumMs,
  commitSumMs: row => row.transaction.commitSumMs, walBytes: row => row.walBytes,
  fileBytes: row => row.storage.fileBytes, liveBytes: row => row.storage.liveBytes, indexBytes: row => row.storage.indexBytes,
};

function summarize(samples, pairs) {
  return scenarios.map(scenario => {
    const rows = variants.map(variant => samples.filter(row => row.scenario === scenario && row.variant === variant));
    const result = { scenario, counts: { requests: rows[0][0].requests, sessions: rows[0][0].sessions,
      parsed: rows[0][0].parsed, failed: rows[0][0].failed, bodyBytes: rows[0][0].bodyBytes,
      storeCalls: rows[0][0].storeCalls, transactionCount: rows[0][0].transaction.count, targetRequests: rows[0][0].targetRequests }, metrics: {} };
    for (const [name, read] of Object.entries(metrics)) {
      const A = stats(rows[0].map(read)), B = stats(rows[1].map(read));
      result.metrics[name] = { A, B, difference: B.median - A.median,
        changePercent: A.median ? (B.median / A.median - 1) * 100 : null,
        pairedDifference: stats(Array.from({ length: pairs }, (_, pair) =>
          read(rows[1].find(row => row.pair === pair)) - read(rows[0].find(row => row.pair === pair)))),
        bFasterPairs: rows[0].filter(row => read(rows[1].find(other => other.pair === row.pair)) < read(row)).length };
    }
    return result;
  });
}

async function main() {
  const options = { pairs: 5, warmups: 1, smoke: false, output: resolve(root, 'tests/results/benchmarks/session-time-index-ab.json') };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--smoke') Object.assign(options, { smoke: true, pairs: 1, warmups: 0 });
    else if (arg.startsWith('--pairs=')) options.pairs = Number(arg.slice(8));
    else if (arg.startsWith('--output=')) options.output = resolve(arg.slice(9));
    else throw new Error(`Unknown option: ${arg}`);
  }
  assert.ok(Number.isSafeInteger(options.pairs) && options.pairs >= 1 && options.pairs <= 20);
  assert.ok(!fs.existsSync(options.output), 'Use a new output path');
  const hashes = fingerprint(), directory = await mkdtemp(join(tmpdir(), 'agent-tracker-session-time-index-'));
  const report = { startedAtSeoul: time(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    sourceSha256: hashes, variants: { A: 'current product', B: indexSql }, options: { pairs: options.pairs, warmups: options.warmups },
    environment: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model, cacheKiB: 4096, tempStore: 'FILE', mmapBytes: 0 },
    method: {
      inputs: 'Freeze logs once per dataset. Fresh isolated process and empty DB for each variant/pair; identical sources and scenario sequence; alternating AB/BA; one excluded warmup pair.',
      treatment: 'Only one nonunique persistent index differs. Product source, query SQL, other indexes, schema version and runtime are identical. Same product optimize on both variants.',
      refresh: 'refreshSummary wall time includes scan, local lock, parsing, aggregation preparation, replaceSessions, commit and product optimize. UI/IPC/account calls excluded. First monthly page is separately timed.',
      transactions: 'Intercept BEGIN IMMEDIATE through COMMIT return. Sum and max per refresh, BEGIN and COMMIT subtimes, plus replaceSessions transactions only. No competing writer. Reader transactions excluded. Equal instrumentation in both variants.',
      storage: 'Main file and live/free pages after successful TRUNCATE checkpoint, no VACUUM; dbstat index allocation. WAL sampled before correctness and checkpoint, after first page; auto-checkpoint remains enabled.',
      creation: 'After final scenario, A creates the index on populated data inside one transaction. DDL+COMMIT timed separately from optimize and checkpoint; before/after file and live/index bytes retained.',
      correctness: 'Full raw/rollup result comparisons for ten group/provider-model combinations, semantic facts/aggregate hashes, FK and integrity checks per scenario. A/B and across-pair counts and hashes must match; appended token/request deltas asserted.',
      limits: 'Single machine, warm OS cache, five pairs by default; no cache reset. Transactions are software-observed elapsed times including callback execution. TEMP-only work can be inside a write transaction. Timing hooks add small equal overhead. Private bodies, names, session IDs and source paths omitted.',
    }, datasets: [] };
  try {
    const datasets = options.smoke ? [{ name: 'smoke', requests: 200, turns: 100 }] : [
      { name: 'real-logs', real: true }, { name: 'synthetic-10000-100', requests: 10000, turns: 100 },
      { name: 'synthetic-10000-1000', requests: 10000, turns: 1000 },
    ];
    for (const dataset of datasets) {
      const work = join(directory, dataset.name); await mkdir(work);
      const snapshot = await makeSnapshot(work, { after: root, real: Boolean(dataset.real), requests: dataset.requests ?? 0, 'turns-per-session': dataset.turns ?? 100 });
      console.log(`${dataset.name}: frozen ${snapshot.files.length} files, ${snapshot.inventory.reduce((sum, row) => sum + row.bytes, 0)} bytes`);
      const configPath = join(work, 'config.json');
      await writeFile(configPath, JSON.stringify({ directory: work, roots: snapshot.roots, expected: snapshot.expected }));
      const trials = [];
      for (let pair = -options.warmups; pair < options.pairs; pair++) {
        const pairResults = [];
        for (const variant of pair >= 0 && pair % 2 ? [...variants].reverse() : variants) {
          pairResults.push(await runWorker(configPath, variant, pair, join(work, `pair-${pair}-${variant}`), dataset.name));
        }
        assert.equal(pairResults[0].schemaSha256, pairResults[1].schemaSha256);
        for (const scenario of scenarios) {
          const rows = pairResults.map(trial => trial.samples.find(row => row.scenario === scenario));
          for (const key of ['factsSha256', 'aggregatesSha256', 'parsed', 'reused', 'failed', 'bodyBytes', 'requests', 'tokens', 'storeCalls']) assert.equal(rows[0][key], rows[1][key], `${dataset.name}/${scenario}/${key}`);
          assert.equal(rows[0].transaction.count, rows[1].transaction.count);
        }
        if (pair >= 0) trials.push(...pairResults);
      }
      for (const file of snapshot.files) {
        const digest = createHash('sha256');
        for await (const chunk of fs.createReadStream(file.path)) digest.update(chunk);
        assert.equal(digest.digest('hex'), file.sha256, 'Frozen source was not restored');
      }
      const samples = trials.flatMap(trial => trial.samples);
      for (const scenario of scenarios) for (const key of ['factsSha256', 'aggregatesSha256']) assert.equal(new Set(samples.filter(row => row.scenario === scenario).map(row => row[key])).size, 1);
      report.environment.sqlite = trials[0].sqlite; report.environment.pragmas = trials[0].pragmas;
      report.datasets.push({ name: dataset.name, inventory: snapshot.inventory, inputSha256: snapshot.sha256,
        summary: summarize(samples, options.pairs), creation: trials.filter(trial => trial.creation).map(trial => trial.creation), samples });
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
    }
    assert.deepEqual(fingerprint(), hashes);
    report.completedAtSeoul = time(); report.sourceAndSnapshotHashesVerified = true;
    await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Saved ${options.output}`);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('agent-tracker-session-time-index-') && !fs.lstatSync(directory).isSymbolicLink());
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (require.main === module) {
  if (process.argv[2] === '--worker') worker(...process.argv.slice(3)).then(() => process.disconnect(), error => { console.error(error.stack); process.exitCode = 1; process.disconnect(); });
  else main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
