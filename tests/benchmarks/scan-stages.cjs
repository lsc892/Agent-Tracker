// 고정 사본·별도 DB에서 현재 스캐너의 최초·1건 추가·무변경 구간을 한 번씩 잰다.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const Module = require('node:module');
const { cpus, platform, release } = require('node:os');
const { dirname, join, relative, resolve, sep } = require('node:path');
const { performance } = require('node:perf_hooks');
const helpers = require('./incremental-refresh.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul';
const sha = value => createHash('sha256').update(value).digest('hex');
const clock = () => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const profileKey = Symbol.for('agent-tracker.scan-stage-benchmark');

function fingerprint(directory) {
  const files = [];
  function walk(path) {
    for (const entry of fs.readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push([relative(directory, child).split(sep).join('/'), sha(fs.readFileSync(child))]);
    }
  }
  walk(directory);
  return { files: files.length, sha256: sha(JSON.stringify(files)) };
}

// 제품 파일은 바꾸지 않는다. 비공개 빌드 사본의 모듈 로딩 때 반복 횟수만 센다.
function loadScanner(product) {
  const path = require.resolve(join(product, 'dist/src/summary/scanner'));
  const original = Module._extensions['.js'];
  Module._extensions['.js'] = function(module, filename) {
    if (filename !== path) return original(module, filename);
    let code = fs.readFileSync(filename, 'utf8');
    const replaceOnce = (from, to) => {
      assert.equal(code.split(from).length, 2, `Instrumentation anchor changed: ${from}`);
      code = code.replace(from, to);
    };
    replaceOnce('async function expandRelatedSources() {',
      "async function expandRelatedSources() {\n        const counts = globalThis[Symbol.for('agent-tracker.scan-stage-benchmark')].counters;");
    replaceOnce('            resolveLineage();',
      '            counts.expansionIterations++; counts.expansionFilesExamined += files.size;\n            resolveLineage();');
    replaceOnce('            pending.sort((a, b) => a.id - b.id);',
      '            counts.expansionPendingSorted += pending.length;\n            pending.sort((a, b) => a.id - b.id);');
    replaceOnce('            if (parents.length) {',
      '            counts.relatedInspectAttempts += parents.length;\n            if (parents.length) {');
    replaceOnce('            await inspectSource(next);',
      '            counts.relatedInspectAttempts++;\n            await inspectSource(next);');
    module._compile(code, filename);
  };
  try { return require(path); }
  finally { Module._extensions['.js'] = original; }
}

function installCounters(product, state) {
  const { StageProfiler } = require(join(product, 'dist/src/summary/profiling'));
  const reader = require(join(product, 'dist/src/summary/scanner/sourceReader'));
  const source = require(join(product, 'dist/src/summary/scanner/sourceFingerprint'));
  const aggregation = require(join(product, 'dist/src/summary/aggregation/memoryAggregate'));
  const { SourceWinners } = require(join(product, 'dist/src/summary/aggregation/sourceWinners'));
  const asyncMeasure = StageProfiler.prototype.measureAsync, lstat = fsp.lstat;
  const read = reader.readSource, verify = source.includesSourceSnapshot;
  const Aggregate = aggregation.StreamingAggregation;
  const enumerate = SourceWinners.prototype.events ? 'events' : 'values', originalEnumeration = SourceWinners.prototype[enumerate];
  StageProfiler.prototype.measureAsync = async function(stage, action) {
    const previous = state.stage;
    if (stage !== 'readSources') state.stage = stage;
    try { return await asyncMeasure.call(this, stage, action); }
    finally { state.stage = previous; }
  };
  fsp.lstat = async function(...args) {
    if (state.counters) state.counters.statCalls[state.stage] = (state.counters.statCalls[state.stage] ?? 0) + 1;
    return Reflect.apply(lstat, this, args);
  };
  reader.readSource = function(file, sink, options) {
    const bucket = state.counters.reads[state.stage] ??= { calls: 0, bytes: 0 };
    bucket.calls++;
    return read(file, sink, { ...options, onBytes: bytes => { bucket.bytes += bytes; options.onBytes?.(bytes); } });
  };
  source.includesSourceSnapshot = function(current, previous, options) {
    state.counters.verificationCalls++;
    return verify(current, previous, { ...options, onBytes: bytes => {
      state.counters.verificationBytes += bytes; options.onBytes(bytes);
    } });
  };
  aggregation.StreamingAggregation = class extends Aggregate {
    constructor(inputs, collect) {
      super(inputs, collect);
      state.counters.preparedSources += inputs.length;
    }
    finish() {
      const result = super.finish();
      state.counters.aggregatedRequests += result.summaries.length;
      return result;
    }
  };
  SourceWinners.prototype[enumerate] = function() {
    state.counters.sourceWinnerGroups += this.winners.size;
    return originalEnumeration.call(this);
  };
  return () => {
    StageProfiler.prototype.measureAsync = asyncMeasure; fsp.lstat = lstat;
    reader.readSource = read; source.includesSourceSnapshot = verify;
    aggregation.StreamingAggregation = Aggregate; SourceWinners.prototype[enumerate] = originalEnumeration;
  };
}

function totals(db) {
  return { ...db.connection.prepare('SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens FROM turn_summary').get() };
}

function distribution(db) {
  return { ...totals(db), ...db.connection.prepare(`SELECT count(DISTINCT provider||':'||session_id) sessions,
    count(DISTINCT project_key) projects,min(started_at_ms) firstRequestAtMs,max(started_at_ms) lastRequestAtMs FROM turn_summary`).get(),
    providers: db.connection.prepare('SELECT provider,count(*) requests FROM turn_summary GROUP BY provider ORDER BY provider').all() };
}

async function measureDataset(spec, directory, product, state, refreshSummary) {
  console.log(`${spec.name}: freezing input`);
  await fsp.mkdir(directory, { recursive: true });
  const snapshot = await helpers.makeSnapshot(directory, { ...spec, after: product });
  await fsp.writeFile(join(directory, 'snapshot.json'), JSON.stringify(snapshot));
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { buildUsageQuery, buildUsageCountQuery } = require(join(product, 'dist/src/summary/db/queries'));
  const dbPath = join(directory, 'summary.sqlite'), db = new SummaryDatabase(dbPath);
  let target;
  try {
    // 빈 DB에서 rollup을 활성화해 최초 수집의 저장 타이머에도 rollup 유지 비용을 포함한다.
    db.queryUsagePage({}, 'day', timezone, { limit: 100 });
    const pragma = Object.fromEntries(['journal_mode', 'synchronous', 'wal_autocheckpoint', 'cache_size', 'temp_store', 'mmap_size']
      .map(key => [key, Object.values(db.connection.prepare(`PRAGMA ${key}`).get())[0]]));
    const samples = [];
    async function measure(scenario) {
      const manifestRowsBefore = db.connection.prepare('SELECT count(*) n FROM manifest').get().n;
      state.counters = { statCalls: {}, reads: {}, expansionIterations: 0, expansionFilesExamined: 0,
        expansionPendingSorted: 0, relatedInspectAttempts: 0, verificationCalls: 0, verificationBytes: 0,
        preparedSources: 0, sourceWinnerGroups: 0, aggregatedRequests: 0 };
      const refreshed = await refreshSummary(db, { dbPath, roots: snapshot.roots, timezone,
        collectCapabilities: true, retainDeletedSourceUsage: true });
      assert.equal(refreshed.failed, 0); assert.equal(refreshed.interrupted, false); assert.equal(refreshed.error, undefined);
      assert.equal(refreshed.bodyBytes, Object.values(state.counters.reads).reduce((sum, value) => sum + value.bytes, 0) + state.counters.verificationBytes);
      const counters = state.counters;
      state.counters = undefined;
      const queries = {};
      for (const group of ['day', 'month', 'session', 'project']) {
        const started = performance.now(), page = db.queryUsagePage({}, group, timezone, { limit: 100 });
        queries[group] = { elapsedMs: performance.now() - started, rows: page.rows.length, groups: page.total };
        const raw = buildUsageQuery({}, group, timezone), count = buildUsageCountQuery({}, group, timezone);
        assert.deepEqual(page.rows.map(helpers.normalized), db.connection.prepare(raw.sql).all(...raw.values, 100, 0).map(helpers.normalized));
        assert.equal(page.total, db.connection.prepare(count.sql).get(...count.values).count);
      }
      const { scanId: _scanId, ...refresh } = refreshed;
      const sample = { scenario, manifestRowsBefore, refresh, counters, totals: totals(db), queries,
        checks: { successfulRefresh: true, readByteAccounting: true, rawRollupPagesAndCounts: true } };
      samples.push(sample);
      console.log(`${spec.name}/${scenario}: ${refresh.timings.totalMs.toFixed(2)} ms, ${sample.totals.requests} requests, ${refresh.parsed} parsed sources`);
      return sample;
    }
    const initial = await measure('initial'), initialDistribution = distribution(db);
    if (snapshot.expected) assert.deepEqual(initial.totals, { requests: snapshot.expected.requests, tokens: snapshot.expected.tokens });
    const beforeRows = db.connection.prepare('SELECT * FROM turn_summary ORDER BY id').all().map(helpers.normalized);
    target = helpers.chooseTarget(db, 'codex', directory);
    const targetFile = snapshot.files.find(file => file.path === target.path);
    await helpers.inspectCodexTarget(target, product);
    const targetSessionFiles = db.connection.prepare('SELECT count(*) n FROM manifest WHERE provider=? AND session_id=?').get('codex', target.session_id).n;
    await helpers.appendRows(target, helpers.codexAppendRows(target, 'scan-stage-added-request', 'scan-stage-added-response'), directory, 1);
    const appended = await measure('append-one');
    assert.equal(appended.totals.requests, initial.totals.requests + 1);
    assert.equal(appended.totals.tokens, initial.totals.tokens + 130);
    const added = db.connection.prepare('SELECT id FROM turn_summary WHERE root_turn_id=?').all('scan-stage-added-request');
    assert.equal(added.length, 1);
    const afterRows = db.connection.prepare('SELECT * FROM turn_summary WHERE id<>? ORDER BY id').all(added[0].id).map(helpers.normalized);
    assert.deepEqual(afterRows, beforeRows);
    const unchanged = await measure('unchanged-after-append');
    assert.deepEqual(unchanged.totals, appended.totals);
    assert.equal(unchanged.refresh.bodyBytes, 0); assert.equal(unchanged.refresh.parsed, 0);
    assert.deepEqual(unchanged.refresh.timings.storage, {});
    const unchangedRows = db.connection.prepare('SELECT * FROM turn_summary WHERE id<>? ORDER BY id').all(added[0].id).map(helpers.normalized);
    assert.deepEqual(unchangedRows, beforeRows);
    await fsp.truncate(target.path, target.originalBytes);
    await fsp.utimes(target.path, target.originalAtime, target.originalMtime);
    assert.equal(sha(fs.readFileSync(target.path)), targetFile.sha256);
    for (const file of snapshot.files) assert.equal(sha(fs.readFileSync(file.path)), file.sha256);
    return { name: spec.name, inputSha256: snapshot.sha256, inventory: snapshot.inventory, expected: snapshot.expected ?? null,
      syntheticGeneration: spec.requests ? { seed: 'deterministic ordinal; no random generator', turnsPerSession: spec['turns-per-session'],
        providers: 'alternating sessions; equal requests', projects: 10, timestampRule: '2026-07-01 + sessionIndex % 14 days + turnIndex * 3 seconds' } : null,
      distribution: initialDistribution, pragmas: pragma,
      appendTarget: { provider: 'codex', existingSessionRequests: target.requests, sessionSourceFiles: targetSessionFiles,
        sourceBytesBefore: target.originalBytes, inputTokens: 123, outputTokens: 7 }, samples,
      checks: { syntheticTotals: snapshot.expected ? true : 'not applicable; no independent real-data parser oracle',
        appendAddedExactlyOneRequestAnd130Tokens: true, existingRequestsUnchanged: true, noChangeSkippedReadsAndReplaceMemory: true,
        frozenSourcesRestored: true, rawRollupPagesAndCounts: true } };
  } finally {
    state.counters = undefined;
    if (target) { await fsp.truncate(target.path, target.originalBytes); await fsp.utimes(target.path, target.originalAtime, target.originalMtime); }
    db.close();
  }
}

async function main() {
  const outputArgument = process.argv.slice(2).find(arg => arg.startsWith('--output='));
  assert.ok(outputArgument, '--output=<new JSON path> is required');
  const output = resolve(outputArgument.slice('--output='.length));
  assert.equal(fs.existsSync(output), false, 'Do not overwrite raw measurements');
  await fsp.mkdir(join(root, 'tests/.cache'), { recursive: true });
  const workspace = await fsp.mkdtemp(join(root, 'tests/.cache/scan-stages-'));
  const product = join(workspace, 'product');
  await fsp.cp(join(root, 'dist'), join(product, 'dist'), { recursive: true });
  const report = { dateSeoul: '2026-11-09', startedAtSeoul: clock(), timezone,
    mode: 'single baseline profile; no A/B; one initial, append-one and unchanged refresh per dataset; zero warmups',
    environment: { node: process.version, platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    source: fingerprint(join(root, 'src')), build: fingerprint(join(product, 'dist/src')),
    runnerSha256: sha(fs.readFileSync(__filename)), helpersSha256: sha(fs.readFileSync(join(__dirname, 'incremental-refresh.cjs'))),
    workspace: relative(root, workspace).split(sep).join('/'),
    conditions: { cache: 'OS cache uncontrolled and warmed by snapshot copy; new SQLite DB per dataset; same process, current then synthetic',
      rollups: 'enabled on empty DB before initial refresh', query: 'no filters; costs excluded; provider basis; first 100 rows plus total count',
      outsideRefreshTimer: 'compilation, copy, snapshot, DB open/migrations/empty rollup activation, input append, correctness checks, queries, restoration and close',
      instrumentation: 'existing StageProfiler plus lstat/read/aggregate wrappers and expansion loop counters; no row timers; overhead not separately calibrated',
      expansionFilesExamined: 'sum(files.size) per expansion iteration; excludes resolveLineage/filter/find predicate work; no work queue exists yet' }, datasets: [] };
  const state = { stage: 'outside-refresh', counters: undefined };
  globalThis[profileKey] = state;
  const restore = installCounters(product, state);
  try {
    const { refreshSummary, PARSER_VERSION } = loadScanner(product);
    report.parserVersion = PARSER_VERSION;
    for (const spec of [{ name: 'current', real: true }, { name: 'synthetic-10000', requests: 10000, 'turns-per-session': 100 }]) {
      report.datasets.push(await measureDataset(spec, join(workspace, spec.name), product, state, refreshSummary));
      await fsp.mkdir(dirname(output), { recursive: true });
      await fsp.writeFile(join(workspace, 'partial-report.json'), JSON.stringify(report, null, 2) + '\n');
    }
    report.completedAtSeoul = clock();
    assert.deepEqual(fingerprint(join(product, 'dist/src')), report.build);
    await fsp.writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(`Saved ${relative(root, output)}`);
  } finally { restore(); delete globalThis[profileKey]; }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
