// 고정된 순차·파일 준비 Worker 풀 구현의 구간 시간과 집계 의미를 같은 입력에서 비교한다.
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { cpus, release } = require('node:os');
const { dirname, join, relative, resolve, sep } = require('node:path');
const { performance } = require('node:perf_hooks');
const helpers = require('./incremental-refresh.cjs');
const { allUsage, independentCheck, stats } = require('./temp-batch-ab.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul';
const groups = ['day', 'month', 'session', 'project'], scenarios = ['initial', 'append-one', 'unchanged'];
const sha = value => createHash('sha256').update(value).digest('hex');
const clock = () => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const profileKey = Symbol.for('agent-tracker.source-pool-ab');
let filter = { unknownTime: 'include', excludeEmptyUsage: true };
const elapsed = value => typeof value === 'number' ? value : value?.totalMs ?? 0;

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

function loadScanner(product) {
  return require(join(product, 'dist/src/summary/scanner'));
}

function installCounters(product, state, structure) {
  const { StageProfiler } = require(join(product, 'dist/src/summary/profiling'));
  const reader = require(join(product, 'dist/src/summary/scanner/sourceReader'));
  const source = require(join(product, 'dist/src/summary/scanner/sourceFingerprint'));
  const asyncMeasure = StageProfiler.prototype.measureAsync, lstat = fsp.lstat;
  const read = reader.readSource, verify = source.includesSourceSnapshot;
  const poolPath = join(product, 'dist/src/summary/scanner/sourcePool.js');
  const pool = fs.existsSync(poolPath) ? require(poolPath).SourceReaderPool : undefined;
  const poolRead = pool?.prototype.read, poolEnqueue = pool?.prototype.enqueue;
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
  if (pool) {
    pool.prototype.enqueue = function(file, ...args) {
      state.counters.workerSubmitted++;
      const result = poolEnqueue.call(this, file, ...args);
      state.counters.workerMaxPending = Math.max(state.counters.workerMaxPending, this.jobs.size);
      state.counters.workerMaxThreads = Math.max(state.counters.workerMaxThreads, this.slots.size);
      return result;
    };
    pool.prototype.read = async function(file) {
      const bucket = state.counters.reads[state.stage] ??= { calls: 0, bytes: 0, elapsedMs: 0, serviceMs: 0 };
      bucket.calls++; state.counters.readOrder.push(file.id);
      const started = performance.now();
      if (this.jobs.has(file.id) || this.slots.size) state.counters.workerConsumed++;
      try {
        const result = await poolRead.call(this, file);
        bucket.bytes += result.bytes; bucket.serviceMs += result.elapsedMs;
        return result;
      } finally { bucket.elapsedMs += performance.now() - started; }
    };
  } else reader.readSource = async function(file, sink, options) {
    const bucket = state.counters.reads[state.stage] ??= { calls: 0, bytes: 0, elapsedMs: 0 };
    bucket.calls++; state.counters.readOrder.push(file.id);
    const started = performance.now();
    try {
      return await read(file, sink, { ...options, onBytes: bytes => { bucket.bytes += bytes; options.onBytes?.(bytes); } });
    } finally { bucket.elapsedMs += performance.now() - started; }
  };
  source.includesSourceSnapshot = async function(current, previous, options) {
    state.counters.verificationCalls++;
    return verify(current, previous, { ...options, onBytes: bytes => {
      state.counters.verificationBytes += bytes; options.onBytes(bytes);
    } });
  };
  return () => {
    StageProfiler.prototype.measureAsync = asyncMeasure; fsp.lstat = lstat;
    reader.readSource = read; source.includesSourceSnapshot = verify;
    if (pool) { pool.prototype.read = poolRead; pool.prototype.enqueue = poolEnqueue; }
  };
}

function totals(db) {
  return { ...db.connection.prepare('SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens FROM turn_summary').get() };
}

function distribution(db) {
  return { ...totals(db), ...db.connection.prepare(`SELECT count(DISTINCT provider||':'||session_id) sessions,
    count(DISTINCT project_key) projects,min(started_at_ms) firstRequestAtMs,max(started_at_ms) lastRequestAtMs FROM turn_summary`).get(),
    providers: db.connection.prepare('SELECT provider,count(*) requests FROM turn_summary GROUP BY provider ORDER BY provider').all().map(row => ({ ...row })) };
}

function verify(db, product) {
  const { buildUsageQuery } = require(join(product, 'dist/src/summary/db/queries'));
  const checked = helpers.verify(db, buildUsageQuery), independent = {};
  for (const group of groups) independent[group] = independentCheck(db, filter, group, allUsage(db, group, filter));
  // 물리 ID와 갱신 시각만 제외하고 실제 DB 상태를 검증한다. 공개 결과에는 해시만 기록한다.
  const manifest = db.connection.prepare(`SELECT provider,path,source_root,session_id,size_bytes,mtime_ms,dev,inode,
    parser_version,capabilities_collected,source_identity,content_hash,processing_status,processing_position,last_error,source_missing
    FROM manifest ORDER BY provider,path`).all().map(helpers.normalized);
  return { ...checked, manifestSha256: sha(JSON.stringify(manifest)), independent };
}

async function worker(configPath, variant, pairText, work) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')), product = config.products[variant];
  filter = config.filter;
  const state = { stage: 'outside-refresh', counters: undefined };
  globalThis[profileKey] = state;
  const restore = installCounters(product, state, config.structure);
  const { refreshSummary, PARSER_VERSION } = loadScanner(product, variant, config.structure);
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  await fsp.mkdir(work, { recursive: true });
  const dbPath = join(work, 'summary.sqlite'), db = new SummaryDatabase(dbPath), samples = [];
  let target;
  try {
    db.queryUsagePage(filter, 'day', timezone, { limit: 100 });
    const rollupState = () => ({
      metadataRows: db.connection.prepare('SELECT count(*) n FROM usage_rollup_meta').get().n,
      requestDailyRows: db.connection.prepare('SELECT count(*) n FROM usage_request_daily').get().n,
      modelDailyRows: db.connection.prepare('SELECT count(*) n FROM usage_model_daily').get().n,
    });
    if (!config.rawRange) assert.equal(rollupState().metadataRows, 1, 'Empty day query must activate rollups');
    const { buildRollupUsageQueries } = require(join(product, 'dist/src/summary/db/rollup-queries'));
    const pragmas = Object.fromEntries(['journal_mode', 'synchronous', 'wal_autocheckpoint', 'cache_size', 'temp_store', 'mmap_size']
      .map(key => [key, Object.values(db.connection.prepare(`PRAGMA ${key}`).get())[0]]));
    async function measure(scenario) {
      const rollupBeforeRefresh = rollupState();
      state.counters = { statCalls: {}, reads: {}, readOrder: [], expansionIterations: 0, expansionFilesExamined: 0,
        expansionPendingSorted: 0, verificationCalls: 0, verificationBytes: 0, structureInstrumented: config.structure,
        queueAddAttempts: 0, queueEnqueued: 0, queueDequeued: 0, groupLookups: 0, groupMembersReturned: 0 };
      Object.assign(state.counters, { workerSubmitted: 0, workerConsumed: 0, workerMaxPending: 0, workerMaxThreads: 0 });
      const refreshed = await refreshSummary(db, { dbPath, roots: config.snapshot.roots, timezone,
        collectCapabilities: true, retainDeletedSourceUsage: true });
      assert.equal(refreshed.failed, 0); assert.equal(refreshed.interrupted, false); assert.equal(refreshed.error, undefined);
      const counters = state.counters; state.counters = undefined;
      const rollupAfterRefresh = rollupState();
      if (!config.rawRange) assert.equal(rollupAfterRefresh.metadataRows, 1, 'Measured refresh must retain active rollups');
      assert.equal(refreshed.bodyBytes, Object.values(counters.reads).reduce((sum, value) => sum + value.bytes, 0) + counters.verificationBytes);
      counters.readOrderSha256 = sha(JSON.stringify(counters.readOrder));
      counters.readSetSha256 = sha(JSON.stringify([...new Set(counters.readOrder)].sort((a, b) => a - b)));
      counters.sourceReadCalls = counters.readOrder.length; delete counters.readOrder;
      assert.equal(counters.workerSubmitted, counters.workerConsumed, 'No unused speculative source reads');
      assert.ok(counters.workerMaxThreads <= 4);
      assert.ok(counters.workerMaxPending <= 9);
      const queries = {};
      for (const group of groups) {
        const started = performance.now(), page = allUsage(db, group, filter);
        queries[group] = { elapsedMs: performance.now() - started, groups: page.length,
          rowsSha256: sha(JSON.stringify(page.map(helpers.normalized))),
          queryMode: buildRollupUsageQueries(filter, group, timezone, 'provider') && rollupState().metadataRows === 1 ? 'rollup-active' : 'raw-required' };
      }
      const { scanId: _scanId, completedAt: _completedAt, ...refresh } = refreshed;
      const sample = { scenario, refresh, counters, totals: totals(db), queries, rollupBeforeRefresh, rollupAfterRefresh, checked: verify(db, product) };
      sample.relatedControlMs = elapsed(refresh.timings.scan.expandRelated) - (counters.reads.expandRelated?.elapsedMs ?? 0);
      sample.changedControlMs = elapsed(refresh.timings.scan.parseChanged) - (counters.reads.parseChanged?.elapsedMs ?? 0);
      samples.push(sample);
      process.send({ kind: 'sample', scenario, ms: refresh.timings.totalMs, parsed: refresh.parsed });
      return sample;
    }
    const initial = await measure('initial'), initialDistribution = distribution(db);
    if (config.snapshot.expected) assert.deepEqual(initial.totals,
      { requests: config.snapshot.expected.requests, tokens: config.snapshot.expected.tokens });
    const beforeRows = db.connection.prepare('SELECT * FROM turn_summary ORDER BY id').all().map(helpers.normalized);
    target = helpers.chooseTarget(db, 'codex', config.directory);
    await helpers.inspectCodexTarget(target, product);
    const targetSessionFiles = db.connection.prepare('SELECT count(*) n FROM manifest WHERE provider=? AND session_id=?')
      .get('codex', target.session_id).n;
    await helpers.appendRows(target, helpers.codexAppendRows(target, 'scan-queue-added-request', 'scan-queue-added-response'), config.directory, 1);
    const appended = await measure('append-one');
    assert.deepEqual(appended.totals, { requests: initial.totals.requests + 1, tokens: initial.totals.tokens + 130 });
    const added = db.connection.prepare('SELECT id FROM turn_summary WHERE root_turn_id=?').all('scan-queue-added-request');
    assert.equal(added.length, 1);
    const afterRows = db.connection.prepare('SELECT * FROM turn_summary WHERE id<>? ORDER BY id').all(added[0].id).map(helpers.normalized);
    assert.deepEqual(afterRows, beforeRows);
    const unchanged = await measure('unchanged');
    assert.deepEqual(unchanged.totals, appended.totals); assert.equal(unchanged.refresh.bodyBytes, 0);
    assert.equal(unchanged.refresh.parsed, 0); assert.deepEqual(unchanged.refresh.timings.storage, {});
    assert.equal(unchanged.checked.factsSha256, appended.checked.factsSha256);
    assert.equal(unchanged.checked.aggregatesSha256, appended.checked.aggregatesSha256);
    process.send({ kind: 'result', result: { variant, pair: Number(pairText), samples, initialDistribution, pragmas,
      parserVersion: PARSER_VERSION, sqlite: db.connection.prepare('SELECT sqlite_version() version').get().version,
      appendTarget: { provider: 'codex', existingSessionRequests: target.requests, sessionSourceFiles: targetSessionFiles,
        sourceBytesBefore: target.originalBytes, inputTokens: 123, outputTokens: 7 } } });
  } finally {
    state.counters = undefined;
    if (target) { await fsp.truncate(target.path, target.originalBytes); await fsp.utimes(target.path, target.originalAtime, target.originalMtime); }
    db.close(); restore(); delete globalThis[profileKey];
  }
}

