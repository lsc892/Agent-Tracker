// 고정 제품 사본과 실제 refreshSummary로 prefix 해시 증분의 시간·공간·정합성을 비교한다.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { fork } = require('node:child_process');
const { join, resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { serialize } = require('node:v8');
const { performance } = require('node:perf_hooks');
const { cpus } = require('node:os');
const helpers = require('./incremental-refresh.cjs');
const { allUsage, independentCheck } = require('./temp-batch-ab.cjs');
const { loadHashers, validateHashers } = require('./jsonl-algorithms/hashers.cjs');
const root = resolve(__dirname, '../..');
const filter = { fromMs: Date.UTC(2020, 0, 1), toMs: Date.UTC(2035, 0, 1), unknownTime: 'include', excludeEmptyUsage: false };
const groups = ['day', 'month', 'session', 'project'];
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item));
function fingerprint(directory) {
  return digest(readdirSync(directory, { recursive: true }).filter(name => statSync(join(directory, name)).isFile()).sort()
    .map(name => [name.replaceAll('\\', '/'), sha(readFileSync(join(directory, name)))]));
}
function facts(db) {
  return digest(['turn_summary', 'turn_model_usage', 'turn_capability_usage', 'turn_costs'].map(table =>
    db.connection.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all().map(helpers.normalized)));
}
async function child(configPath, variant) {
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const product = variant === 'A' ? config.before : config.after;
  if (variant !== 'A' && variant !== 'sha256' && variant !== 'threads4') {
    const providers = await loadHashers();
    require(join(product, 'dist/src/summary/scanner/sourceHash')).createSourceHasher = () => providers[variant].create();
  }
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const table = variant === 'A' ? 'manifest' : 'source_file';
  const preparation = require(join(product, 'dist/src/summary/scanner/sourcePreparation'));
  const originalPrepare = preparation.prepareSource;
  let parsedRows = 0, resumed = 0, fallbacks = 0, fileWorkerPeak = 0;
  const { SourceReaderPool } = require(join(product, 'dist/src/summary/scanner/sourcePool'));
  const originalRead = SourceReaderPool.prototype.read;
  SourceReaderPool.prototype.read = async function(...args) {
    const result = await originalRead.apply(this, args);
    fileWorkerPeak = Math.max(fileWorkerPeak, this.slots?.size ?? 0);
    if (result.ok) { parsedRows += result.read.parsedRows ?? result.read.rows; resumed += Number(result.read.resumed ?? false); fallbacks += Number(result.read.fallback ?? false); }
    return result;
  };
  const dbPath = join(config.directory, `work-${variant}.sqlite`);
  const samples = [], initialization = [];
  const gated = process.argv.includes('--gated');
  const permit = () => gated ? new Promise(done => { process.once('message', done); process.send({ ready: true }); }) : Promise.resolve();
  for (const scenario of config.scenarios ?? ['append', 'update-existing', 'unchanged', 'middle-rewrite', 'middle-insert']) {
    await permit();
    const db = new SummaryDatabase(dbPath);
    const options = { dbPath, roots: config.snapshot.roots, sourceWorkers: variant === 'threads4' ? 4 : 1 };
    const start = performance.now();
    const initial = await refreshSummary(db, options);
    assert.equal(initial.interrupted, false);
    initialization.push({ scenario, elapsedMs: performance.now() - start, failed: initial.failed });
    const target = db.connection.prepare(`SELECT * FROM ${table} WHERE provider='codex' AND processing_status='done'
      AND path NOT LIKE '%.zst' AND json_extract(source_identity,'$[1]')=1
      AND EXISTS(SELECT 1 FROM turn_summary t WHERE t.provider=${table}.provider AND t.session_id=${table}.session_id)
      ORDER BY size_bytes DESC LIMIT 1`).get();
    assert.ok(target, 'A plain Codex source is required');
    const base = await fs.readFile(target.path), stat = await fs.stat(target.path);
    target.originalBytes = stat.size;
    await helpers.inspectCodexTarget(target, product);
    const rows = helpers.codexAppendRows(target, 'prefix-benchmark-request', 'prefix-benchmark-response');
    const extra = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    let changed = Buffer.concat([base, extra]);
    if (scenario === 'unchanged' || scenario === 'same-content-touch') changed = base;
    if (scenario === 'update-existing') {
      const prepared = await originalPrepare(target, { collectCapabilities: true, cancelled: () => false }); assert.ok(prepared.ok);
      const accepted = new Set(db.connection.prepare('SELECT root_turn_id FROM turn_summary WHERE provider=? AND session_id=?').all(target.provider, target.session_id).map(row => row.root_turn_id));
      const event = [...prepared.winners.winners.values()].filter(value => value.event.schema === 'current' && accepted.has(value.event.rootId)).sort((a, b) => b.index - a.index)[0]?.event;
      assert.ok(event, 'Existing update requires an accepted current-format response');
      const raw = value => ({ input_tokens: value.input + 123, output_tokens: value.output + 7,
        cached_input_tokens: value.cacheRead, cache_write_input_tokens: value.cacheWrite, reasoning_output_tokens: value.reasoning });
      const payload = { root_turn_id: event.rootId, thread_id: event.threadId, turn_id: event.turnId, response_id: event.responseId,
        model: event.model, billing_mode: event.billingMode, usage: raw(event.tokens) };
      const check = [...prepared.winners.roots.values()].flatMap(value => [...value.checks.values()]).find(value => value.event.threadId === event.threadId && value.event.turnId === event.turnId)?.event;
      if (check) payload.turn_token_usage = raw(check.tokens);
      changed = Buffer.concat([base, Buffer.from(JSON.stringify({ type: 'token_usage_record', timestamp: '2026-10-28T12:00:03Z', payload }) + '\n')]);
    }
    if (scenario === 'middle-rewrite') {
      changed = Buffer.from(base);
      const index = changed.indexOf(Buffer.from('"input_tokens":'));
      assert.ok(index >= 0);
      const position = index + '"input_tokens":'.length;
      changed[position] = changed[position] === 49 ? 50 : 49;
    }
    if (scenario === 'middle-insert') {
      const offset = base.indexOf(10) + 1;
      changed = Buffer.concat([base.subarray(0, offset), extra, base.subarray(offset)]);
    }
    const baseline = db.connection.prepare('SELECT count(*) requests,sum(total_tokens) tokens FROM turn_summary').get();
    for (let iteration = -3; iteration < 10; iteration++) {
      if (iteration !== -3) await permit();
      // 복구 및 재검증은 측정 밖이다. 후보의 파서 상태도 실제 복구 갱신으로 맞춘다.
      await fs.writeFile(target.path, base);
      await fs.utimes(target.path, stat.atime, stat.mtime);
      if (variant === 'A') db.connection.prepare(`UPDATE ${table} SET parser_version=0 WHERE id=?`).run(target.id);
      await refreshSummary(db, options);
      await fs.writeFile(target.path, changed);
      // 같은 크기·mtime 수정도 검사한다. A의 기존 fingerprint 취약점은 별도 결과로 기록한다.
      const time = scenario === 'middle-rewrite' || scenario === 'unchanged' && config.preserveMtime !== false
        ? stat.mtime : new Date('2026-11-19T01:00:00Z');
      await fs.utimes(target.path, time, time);
      if (scenario === 'middle-rewrite' && variant === 'A') db.connection.prepare(`UPDATE ${table} SET parser_version=0 WHERE id=?`).run(target.id);
      global.gc?.();
      parsedRows = 0; resumed = 0; fallbacks = 0; fileWorkerPeak = 0;
      const memoryBefore = process.memoryUsage();
      let peak = { ...memoryBefore };
      const sampleMemory = () => { const memory = process.memoryUsage(); for (const key of Object.keys(memory)) peak[key] = Math.max(peak[key], memory[key]); };
      const timer = setInterval(sampleMemory, 5);
      const started = performance.now();
      const refreshed = await refreshSummary(db, options);
      const elapsedMs = performance.now() - started;
      sampleMemory(); clearInterval(timer);
      assert.equal(refreshed.interrupted, false);
      if (scenario === 'unchanged' && config.preserveMtime !== false) {
        if (!initial.failed && (variant === 'A' || !config.snapshot.inventory.some(item => item.compressed > 0)))
          assert.equal(parsedRows, 0, 'True unchanged complete plain input must not parse rows');
        if (variant === 'A' && !initial.failed) assert.equal(refreshed.bodyBytes, 0, 'The metadata baseline skips truly unchanged bodies');
      }
      const totals = db.connection.prepare('SELECT count(*) requests,sum(total_tokens) tokens FROM turn_summary').get();
      if (scenario === 'append') assert.deepEqual({ ...totals }, { ...baseline, requests: baseline.requests + 1, tokens: baseline.tokens + 130 });
      if (scenario === 'update-existing') assert.deepEqual({ ...totals }, { ...baseline, tokens: baseline.tokens + 130 });
      const queries = {};
      for (const group of groups) {
        const queryStart = performance.now();
        const result = allUsage(db, group, filter);
        const ms = performance.now() - queryStart;
        queries[group] = { ms, digest: digest(result.map(helpers.normalized)), independent: independentCheck(db, filter, group, result) };
      }
      assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      samples.push({ scenario, iteration, measured: iteration >= 0, elapsedMs, scan: refreshed.timings.scan,
        bytes: refreshed.bodyBytes, parsedRows, resumed, fallbacks, fileWorkerPeak, failed: refreshed.failed, totals, facts: facts(db), queries,
        memoryBefore, peak, memoryAfter: process.memoryUsage(), cacheSerializedBytes: db.sourceCheckpoints ? serialize(db.sourceCheckpoints).length : 0 });
      await fs.writeFile(target.path, base); await fs.utimes(target.path, stat.atime, stat.mtime);
      await fs.writeFile(join(config.directory, `${variant}.partial.json`), JSON.stringify({ samples, initialization }));
      if (gated && iteration !== 9) process.send({ sample: samples.at(-1) });
    }
    await fs.writeFile(target.path, base); await fs.utimes(target.path, stat.atime, stat.mtime);
    db.close();
    for (const suffix of ['', '-wal', '-shm']) await fs.rm(dbPath + suffix, { force: true });
    if (gated) process.send({ sample: samples.at(-1) });
  }
  process.send({ samples, initialization });
}
async function launch(configPath, variant) {
  return new Promise((done, fail) => {
    const child = fork(__filename, ['--child', configPath, variant], { execArgv: ['--expose-gc', '--no-warnings'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });
    let result;
    child.on('message', message => { result = message; });
    child.on('error', fail); child.on('exit', code => code === 0 && result ? done(result) : fail(new Error(`${variant} exited ${code}`)));
  });
}
async function launchGated(configPath, variant) {
  return new Promise((done, fail) => {
    const worker = fork(__filename, ['--child', configPath, variant, '--gated'], { execArgv: ['--expose-gc', '--no-warnings'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });
    let pending, ready = false;
    const samples = []; let result;
    worker.on('message', message => {
      if (message.ready && !ready) { ready = true; done({ measure: () => new Promise(resolve => { pending = resolve; worker.send({ go: true }); }), samples, finish: () => result, close: () => worker.kill() }); }
      if (message.sample) { samples.push(message.sample); pending(message.sample); }
      if (message.samples) result = message;
    });
    worker.on('error', fail); worker.on('exit', code => { if (code) { const error = new Error(`${variant} exited ${code}`); if (pending) pending(Promise.reject(error)); else fail(error); } });
  });
}
async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=') || true]; }));
  let workspace = args.workspace;
  if (!workspace) {
    workspace = await fs.mkdtemp(join(root, 'tests/.cache/prefix-hash-'));
    const before = join(workspace, 'before');
    await fs.mkdir(before);
    const baseline = resolve(args.before || root);
    for (const folder of ['src', 'dist']) await fs.cp(join(baseline, folder), join(before, folder), { recursive: true });
    await fs.symlink(join(root, 'node_modules'), join(before, 'node_modules'), 'junction');
    const configs = [];
    for (const [name, requests, turns] of [['current', 0, 100], ['synthetic-10000', 10000, 100], ['synthetic-100', 100, 10]]) {
      const directory = join(workspace, name); await fs.mkdir(directory);
      const snapshot = await helpers.makeSnapshot(directory, { after: before, real: !requests, requests, 'turns-per-session': turns });
      const configPath = join(directory, 'config.private.json');
      await fs.writeFile(configPath, JSON.stringify({ name, directory, snapshot, before, after: resolve(args.after || root) }));
      configs.push(configPath);
    }
    await fs.writeFile(join(workspace, 'setup.json'), JSON.stringify({ configs, after: resolve(args.after || root), source: fingerprint(join(before, 'src')), build: fingerprint(join(before, 'dist/src')) }));
  }
  const setup = JSON.parse(await fs.readFile(join(workspace, 'setup.json'), 'utf8'));
  console.log(JSON.stringify({ workspace }));
  if (args['prepare-only']) return;
  const variants = args.baseline ? ['A'] : args.variants ? String(args.variants).split(',') : ['A', 'sha256', 'blake3', 'xxh128'];
  const scenarios = args.scenarios ? String(args.scenarios).split(',') : ['append', 'update-existing', 'unchanged', 'same-content-touch', 'middle-rewrite', 'middle-insert'];
  for (const configPath of setup.configs) {
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (args.datasets && !String(args.datasets).split(',').includes(config.name)) continue;
    config.scenarios = scenarios;
    await fs.writeFile(configPath, JSON.stringify(config));
    if (!args.baseline) {
      const children = new Map();
      try {
        for (const variant of variants) children.set(variant, await launchGated(configPath, variant));
        for (const scenario of scenarios) for (let iteration = -3; iteration < 10; iteration++) {
          const order = Math.abs(iteration) % 2 ? [...variants].reverse() : variants;
          let reference;
          for (const variant of order) {
            const sample = await children.get(variant).measure();
            assert.equal(sample.scenario, scenario); assert.equal(sample.iteration, iteration);
            if (reference) {
              assert.deepEqual({ facts: sample.facts, totals: sample.totals, failed: sample.failed },
                { facts: reference.facts, totals: reference.totals, failed: reference.failed }, `${config.name}/${scenario}/${variant}`);
              for (const group of groups) assert.equal(sample.queries[group].digest, reference.queries[group].digest);
            } else reference = sample;
            if (iteration >= 0) console.log(JSON.stringify({ dataset: config.name, scenario, iteration, variant, ms: +sample.elapsedMs.toFixed(2) }));
          }
        }
        for (const [variant, worker] of children) {
          const saved = JSON.parse(await fs.readFile(join(config.directory, `${variant}.partial.json`), 'utf8'));
          await fs.writeFile(join(config.directory, `${variant}.json`), JSON.stringify(saved));
        }
      } finally { for (const worker of children.values()) worker.close(); }
      continue;
    }
    for (const variant of variants) {
      const result = await launch(configPath, variant);
      await fs.writeFile(join(config.directory, `${variant}.json`), JSON.stringify(result));
      console.log(JSON.stringify({ dataset: config.name, variant, samples: result.samples.length }));
    }
  }
  if (!args.baseline) {
    const report = { date: '2026-11-19', environment: { node: process.version, cpu: cpus()[0].model, platform: process.platform },
      protocol: { warmups: 3, repetitions: 10, order: 'forward/reverse variants on alternating iterations; one active child', sourceWorkers: Object.fromEntries(variants.map(variant => [variant, variant === 'threads4' ? 4 : 1])), cache: 'warm OS cache', intervalMs: 5 },
      before: { source: setup.source, build: setup.build }, after: { source: fingerprint(join(setup.after ?? root, 'src')), build: fingerprint(join(setup.after ?? root, 'dist/src')) },
      hashValidation: await validateHashers(), datasets: [] };
    for (const configPath of setup.configs) {
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      if (args.datasets && !String(args.datasets).split(',').includes(config.name)) continue;
      const results = {};
      for (const variant of variants) results[variant] = JSON.parse(await fs.readFile(join(config.directory, `${variant}.json`), 'utf8'));
      const expected = results[variants[0]].samples;
      for (const variant of variants) for (let i = 0; i < expected.length; i++) {
        const a = expected[i], b = results[variant].samples[i];
        assert.deepEqual({ facts: b.facts, totals: b.totals, failed: b.failed }, { facts: a.facts, totals: a.totals, failed: a.failed }, `${config.name}/${variant}/${a.scenario}/${i}`);
        for (const group of groups) assert.equal(b.queries[group].digest, a.queries[group].digest);
      }
      for (const file of config.snapshot.files) assert.equal(sha(await fs.readFile(file.path)), file.sha256);
      report.datasets.push({ name: config.name, inventory: config.snapshot.inventory, inputSha256: config.snapshot.sha256, expected: config.snapshot.expected, results });
    }
    const output = args.output || join(root, 'docs/benchmarks/2026-11-19/PrefixHashAB-2026-11-19.json');
    await fs.mkdir(resolve(output, '..'), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ complete: true, output }));
  }
}
if (process.argv[2] === '--child') child(process.argv[3], process.argv[4]).then(() => process.disconnect()).catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
else main().catch(error => { console.error(error); process.exitCode = 1; });
