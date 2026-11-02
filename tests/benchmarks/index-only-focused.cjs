// 사용자 우선순위: 대량 최초 수집은 단회, 조회·증분은 반복하고 같은 완성 DB를 재사용한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdir, mkdtemp, rm, writeFile, utimes } = require('node:fs/promises');
const { join, resolve, dirname, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { performance } = require('node:perf_hooks');
const { backup } = require('node:sqlite');
const Module = require('node:module');
const { openDatabase } = require('./index-only-candidate.cjs');
const { synthetic, fingerprint, sessionText, fixedMtime, sha } = require('./index-only-fixtures.cjs');
const { seedSynthetic } = require('./sql-explain.cjs');

// 앞선 실행기의 측정 함수를 그대로 로드한다. 제품 모듈·파일은 수정하지 않는다.
const filename = join(__dirname, 'index-only.cjs'), loaded = new Module(filename, module);
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(__dirname);
loaded._compile(fs.readFileSync(filename, 'utf8') + '\nObject.assign(module.exports,{hashes,time,inventory,factHash,integrity,space,readBench,refresh,writeBench,readyPair,stats,paired});', filename);
const h = loaded.exports, variants = ['A', 'B'], timezone = 'Asia/Seoul';

async function clonePair(directory, name, dbs) {
  const result = {};
  for (const v of variants) {
    const path = join(directory, `${name}-${v}.sqlite`);
    await backup(dbs[v].connection, path); result[v] = openDatabase(path, v);
  }
  return result;
}
function expected(db, snapshot) {
  if (snapshot.expected) for (const key of ['requests', 'tokens', 'sessions', 'projects']) {
    assert.equal(h.inventory(db)[key], snapshot.expected[key], key);
  }
}
async function singleInitial(directory, name, snapshot) {
  const dbs = {}, samples = {}, spaces = {};
  try {
  for (const v of variants) {
    const path = join(directory, `${name}-${v}.sqlite`), begin = performance.now(), db = openDatabase(path, v);
    const setup = performance.now() - begin;
    dbs[v] = db;
    let components = 0;
    const replace = db.replaceSessions;
    db.replaceSessions = function(...args) {
      const value = replace.apply(this, args);
      if (++components % 500 === 0) console.log(`${name} ${v}: committed ${components}/10000 sessions; elapsed=${((performance.now()-begin)/1000).toFixed(1)}s`);
      return value;
    };
    const result = await h.refresh(db, path, snapshot.roots);
    db.replaceSessions = replace;
    const queryStart = performance.now(); db.queryUsagePage({}, 'month', timezone, { limit: 100 }, 'model');
    const firstQuery = performance.now() - queryStart;
    h.integrity(db); expected(db, snapshot);
    const space = h.space(db, path); spaces[v] = space;
    samples[v] = { ...result, setupMs: setup, firstQueryMs: firstQuery,
      readyTotalMs: result.refreshTotalMs + firstQuery, setupThroughReadyMs: setup + result.refreshTotalMs + firstQuery };
    console.log(`${name} ${v} done: ${result.refreshTotalMs.toFixed(1)} ms`);
  }
  assert.equal(h.factHash(dbs.A), h.factHash(dbs.B));
  const one = v => {
    const s = samples[v]; return { samples: [s], refresh: h.stats([s.refreshTotalMs]), store: h.stats([s.storeCallMs]),
      firstQuery: h.stats([s.firstQueryMs]), readyTotal: h.stats([s.readyTotalMs]), setup: h.stats([s.setupMs]), setupThroughReady: h.stats([s.setupThroughReadyMs]) };
  };
  return { dbs, spaces, result: { name: `${name}-initial`, measuredCount: 1, singleObservation: true, executionOrder: ['A', 'B'],
    userOverride: 'Large initial ingestion limited to one observation per variant; no warmup or second diagnostic ingestion.',
    resultSha256: h.factHash(dbs.A), variants: { A: one('A'), B: one('B') },
    paired: h.paired([samples.A.refreshTotalMs], [samples.B.refreshTotalMs]),
    diagnostics: Object.fromEntries(variants.map(v => [v, { ...samples[v], reads: null, tempMaxAllocatedBytes: null,
      directStatementWrites: null, unavailableReason: 'User limited large initial ingestion to one; heavy diagnostics were not mixed into the timed observation.',
      storageAfter: { fileBytes: spaces[v].fileBytes, allocatedBytes: spaces[v].allocatedBytes, freelistPages: spaces[v].freelistPages, tables: spaces[v].tables } }])) } };
  } catch (error) { Object.values(dbs).forEach(db => db.close()); throw error; }
}
async function incremental(directory, name, snapshot, dbs, options) {
  const base = await clonePair(directory, `${name}-base`, dbs);
  try {
    // 파일당 세션·요청이 1개인 합성 입력에서 끝의 50세션만 실제 삭제 API로 제거한다.
    for (const v of variants) {
      const selected = snapshot.files.slice(-50);
      base[v].replaceSessions({ sessions: selected.map(f => ({ provider: f.provider, session_id: f.session })),
        summaries: [], files: [], removedFileIds: selected.map(f => base[v].findManifest(f.provider, f.path).id), retainDeletedSourceUsage: false });
      assert.equal(h.inventory(base[v]).sessions, snapshot.expected.sessions - 50);
      base[v].connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
    assert.equal(h.factHash(base.A), h.factHash(base.B));
    const delta = await h.writeBench(directory, 'delta-50', snapshot, options, base);
    delta.priorStateConstruction = 'Full snapshot minus final 50 independent synthetic sessions via product replacement API; pages/freelist and statistics history retained; same snapshot restored for every trial.';
    const unchanged = await h.writeBench(directory, 'unchanged', snapshot, options, dbs);
    return [delta, unchanged];
  } finally { Object.values(base).forEach(db => db.close()); }
}
async function longWrites(directory, snapshot, dbs, options) {
  const target = snapshot.files[0], original = fs.readFileSync(target.path), baseline = sessionText(target, snapshot.longTurns);
  const changes = [1, 31, 32, 33, 50].map(amount => ({ name: `append-${amount}`, amount, value: sessionText(target, snapshot.longTurns + amount) }));
  changes.push({ name: 'delete-one', amount: -1, value: sessionText(target, snapshot.longTurns - 1) });
  const edited = original.toString().trimEnd().split('\n').map(line => JSON.parse(line));
  const usage = edited.find(r => r.message?.usage || r.payload?.usage);
  (usage.message?.usage ?? usage.payload.usage).input_tokens += 7;
  changes.push({ name: 'edit-one', amount: 0, value: { text: edited.map(r => JSON.stringify(r)).join('\n') + '\n', tokens: baseline.tokens + 7 } });
  changes.push({ name: 'all-changed', amount: 0, value: sessionText({ ...target, ordinal: target.ordinal + 1 }, snapshot.longTurns) });
  const writes = [];
  for (const change of changes) {
    const changed = { ...snapshot, expected: { ...snapshot.expected, requests: snapshot.expected.requests + change.amount,
      tokens: snapshot.expected.tokens + change.value.tokens - baseline.tokens } };
    writes.push(await h.writeBench(directory, change.name, changed, options, dbs, snapshot.roots, async () => {
      await writeFile(target.path, change.value.text); await utimes(target.path, fixedMtime, new Date('2026-10-02T00:00:00Z'));
      return async () => { await writeFile(target.path, original); await utimes(target.path, fixedMtime, fixedMtime); };
    }));
  }
  return writes;
}
async function main() {
  const options = { previous: '', output: 'docs/benchmarks/2026-10-31/DbTradeoff-index-only-focused.json', readSamples: 9, writeSamples: 5 };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--previous=')) options.previous = resolve(arg.slice(11));
    else if (arg.startsWith('--output=')) options.output = resolve(arg.slice(9));
    else throw new Error(`Unknown option: ${arg}`);
  }
  assert.ok(options.previous, '--previous must name the completed real/small dataset report');
  const output = resolve(options.output); assert.ok(!fs.existsSync(output), 'Use a new output name');
  const parent = JSON.parse(fs.readFileSync(options.previous, 'utf8'));
  // The stopped run finished these datasets; the interrupted warmup is not a measurement.
  assert.deepEqual(parent.datasets.map(d => d.name), ['real-365', 'small-300', 'small-500']);
  const sourceHashes = h.hashes(); assert.deepEqual(sourceHashes, parent.sourceHashes, 'Completed dataset sources changed');
  const runnerSha256 = sha(fs.readFileSync(__filename));
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-index-focused-'));
  const report = { ...parent, sourceHashes, focusedStartedSeoul: h.time(),
    resumedFrom: { file: basename(options.previous), sha256: sha(fs.readFileSync(options.previous)), completedDatasets: parent.datasets.map(d => d.name) },
    focusedRunnerSha256: runnerSha256,
    method: { ...parent.method, userOverride: '2026-10-31 user: prioritize queries/incremental; large initial ingestion A/B once each.',
      largeInitial: 'One sequential observation A then B. No warmup or heavy diagnostic rerun. No dispersion claim. Progress output once per 500 commits is included.',
      largeLongInitial: 'Reuse normal 10,000-session snapshot and parse/replace only the changed 1,000-request session; no second full large initial ingestion.',
      incrementalBaseline: 'Large 9,950-state created from full snapshot by removing last 50 independent sessions through product API; prior history/freelist retained and disclosed.' },
    datasets: structuredClone(parent.datasets) };
  const save = async () => { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
  let largeDbs;
  try {
    const large = await synthetic(join(directory, 'large'), 100, 100), largeInput = await fingerprint(large);
    await save();
    const largeResult = await singleInitial(directory, 'large-100x100', large);
    largeDbs = largeResult.dbs;
    const dataset = { name: 'large-100x100', input: largeInput, expected: large.expected, longTurns: 1,
      counts: h.inventory(largeDbs.A), space: largeResult.spaces, writes: [largeResult.result], reads: h.readBench(largeDbs, options) };
    report.datasets.push(dataset); await save();
    dataset.writes.push(...await incremental(directory, 'large-100x100', large, largeDbs, options)); await save();

    const smallLong = await synthetic(join(directory, 'small-long'), 10, 30, 1000), smallInput = await fingerprint(smallLong);
    const small = { name: 'small-long-1000', input: smallInput, expected: smallLong.expected, longTurns: 1000,
      writes: [await h.writeBench(directory, 'small-long-1000-initial', smallLong, options)] };
    const smallDbs = await h.readyPair(directory, smallLong, 'small-long');
    try {
      small.counts = h.inventory(smallDbs.A); small.space = Object.fromEntries(variants.map(v => [v, h.space(smallDbs[v], join(directory, `small-long-${v}.sqlite`))]));
      small.reads = h.readBench(smallDbs, options); small.writes.push(...await longWrites(directory, smallLong, smallDbs, options));
    } finally { Object.values(smallDbs).forEach(db => db.close()); }
    assert.deepEqual(await fingerprint(smallLong), smallInput); report.datasets.push(small); await save();

    const target = large.files[0], normal = fs.readFileSync(target.path), longText = sessionText(target, 1000), longDbs = await clonePair(directory, 'large-long', largeDbs);
    try {
      await writeFile(target.path, longText.text); await utimes(target.path, fixedMtime, fixedMtime);
      const long = { ...large, longTurns: 1000, expected: { ...large.expected, requests: large.expected.requests + 999,
        tokens: large.expected.tokens + longText.tokens - sessionText(target, 1).tokens },
        files: [{ ...target, requests: 1000, bytes: Buffer.byteLength(longText.text), sha256: sha(longText.text) }, ...large.files.slice(1)] };
      const input = await fingerprint(long), preparation = {};
      for (const v of variants) preparation[v] = await h.refresh(longDbs[v], join(directory, `large-long-${v}.sqlite`), long.roots);
      assert.equal(h.factHash(longDbs.A), h.factHash(longDbs.B));
      const d = { name: 'large-long-1000', input, expected: long.expected, longTurns: 1000, initialStateFrom: 'large-100x100 plus changed one session (not fresh W1)',
        preparation, counts: h.inventory(longDbs.A), space: Object.fromEntries(variants.map(v => [v, h.space(longDbs[v], join(directory, `large-long-${v}.sqlite`))])),
        reads: h.readBench(longDbs, options), writes: await longWrites(directory, long, longDbs, options) };
      assert.deepEqual(await fingerprint(long), input); report.datasets.push(d); await save();
    } finally {
      Object.values(longDbs).forEach(db => db.close()); await writeFile(target.path, normal); await utimes(target.path, fixedMtime, fixedMtime);
    }
    assert.deepEqual(await fingerprint(large), largeInput);
    const edge = {};
    for (const v of variants) {
      edge[v] = openDatabase(join(directory, `edge-${v}.sqlite`), v); seedSynthetic(edge[v], 500);
      edge[v].connection.exec(`UPDATE turn_model_usage SET cache_read_input_tokens=NULL WHERE turn_id%19=0;
        UPDATE turn_summary SET cache_read_input_tokens=NULL WHERE id%19=0;
        UPDATE turn_model_usage SET model='' WHERE turn_id%23=0 AND model NOT LIKE '%helper';`);
      edge[v].queryUsagePage({}, 'month', timezone, { limit: 100 }, 'model');
    }
    try { report.edgeCases = { counts: h.inventory(edge.A), reads: h.readBench(edge, options, ['include', 'only'].flatMap(unknownTime => [false, true].map(excludeEmptyUsage => ({
      id: 'Q1', period: `unknown-${unknownTime}-excludeEmpty-${excludeEmptyUsage}`, group: 'day', filter: { unknownTime, excludeEmptyUsage } })))) }; }
    finally { Object.values(edge).forEach(db => db.close()); }
    assert.deepEqual(h.hashes(), sourceHashes); assert.equal(sha(fs.readFileSync(__filename)), runnerSha256);
    report.completedSeoul = h.time(); await save(); console.log(`Saved ${output}`);
  } finally {
    Object.values(largeDbs ?? {}).forEach(db => db.close());
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('agent-tracker-index-focused-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