function runWorker(config, variant, pair, work) {
  return new Promise((done, fail) => {
    const child = fork(__filename, ['--worker', config, variant, String(pair), work], {
      execArgv: ['--no-warnings'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    let result, error = '';
    child.stderr.on('data', value => { error += value; });
    child.on('message', message => {
      if (message.kind === 'result') result = message.result;
      if (message.kind === 'sample') console.log(`${pair < 0 ? 'warmup' : 'pair'} ${pair + 1}/${variant}/${message.scenario}: ${message.ms.toFixed(3)} ms (${message.parsed} files)`);
    });
    child.on('error', fail);
    child.on('exit', code => code === 0 && result ? done(result) : fail(new Error(error.slice(-5000) || `Worker failed: ${code}`)));
  });
}

function assertPair(pair) {
  assert.deepEqual(pair.A.initialDistribution, pair.B.initialDistribution, 'Initial distribution');
  assert.deepEqual(pair.A.appendTarget, pair.B.appendTarget, 'Append target');
  for (const scenario of scenarios) {
    const a = pair.A.samples.find(sample => sample.scenario === scenario), b = pair.B.samples.find(sample => sample.scenario === scenario);
    assert.deepEqual(a.totals, b.totals, `Totals/${scenario}`);
    assert.deepEqual(a.checked, b.checked, `Semantic database and independent aggregates/${scenario}`);
    assert.deepEqual(a.rollupBeforeRefresh, b.rollupBeforeRefresh, `Rollup before refresh/${scenario}`);
    assert.deepEqual(a.rollupAfterRefresh, b.rollupAfterRefresh, `Rollup after refresh/${scenario}`);
    for (const key of ['parsed', 'failed', 'bodyBytes', 'reused', 'discovered']) assert.equal(a.refresh[key], b.refresh[key], `${scenario}/${key}`);
    for (const key of ['readOrderSha256', 'readSetSha256', 'sourceReadCalls']) assert.equal(a.counters[key], b.counters[key], `${scenario}/${key}`);
    for (const group of groups) {
      assert.equal(a.queries[group].rowsSha256, b.queries[group].rowsSha256, `Query rows/${scenario}/${group}`);
      assert.equal(a.queries[group].groups, b.queries[group].groups, `Query count/${scenario}/${group}`);
      assert.equal(a.queries[group].queryMode, b.queries[group].queryMode, `Query mode/${scenario}/${group}`);
    }
  }
}

function summarize(trials) {
  const summary = {};
  for (const scenario of scenarios) {
    const entries = trials.map(pair => Object.fromEntries(['A', 'B'].map(variant =>
      [variant, pair[variant].samples.find(sample => sample.scenario === scenario)])));
    const metric = get => {
      const result = Object.fromEntries(['A', 'B'].map(variant => [variant, stats(entries.map(pair => get(pair[variant])))]));
      result.improvementPercent = result.A.medianMs ? (result.A.medianMs - result.B.medianMs) / result.A.medianMs * 100 : null;
      result.fasterPairs = entries.filter(pair => get(pair.B) < get(pair.A)).length;
      return result;
    };
    const stageKeys = [...new Set(entries.flatMap(pair => ['A', 'B'].flatMap(variant => Object.keys(pair[variant].refresh.timings.scan))))];
    const storageKeys = [...new Set(entries.flatMap(pair => ['A', 'B'].flatMap(variant => Object.keys(pair[variant].refresh.timings.storage))))];
    summary[scenario] = { total: metric(sample => sample.refresh.timings.totalMs),
      scan: Object.fromEntries(stageKeys.map(stage => [stage, metric(sample => elapsed(sample.refresh.timings.scan[stage]))])),
      storage: Object.fromEntries(storageKeys.map(stage => [stage, metric(sample => elapsed(sample.refresh.timings.storage[stage]))])),
      queries: Object.fromEntries(groups.map(group => [group, metric(sample => sample.queries[group].elapsedMs)])),
      relatedControl: metric(sample => sample.relatedControlMs), changedControl: metric(sample => sample.changedControlMs),
      counters: Object.fromEntries(['A', 'B'].map(variant => [variant, entries[0][variant].counters])) };
  }
  return summary;
}

function markdown(report) {
  const cell = v => v ? v.A.medianMs.toFixed(3) + ' -> ' + v.B.medianMs.toFixed(3) + ' (' + (v.improvementPercent?.toFixed(1) ?? 'N/A') + '%)' : 'not run';
  const cols = report.datasets.map(d => d.name + ' (' + d.distribution.requests + ' requests)');
  const table = (headers, rows) => ['| ' + headers.join(' | ') + ' |', '| ' + headers.map(()=>'---').join(' | ') + ' |', ...rows.map(row=>'| ' + row.join(' | ') + ' |')].join('\n');
  const out = ['# Source preparation Worker pool A/B', '', report.startedAtSeoul + ' - ' + report.completedAtSeoul + ', Asia/Seoul.', '',
    'Hypothesis: independent file preparation can reduce CPU work on large inputs; Worker startup and messaging can offset gains on small inputs.',
    'A: frozen current sequential scanner. B: up to four file Workers, eight pending results, no Worker startup for one file or a lookahead window below 1 MiB. Logical source order, relation closure and component transactions are unchanged.',
    'SQL/schema, metadata concurrency, watchers and append checkpoints are unchanged.', '',
    'Values: A -> B median milliseconds (reduction percent); negative means slower. Three warmup pairs excluded; ten AB/BA pairs by default.',
    'Source-worker startup, messaging and teardown are inside refresh. Copy, append, verification, migration and query timing are outside refresh.', '',
    '## Overall',
    table(['Metric', ...cols], [...scenarios.map(key=>[key, ...report.datasets.map(d=>cell(d.summary[key].total))]),
      ...groups.map(key=>['query: '+key, ...report.datasets.map(d=>cell(d.summary['append-one'].queries[key]))])])];
  for (const d of report.datasets) {
    const keys = [...new Set(scenarios.flatMap(key=>Object.keys(d.summary[key].scan)))];
    out.push('', '## Stages: ' + d.name, '',
      table(['Stage', ...scenarios], keys.map(key=>[key, ...scenarios.map(s=>cell(d.summary[s].scan[key]))])),
      '', 'readSources is nested in preparation stages. In B it measures ordered wait for prepared results, not the sum of Worker service time or pure CPU time.',
      'sourcePoolClose is included in total refresh. Stage medians need not add up to total median.', '',
      table(['Scenario', 'A median [min-max] ms', 'B median [min-max] ms', 'B faster pairs'],
        scenarios.map(key=>{ const v=d.summary[key].total; return [key,
          v.A.medianMs.toFixed(3)+' ['+v.A.minMs.toFixed(3)+'-'+v.A.maxMs.toFixed(3)+']',
          v.B.medianMs.toFixed(3)+' ['+v.B.minMs.toFixed(3)+'-'+v.B.maxMs.toFixed(3)+']', v.fasterPairs+'/'+report.pairs]; })),
      '', 'Input: ' + d.inventory.reduce((n,v)=>n+v.files,0) + ' files, ' + d.inventory.reduce((n,v)=>n+v.bytes,0) + ' bytes, ' +
        d.distribution.requests+' requests, '+d.distribution.sessions+' sessions, '+d.distribution.projects+' projects.',
      'First B trial: submitted jobs initial/append = '+d.trials[0].B.samples[0].counters.workerSubmitted+'/'+d.trials[0].B.samples[1].counters.workerSubmitted+
        '; max threads = '+d.trials[0].B.samples[0].counters.workerMaxThreads+'/'+d.trials[0].B.samples[1].counters.workerMaxThreads+'.');
  }
  out.push('', '## Storage internals', '', table(['Stage','current initial','current append','10k initial','10k append'],
    ['replace','summaries','summaryWrites','rollups','commit'].map(key=>[key,...report.datasets.flatMap(d=>['initial','append-one'].map(s=>cell(d.summary[s].storage[key])))])),
    '', 'Storage timers overlap. SQLite COMMIT includes WAL sync, possible checkpoint and OS waiting. Storage SQL is unchanged.',
    '', '## Conditions and correctness', '',
    '- Environment: '+JSON.stringify(report.environment)+'.',
    '- Separate process and new DB per variant/sample. Warm OS cache; no forced GC.',
    '- All A/B semantic DB hashes, manifest state, logical read order/set, file count, bytes and provider/model aggregates matched.',
    '- Independent JS reducers verify all four query means, denominators and group counts. FK and integrity checks passed.',
    '- Synthetic: deterministic ordinal, 100 sessions x 100 requests, equal providers, 10 projects, 14 days; expected 10,000 requests / 6,340,000 tokens.',
    '- Append: exactly +1 request / +130 tokens, preserving existing request rows. No-change: zero body reads, parses and replaceMemory calls.',
    '- No unused speculative reads; at most four Worker threads and nine pending jobs (eight lookahead plus an urgent dependency).',
    '- Full frozen range, provider basis, costs excluded, unknown times included, excludeEmptyUsage=true, Asia/Seoul; queries return every page.',
    '- Real-log full independent parser oracle, adversarial error/cancel/rewrite scenarios, UI, quota and heap/GC peak were not run.',
    '- Original logs and installed DB were untouched. Frozen sources were restored and SHA-256 checked.',
    '- Source/build/input/runner hashes and raw samples: ['+report.outputName+'](./'+report.outputName+'). Private source contents and identifiers are excluded.',
    '', '## Analysis', '', '<!-- Fill from final measurements. -->', '', '## Reproduction', '',
    'node --no-warnings tests/benchmarks/scan-source-pool-ab.cjs --workspace=<frozen inputs> --before=<A root> --after=<B root> --output=<new JSON>',
    '', 'Default: --warmups=3 --pairs=10. --prepare-only freezes inputs. Existing outputs are never overwritten. General automated tests were not run.', '');
  return out.join('\n');
}

async function main() {
  const options = { workspace: '', before: '', after: '', output: '', pairs: 10, warmups: 3 };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--prepare-only' || arg === '--structure' || arg === '--raw-range') continue;
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    assert.ok(match && Object.hasOwn(options, match[1]), 'Unknown or incomplete option');
    options[match[1]] = ['pairs', 'warmups'].includes(match[1]) ? Number(match[2]) : resolve(match[2]);
  }
  assert.ok(options.workspace && options.before, '--workspace and --before required');
  assert.ok(Number.isSafeInteger(options.pairs) && options.pairs > 0 && Number.isSafeInteger(options.warmups) && options.warmups >= 0);
  await fsp.mkdir(options.workspace, { recursive: true });
  const specs = [{ name: 'current', real: true }, { name: 'synthetic-10000', requests: 10000, 'turns-per-session': 100 }];
  const snapshots = [];
  for (const spec of specs) {
    const directory = join(options.workspace, spec.name), path = join(directory, 'snapshot.json');
    if (!fs.existsSync(path)) {
      await fsp.mkdir(directory, { recursive: true });
      const snapshot = await helpers.makeSnapshot(directory, { ...spec, after: options.before });
      await fsp.writeFile(path, JSON.stringify(snapshot));
    }
    snapshots.push({ ...spec, directory, snapshot: JSON.parse(fs.readFileSync(path, 'utf8')) });
  }
  if (process.argv.includes('--prepare-only')) { console.log('Frozen inputs prepared'); return; }
  assert.ok(options.after && options.output, '--after and --output required for measurement');
  assert.ok(options.output.endsWith('.json'), '--output must end in .json');
  assert.equal(fs.existsSync(options.output), false, 'Never overwrite measurements');
  const products = { A: options.before, B: options.after };
  const rawRange = process.argv.includes('--raw-range');
  if (rawRange) filter = { fromMs: -8640000000000000, toMs: 8640000000000000, ...filter };
  const structure = process.argv.includes('--structure');
  const trialDirectory = await fsp.mkdtemp(join(options.workspace, structure ? 'diagnostic-' : 'trials-'));
  const report = { dateSeoul: '2026-11-09', outputName: options.output.split(sep).pop(), startedAtSeoul: clock(), timezone, warmups: options.warmups, pairs: options.pairs,
    environment: { node: process.version, platform: process.platform, release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    products: Object.fromEntries(['A', 'B'].map(variant => [variant,
      { source: fingerprint(join(products[variant], 'src')), build: fingerprint(join(products[variant], 'dist/src')) }])),
    runnerSha256: sha(fs.readFileSync(__filename)), helperSha256: Object.fromEntries(['incremental-refresh.cjs', 'temp-batch-ab.cjs']
      .map(name => [name, sha(fs.readFileSync(join(__dirname, name)))])),
    workspace: relative(root, options.workspace).split(sep).join('/'),
    trialWorkspace: relative(root, trialDirectory).split(sep).join('/'), structure, rawRange, filter,
    conditions: { cache: 'OS cache uncontrolled, warmed by freezing and prior trials; no forced GC; each variant uses a new process and new DB',
      trials: 'Three warmup pairs excluded, then ten alternating AB/BA pairs per dataset unless CLI overrides; each initial build supplies the identical pre-append state for that trial',
      timing: 'Product StageProfiler refresh through COMMIT/optimize; queries outside refresh; copy, process startup, DB open/migration, empty rollup activation, append, checks and source restoration excluded',
      queries: 'All pages and total group counts, provider basis, full frozen input with no date boundaries, excludeEmptyUsage=true, unknownTime=include, Asia/Seoul; first post-refresh query per grouping; metadata and eligibility recorded',
      instrumentation: structure ? 'Separate structural diagnostic: baseline expansion counters and candidate queue/group wrappers; times excluded from main A/B medians'
        : 'Existing StageProfiler and logical source read wrappers; B pool submission counts; worker file stats are not intercepted; overhead not separately calibrated',
      residual: 'Stage minus nested logical preparation wait; B tasks execute ahead in parallel, so residual is coordinator overhead rather than worker CPU time',
      exclusions: 'UI, extension-host IPC, quota, heap/GC peak, adversarial error/cancellation/rewrite scenarios and independent real-log parser oracle not measured; source-worker IPC is included' }, datasets: [] };
  for (const { name, directory, snapshot, ...spec } of snapshots) {
    for (const file of snapshot.files) assert.equal(sha(fs.readFileSync(file.path)), file.sha256, 'Frozen input must match original before trials');
    const work = join(trialDirectory, name); await fsp.mkdir(work, { recursive: true });
    const config = join(work, 'queue-config.json');
    await fsp.writeFile(config, JSON.stringify({ products, directory, snapshot, structure, filter, rawRange }));
    const entry = { name, inputSha256: snapshot.sha256, inventory: snapshot.inventory, expected: snapshot.expected ?? null,
      syntheticGeneration: spec.requests ? { seed: 'deterministic ordinal; no random generator', turnsPerSession: spec['turns-per-session'],
        providers: 'alternating sessions; equal requests', projects: 10, timestampRule: '2026-07-01 + sessionIndex % 14 days + turnIndex * 3 seconds' } : null,
      warmupChecks: [], trials: [] };
    for (let pair = -options.warmups; pair < options.pairs; pair++) {
      const both = {};
      for (const variant of ((pair + options.warmups) % 2 ? ['B', 'A'] : ['A', 'B'])) {
        both[variant] = await runWorker(config, variant, pair, join(work, `pair-${pair}/${variant}`));
      }
      assertPair(both);
      if (pair < 0) entry.warmupChecks.push({ pair, equal: true }); else entry.trials.push(both);
      await fsp.writeFile(join(options.workspace, 'partial-report.json'), JSON.stringify({ ...report, currentDataset: entry }, null, 2));
    }
    for (const file of snapshot.files) assert.equal(sha(fs.readFileSync(file.path)), file.sha256, 'Frozen sources restored');
    entry.distribution = entry.trials[0].A.initialDistribution; entry.appendTarget = entry.trials[0].A.appendTarget;
    entry.summary = summarize(entry.trials);
    entry.correctness = { allAbPairs: true, sameSourceReadSetAndOrder: true, semanticFactsAndManifest: true,
      rawSqlRollup10Dimensions: true, independentJsAverages: true, exactAppendDelta: true,
      unchangedSkippedBodyAndReplaceMemory: true, frozenSourcesRestored: true, foreignKeysAndIntegrity: true,
      independentRealDataParserOracle: 'not performed; synthetic totals checked against generator' };
    report.environment.sqlite = entry.trials[0].A.sqlite; report.datasets.push(entry);
  }
  report.completedAtSeoul = clock();
  for (const variant of ['A', 'B']) assert.deepEqual(fingerprint(join(products[variant], 'dist/src')), report.products[variant].build);
  await fsp.mkdir(dirname(options.output), { recursive: true });
  await fsp.writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  if (!structure) await fsp.writeFile(options.output.replace(/\.json$/, '.md'), markdown(report), { flag: 'wx' });
  console.log(`Saved ${relative(root, options.output)}`);
}

if (process.argv[2] === '--worker') worker(...process.argv.slice(3)).then(() => process.disconnect(), error => {
  console.error(error); process.exitCode = 1; process.disconnect();
});
else main().catch(error => { console.error(error); process.exitCode = 1; });
