// 실제 제품 빌드의 JSONL 준비 경로에서 파일 읽기·파싱 시간과 피크 메모리를 비교한다.
'use strict';
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { cpus } = require('node:os');
const { join, relative, resolve, sep } = require('node:path');
const { performance } = require('node:perf_hooks');
const { serialize } = require('node:v8');
const { makeSnapshot, normalized } = require('./incremental-refresh.cjs');
const { allUsage, independentCheck } = require('./temp-batch-ab.cjs');

const root = resolve(__dirname, '../..');
const warmups = 2;
const variants = ['before', 'after'];
const hash = () => createHash('sha256');
const sha = value => hash().update(value).digest('hex');

async function fingerprint(directory) {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  const paths = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
  const digest = hash();
  for (const path of paths) digest.update(JSON.stringify([relative(directory, path).replaceAll('\\', '/'), sha(await fs.readFile(path))]));
  return digest.digest('hex');
}

async function identify(product) {
  return {
    source: await fingerprint(join(product, 'src')),
    build: await fingerprint(join(product, 'dist/src')),
    reader: sha(await fs.readFile(join(product, 'src/summary/jsonl/index.ts'))),
  };
}

async function prepareCases(directory, product) {
  const cases = [];
  for (const [name, requests, perSession] of [['current', 0, 0], ['synthetic-10000', 10000, 100], ['synthetic-100', 100, 10]]) {
    const snapshot = await makeSnapshot(join(directory, name), {
      real: requests === 0, requests, 'turns-per-session': perSession, after: product,
    });
    const files = [];
    for (const [index, file] of snapshot.files.entries()) {
      const source = snapshot.roots.find(item => file.path.startsWith(item.path + sep));
      assert.ok(source);
      const stat = await fs.lstat(file.path);
      assert.equal(stat.size, file.bytes);
      files.push({ ...file, id: index + 1, provider: source.provider, source_root: source.path,
        size_bytes: stat.size, mtime_ms: stat.mtimeMs, dev: String(stat.dev), inode: String(stat.ino) });
    }
    cases.push({ name, files, roots: snapshot.roots, expected: snapshot.expected, inputSha256: snapshot.sha256 });
    if (name === 'current') {
      for (const provider of ['claude', 'codex']) {
        const largest = files.filter(file => file.provider === provider && !/\.zst$/i.test(file.path))
          .sort((a, b) => b.bytes - a.bytes)[0];
        if (largest) cases.push({ name: `largest-${provider}-jsonl`, files: [largest], inputSha256: largest.sha256 });
      }
    }
  }
  return cases;
}

