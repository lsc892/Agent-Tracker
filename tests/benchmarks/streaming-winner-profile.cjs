// 본 A/B와 분리해 파일 읽기·메모리 집계 마무리·최종 저장의 비용을 진단한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { join, resolve, dirname } = require('node:path');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const helpers = require('./incremental-refresh.cjs');

async function main() {
  const [configPath, variant, outputPath] = process.argv.slice(2);
  assert.ok(configPath && ['A', 'B'].includes(variant) && outputPath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')), product = config.products[variant];
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const jsonl = require(join(product, 'dist/src/summary/jsonl'));
  const aggregate = require(join(product, 'dist/src/summary/aggregation/memoryAggregate'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const work = await fsp.mkdtemp(join(dirname(resolve(configPath)), `profile-${variant}-`));
  const path = join(work, 'summary.sqlite'), db = new SummaryDatabase(path), samples = {};
  let counters, target;
  const originalRead = jsonl.readJsonl, originalStore = db.replaceMemory;
  jsonl.readJsonl = async function(...args) {
    const started = performance.now(); counters.readCalls++;
    try { return await Reflect.apply(originalRead, this, args); }
    finally { counters.readMs += performance.now() - started; }
  };
  db.replaceMemory = function(...args) {
    const started = performance.now(); counters.storeCalls++;
    try { return Reflect.apply(originalStore, this, args); }
    finally { counters.storeMs += performance.now() - started; }
  };
  const owner = aggregate.StreamingAggregation?.prototype || aggregate;
  const method = aggregate.StreamingAggregation ? 'finish' : 'aggregateMemory', originalAggregate = owner[method];
  owner[method] = function(...args) {
    const started = performance.now(); counters.aggregateCalls++;
    try { return Reflect.apply(originalAggregate, this, args); }
    finally { counters.aggregateFinishMs += performance.now() - started; }
  };
  const measure = async name => {
    counters = { readCalls: 0, readMs: 0, storeCalls: 0, storeMs: 0, aggregateCalls: 0, aggregateFinishMs: 0 };
    global.gc();
    const started = performance.now(), refreshed = await refreshSummary(db, { dbPath: path, roots: config.roots });
    const ms = performance.now() - started;
    assert.equal(refreshed.failed, 0); assert.equal(refreshed.interrupted, false); assert.equal(refreshed.error, undefined);
    const totals = db.connection.prepare('SELECT count(*) requests,sum(total_tokens) tokens FROM turn_summary').get();
    const metadata = db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'turn_metadata%' ORDER BY name").all();
    samples[name] = { ms, ...counters, parsed: refreshed.parsed, bodyBytes: refreshed.bodyBytes, ...totals,
      metadataRows: Object.fromEntries(metadata.map(({ name: table }) => [table, db.connection.prepare(`SELECT count(*) n FROM ${table}`).get().n])) };
  };
  try {
    await measure('initial');
    target = helpers.chooseTarget(db, 'codex', config.directory);
    const originalHash = createHash('sha256').update(fs.readFileSync(target.path)).digest('hex');
    await helpers.inspectCodexTarget(target, product);
    await helpers.appendRows(target, helpers.codexAppendRows(target, 'streaming-profile-request', 'streaming-profile-response'), config.directory, 1);
    await measure('append');
    assert.equal(samples.append.requests, samples.initial.requests + 1); assert.equal(samples.append.tokens, samples.initial.tokens + 130);
    await fsp.truncate(target.path, target.originalBytes); await fsp.utimes(target.path, target.originalAtime, target.originalMtime);
    assert.equal(createHash('sha256').update(fs.readFileSync(target.path)).digest('hex'), originalHash);
    const report = { variant, samples, note: 'One diagnostic run only, excluded from A/B medians. Read timing includes parse callbacks and streaming winner.add; A aggregate timing covers all selection, B finish timing only finalization, so those columns are not equivalent isolated kernels. Store timing includes final transactions and metadata persistence where present.' };
    await fsp.writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(report));
  } finally {
    if (target) { await fsp.truncate(target.path, target.originalBytes); await fsp.utimes(target.path, target.originalAtime, target.originalMtime); }
    db.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