function launch(product, config, index, phase) {
  return new Promise((done, fail) => {
    const child = fork(__filename, ['--worker', product, config, String(index), phase], {
      execArgv: ['--expose-gc'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    let result, error = '';
    child.stderr.on('data', data => { error += data; });
    child.on('message', message => { result = message; });
    child.on('error', fail);
    child.on('exit', code => code === 0 && result ? done(result) : fail(new Error(error || `Worker exit ${code}`)));
  });
}

async function verifyRefresh(product, config, spec) {
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const db = new SummaryDatabase(':memory:');
  const options = { dbPath: resolve(config, '..', 'verify.sqlite'), roots: spec.roots, timezone: 'Asia/Seoul', sourceWorkers: 1 };
  try {
    const initial = await refreshSummary(db, options);
    assert.equal(initial.interrupted, false);
    assert.equal(initial.failed, 0);
    assert.equal(initial.parsed, spec.files.length);
    assert.equal(initial.bodyBytes, spec.files.reduce((sum, file) => sum + file.bytes, 0));
    const unchanged = await refreshSummary(db, options);
    assert.equal(unchanged.interrupted, false);
    assert.equal(unchanged.failed, 0);
    assert.equal(unchanged.bodyBytes, 0);
    assert.equal(unchanged.parsed, 0);
    assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const totals = db.connection.prepare('SELECT count(*) requests, coalesce(sum(total_tokens),0) tokens FROM turn_summary').get();
    const digest = hash();
    const facts = [
      'SELECT * FROM turn_summary ORDER BY provider,session_id,root_turn_id',
      'SELECT v.* FROM turn_model_usage v JOIN turn_summary t ON v.turn_id=t.id ORDER BY t.provider,t.session_id,t.root_turn_id,v.model',
      'SELECT v.* FROM turn_capability_usage v JOIN turn_summary t ON v.turn_id=t.id ORDER BY t.provider,t.session_id,t.root_turn_id,v.category,v.name',
      'SELECT v.* FROM turn_costs v JOIN turn_summary t ON v.turn_id=t.id ORDER BY t.provider,t.session_id,t.root_turn_id',
    ];
    for (const sql of facts) {
      digest.update(sql);
      for (const row of db.connection.prepare(sql).iterate()) digest.update(JSON.stringify(normalized(row)));
    }
    const filter = { fromMs: Date.UTC(2020, 0, 1), toMs: Date.UTC(2035, 0, 1), unknownTime: 'include', excludeEmptyUsage: false };
    const groups = Object.fromEntries(['day', 'month', 'session', 'project'].map(group =>
      [group, independentCheck(db, filter, group, allUsage(db, group, filter))]));
    return { ...totals, initialBytes: initial.bodyBytes, unchangedBytes: unchanged.bodyBytes, factsSha256: digest.digest('hex'), groups };
  } finally { db.close(); }
}

const memory = () => {
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
  return { rss, heapUsed, external, arrayBuffers };
};

async function worker(product, config, index, phase) {
  const spec = JSON.parse(await fs.readFile(config, 'utf8')).cases[index];
  const { prepareSource } = require(join(product, 'dist/src/summary/scanner/sourcePreparation'));
  const reader = require(join(product, 'dist/src/summary/jsonl'));
  const options = { collectCapabilities: true, cancelled: () => false };
  async function parse(digest, sample) {
    let rows = 0, partialLines = 0;
    for (const file of spec.files) {
      const result = await prepareSource(file, options);
      sample?.();
      assert.ok(result.ok, result.error?.code);
      assert.equal(result.read.contentHash, file.sha256);
      rows += result.read.rows;
      partialLines += Number(result.read.partialLine);
      digest?.update(serialize(result));
    }
    return { rows, partialLines };
  }
  if (phase === 'verify') {
    const digest = hash(), counts = await parse(digest);
    process.send({ ...counts, outputSha256: digest.digest('hex'), ...(spec.roots && { db: await verifyRefresh(product, config, spec) }) });
    return;
  }

  const readJsonl = reader.readJsonl;
  global.gc();
  const startMemory = memory(), peak = { ...startMemory }, keys = Object.keys(peak);
  const sample = () => {
    const used = memory();
    for (const key of keys) peak[key] = Math.max(peak[key], used[key]);
  };
  reader.readJsonl = (path, size, onRow, readOptions) => {
    let rows = 0;
    return readJsonl(path, size, (row, offset) => {
      const result = onRow(row, offset);
      if (++rows === 1 || rows % 64 === 0) sample();
      return result;
    }, { ...readOptions, processBatch(run) { sample(); run(); sample(); } });
  };
  const counts = await parse(undefined, sample);
  const peakRss = process.resourceUsage().maxRSS * 1024;
  reader.readJsonl = readJsonl;

  global.gc();
  const start = performance.now();
  const timedCounts = await parse();
  const ms = performance.now() - start;
  assert.deepEqual(timedCounts, counts);
  process.send({ ms, peakRss, startMemory, peak, counts });
}

function stats(samples) {
  const getters = { ms: s => s.ms, rss: s => s.peakRss, heap: s => s.peak.heapUsed,
    rssIncrease: s => s.peakRss - s.startMemory.rss, heapIncrease: s => s.peak.heapUsed - s.startMemory.heapUsed,
    externalIncrease: s => s.peak.external - s.startMemory.external,
    bufferIncrease: s => s.peak.arrayBuffers - s.startMemory.arrayBuffers };
  return Object.fromEntries(Object.entries(getters).map(([key, get]) => {
    const values = samples.map(get).sort((a, b) => a - b);
    return [key, { median: (values[Math.floor(values.length / 2)] + values[Math.floor((values.length - 1) / 2)]) / 2,
      min: values[0], max: values.at(-1) }];
  }));
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--(before|after|workspace|output|pairs)=(.+)$/.exec(arg);
    assert.ok(match, `Unknown option ${arg}`);
    return match.slice(1);
  }));
  assert.ok(args.before, 'Specify --before=<built baseline>');
  const before = resolve(args.before);
  if (!args.workspace) {
    assert.ok(!args.after && !args.output, 'Prepare the input and run the baseline first with --before alone');
    await fs.mkdir(join(root, 'tests/.cache'), { recursive: true });
    const workspace = await fs.mkdtemp(join(root, 'tests/.cache/jsonl-product-'));
    const config = join(workspace, 'input.private.json');
    const cases = await prepareCases(workspace, before);
    console.log(`Snapshot workspace: ${relative(root, workspace)}`);
    await fs.writeFile(config, JSON.stringify({ cases }));
    const build = await identify(before);
    const sample = await launch(before, config, 0, 'measure');
    await fs.writeFile(join(workspace, 'before.json'), JSON.stringify({ build, sample }));
    console.log(JSON.stringify({ beforeChange: sample }));
    return;
  }

  assert.ok(args.after && args.output, 'Specify --after and --output with --workspace');
  const pairs = Number(args.pairs ?? 5);
  assert.ok(Number.isInteger(pairs) && pairs >= 3);
  const products = { before, after: resolve(args.after) };
  const config = resolve(args.workspace, 'input.private.json');
  const baseline = JSON.parse(await fs.readFile(resolve(args.workspace, 'before.json'), 'utf8'));
  const report = { environment: { node: process.version, v8: process.versions.v8, cpu: cpus()[0].model, platform: process.platform, arch: process.arch },
    protocol: { warmups, pairs, order: 'AB/BA; one fresh child at a time', sourceWorkers: 1, cache: 'OS cache warmed, not flushed',
      time: 'second pass after GC; actual prepareSource, includes I/O and hashing, excludes measurement probes and SQLite',
      memory: 'first pass after GC; process high-water RSS and sampled heapUsed/external/arrayBuffers before and after each batch, first/every 64th row, file end' },
    builds: { before: await identify(before), after: await identify(products.after) },
    runnerSha256: sha(await fs.readFile(__filename)), beforeChange: baseline.sample, cases: [] };
  assert.deepEqual(report.builds.before, baseline.build);
  assert.notEqual(report.builds.before.reader, report.builds.after.reader);
  const { cases } = JSON.parse(await fs.readFile(config, 'utf8'));
  for (const [index, spec] of cases.entries()) {
    const verified = await launch(before, config, index, 'verify');
    assert.deepEqual(await launch(products.after, config, index, 'verify'), verified);
    if (spec.expected) {
      assert.equal(verified.db.requests, spec.expected.requests);
      assert.equal(verified.db.tokens, spec.expected.tokens);
    }
    const samples = { before: [], after: [] };
    const counts = { rows: verified.rows, partialLines: verified.partialLines };
    for (let pair = 0; pair < warmups + pairs; pair++) {
      for (const variant of pair % 2 ? [...variants].reverse() : variants) {
        const sample = await launch(products[variant], config, index, 'measure');
        assert.deepEqual(sample.counts, counts);
        if (pair >= warmups) samples[variant].push(sample);
      }
      console.log(`${spec.name} ${pair + 1}/${warmups + pairs}`);
    }
    report.cases.push({ name: spec.name, files: spec.files.length, bytes: spec.files.reduce((sum, file) => sum + file.bytes, 0),
      largestFileBytes: Math.max(...spec.files.map(file => file.bytes)), compressedFiles: spec.files.filter(file => /\.zst$/i.test(file.path)).length,
      inputSha256: spec.inputSha256, verified, expected: spec.expected,
      variants: Object.fromEntries(variants.map(variant => [variant, { ...stats(samples[variant]), samples: samples[variant] }])) });
  }
  for (const variant of variants) assert.deepEqual(await identify(products[variant]), report.builds[variant]);
  const output = resolve(args.output);
  await fs.mkdir(resolve(output, '..'), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(output);
}

(process.argv[2] === '--worker' ? worker(...process.argv.slice(3)) : main())
  .catch(error => { console.error(error); process.exitCode = 1; });
