// 실제 refreshSummary의 연결 성분별 TEMP 집계와 32 seed 앞보기 집계를 고정 입력에서 비교한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdir, mkdtemp, cp, copyFile, writeFile, readFile, rm, truncate, utimes } = require('node:fs/promises');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { join, resolve, dirname, basename, sep } = require('node:path');
const { cpus } = require('node:os');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const helpers = require('./incremental-refresh.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul';
const variants = ['A', 'B'], groups = ['day', 'month', 'session', 'project'];
const scenarios = ['reparse', 'codex-append', 'claude-append', 'unchanged'];
const sha = value => createHash('sha256').update(value).digest('hex');
const seoul = () => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const canonical = value => JSON.stringify(value, (_key, x) => typeof x === 'number' && !Number.isInteger(x) ? Number(x.toPrecision(10)) : x);
const digest = value => sha(canonical(value));
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { medianMs: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: values };
}
function fingerprints(directory, folder) {
  return Object.fromEntries(fs.readdirSync(join(directory, folder), { recursive: true })
    .filter(name => /\.(ts|js|cjs|json)$/.test(name) && fs.statSync(join(directory, folder, name)).isFile())
    .sort().map(name => [folder + '/' + name.replaceAll('\\', '/'), sha(fs.readFileSync(join(directory, folder, name)))]));
}
function allUsage(db, group, filter) {
  const rows = []; let total;
  for (let offset = 0; ; offset += 1000) {
    const page = db.queryUsagePage(filter, group, timezone, { limit: 1000, offset }, 'provider');
    total ??= page.total; assert.equal(page.total, total); rows.push(...page.rows);
    if (rows.length >= total) break;
  }
  assert.equal(rows.length, total);
  return rows;
}
const groupKey = (row, group) => canonical([row.provider,
  group === 'project' || group === 'session' ? row.project_key : null,
  group === 'session' ? row.session_id : null,
  group === 'day' || group === 'month' ? row.period : null]);

// SQL 집계와 독립적으로 정규화 요청을 JS에서 합산한다. 평균은 완료 요청만 사용한다.
function independentCheck(db, filter, group, actual) {
  const requests = db.connection.prepare(`SELECT t.*,EXISTS(SELECT 1 FROM turn_model_usage m
    WHERE m.turn_id=t.id AND coalesce(m.model,'')<>'') AS has_model FROM turn_summary t`).all();
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const expected = new Map();
  for (const row of requests) {
    if (row.started_at_ms !== null && (row.started_at_ms < filter.fromMs || row.started_at_ms >= filter.toMs)) continue;
    if (row.started_at_ms === null && filter.unknownTime !== 'include') continue;
    row.period = row.started_at_ms === null ? null : date.format(row.started_at_ms).slice(0, group === 'month' ? 7 : 10);
    const key = groupKey(row, group);
    const sum = expected.get(key) ?? { count: 0, tokens: 0, input: 0, output: 0, complete: 0, recorded: 0, recordedComplete: 0, averageN: 0, averageTokens: 0 };
    sum.count++; sum.tokens += row.total_tokens; sum.input += row.input_tokens; sum.output += row.output_tokens;
    const recorded = row.total_tokens > 0 || row.has_model === 1, complete = row.status === 'completed';
    sum.complete += Number(complete); sum.recorded += Number(recorded); sum.recordedComplete += Number(recorded && complete);
    if (complete && (!filter.excludeEmptyUsage || recorded)) { sum.averageN++; sum.averageTokens += row.total_tokens; }
    expected.set(key, sum);
  }
  assert.equal(actual.length, expected.size, `JS group count/${group}`);
  for (const row of actual) {
    const sum = expected.get(groupKey(row, group)); assert.ok(sum, `JS key/${group}`);
    assert.deepEqual([row.turn_count, row.total_tokens, row.input_tokens, row.output_tokens, row.completed_turns,
      row.recorded_turns, row.recorded_completed_turns],
    [sum.count, sum.tokens, sum.input, sum.output, sum.complete, sum.recorded, sum.recordedComplete], `JS totals/${group}`);
    const average = sum.averageN ? sum.averageTokens / sum.averageN : null;
    assert.equal(canonical(row.avg_tokens_per_turn), canonical(average), `JS average/${group}`);
  }
  return { groups: expected.size, requests: [...expected.values()].reduce((n, row) => n + row.count, 0),
    tokens: [...expected.values()].reduce((n, row) => n + row.tokens, 0), sha256: digest(actual.map(helpers.normalized)) };
}

function instrument(db, Staging) {
  const originalExec = db.connection.exec, originalPrepare = Staging.prototype.prepareSummaries;
  let counters = {};
  db.connection.exec = function(sql) {
    const start = performance.now();
    try { return Reflect.apply(originalExec, this, [sql]); }
    finally {
      if (/SELECT e\.\* FROM (?:component|summary_batch) c/.test(sql)) { counters.aggregatePasses++; counters.aggregateSqlMs += performance.now() - start; }
    }
  };
  Staging.prototype.prepareSummaries = function(...args) {
    const start = performance.now(); counters.prepareCalls++;
    try { return Reflect.apply(originalPrepare, this, args); } finally { counters.prepareMs += performance.now() - start; }
  };
  return { reset: () => { counters = { aggregatePasses: 0, aggregateSqlMs: 0, prepareCalls: 0, prepareMs: 0 }; },
    get: () => ({ ...counters }), close: () => { db.connection.exec = originalExec; Staging.prototype.prepareSummaries = originalPrepare; } };
}

async function worker(configPath, variant, pairText, work) {
  const config = JSON.parse(await readFile(configPath, 'utf8')), pair = Number(pairText), product = config[variant];
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { SummaryStaging } = require(join(product, 'dist/src/summary/staging'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const { buildUsageQuery } = require(join(product, 'dist/src/summary/db/queries'));
  await mkdir(work, { recursive: true });
  const samples = []; let queryResult;
  for (const scenario of scenarios) {
    const path = join(work, scenario + '.sqlite');
    await copyFile(config.seed, path);
    const db = new SummaryDatabase(path), probe = instrument(db, SummaryStaging);
    let target;
    try {
      if (scenario === 'reparse') db.connection.exec('UPDATE manifest SET parser_version=0');
      if (scenario.endsWith('append')) {
        const provider = scenario.split('-')[0]; target = helpers.chooseTarget(db, provider, config.directory);
        let rows;
        if (provider === 'codex') {
          await helpers.inspectCodexTarget(target, product);
          rows = helpers.codexAppendRows(target, 'benchmark-batch-request', 'benchmark-batch-response');
        } else {
          rows = helpers.claudeRows(target.session_id);
          rows[0].cwd = db.connection.prepare('SELECT project_key FROM turn_summary WHERE provider=? AND session_id=? LIMIT 1').get(provider, target.session_id).project_key;
        }
        await helpers.appendRows(target, rows, config.directory, 1);
      }
      probe.reset(); let stores = 0, storeMs = 0;
      const originalReplace = db.replaceSessions;
      db.replaceSessions = function(...args) {
        const start = performance.now(); stores++;
        try { return Reflect.apply(originalReplace, this, args); } finally { storeMs += performance.now() - start; }
      };
      const start = performance.now();
      const refreshed = await refreshSummary(db, { dbPath: path, roots: config.roots });
      const refreshMs = performance.now() - start, counters = probe.get();
      assert.equal(refreshed.interrupted, false); assert.equal(refreshed.error, undefined);
      const totals = db.connection.prepare('SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens FROM turn_summary').get();
      assert.equal(totals.requests, config.requests + Number(scenario.endsWith('append')));
      assert.equal(totals.tokens, config.tokens + (scenario.endsWith('append') ? 130 : 0));
      if (scenario === 'unchanged') { assert.equal(refreshed.bodyBytes, 0); assert.equal(stores, 0); }
      const checked = helpers.verify(db, buildUsageQuery);
      const filter = config.filter, independent = {};
      for (const group of groups) independent[group] = independentCheck(db, filter, group, allUsage(db, group, filter));
      const sample = { scenario, variant, pair, refreshMs, storeMs, stores, ...counters, ...totals,
        parsed: refreshed.parsed, failed: refreshed.failed, bodyBytes: refreshed.bodyBytes,
        ...checked, independent, rssBytesAfterValidation: process.memoryUsage().rss,
        targetRequests: target?.requests };
      samples.push(sample);
      process.send({ kind: 'progress', variant, pair, scenario, ms: refreshMs, passes: counters.aggregatePasses });
      if (scenario === 'reparse') {
        const reads = {};
        for (const group of groups) {
          for (let index = 0; index < 3; index++) allUsage(db, group, filter);
          const times = [], results = [];
          for (let index = 0; index < config.readSamples; index++) {
            const began = performance.now(), rows = allUsage(db, group, filter);
            times.push(performance.now() - began); results.push(digest(rows.map(helpers.normalized)));
          }
          assert.equal(new Set(results).size, 1);
          reads[group] = { ...stats(times), ...independent[group] };
        }
        queryResult = reads;
      }
    } finally {
      probe.close(); db.close();
      if (target) { await truncate(target.path, target.originalBytes); await utimes(target.path, target.originalAtime, target.originalMtime); }
    }
  }
  process.send({ kind: 'result', samples, reads: queryResult });
}

function runWorker(config, variant, pair, directory) {
  return new Promise((done, fail) => {
    const child = fork(__filename, ['--worker', config, variant, String(pair), directory],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    let result;
    child.on('message', message => {
      if (message.kind === 'result') result = message;
      if (message.kind === 'failure') console.log(JSON.stringify(message));
      if (message.kind === 'progress') console.log(`${pair < 0 ? 'warmup' : 'pair'} ${pair}/${variant}/${message.scenario}: ${message.ms.toFixed(2)} ms, TEMP passes=${message.passes}`);
    });
    child.on('error', fail);
    child.on('exit', code => code === 0 && result ? done(result) : fail(new Error(`Worker failed: ${variant}/${pair}/${code}`)));
  });
}

async function prepareDataset(directory, options, product) {
  const snapshot = await helpers.makeSnapshot(directory, { ...options, after: product });
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const seed = join(directory, 'seed.sqlite'), db = new SummaryDatabase(seed), start = performance.now();
  let result;
  try {
    const refreshed = await refreshSummary(db, { dbPath: seed, roots: snapshot.roots });
    assert.equal(refreshed.interrupted, false); assert.equal(refreshed.error, undefined);
    const initialRefreshMs = performance.now() - start;
    const totals = db.connection.prepare('SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens FROM turn_summary').get();
    if (snapshot.expected) assert.deepEqual([totals.requests, totals.tokens], [snapshot.expected.requests, snapshot.expected.tokens]);
    // Build ready rollups once outside measured refreshes, equally for A and B.
    allUsage(db, 'month', {});
    const bounds = db.connection.prepare('SELECT min(started_at_ms) lo,max(started_at_ms) hi FROM turn_summary').get();
    const counts = db.connection.prepare('SELECT count(*) n FROM sessions').get();
    db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    result = { ...totals, initialRefreshMs, seedFailures: refreshed.failed, sessions: counts.n,
      range: { minMs: bounds.lo, maxMs: bounds.hi },
      filter: { fromMs: Math.floor(bounds.lo / 86400000) * 86400000 - 86400000,
        toMs: Math.ceil(bounds.hi / 86400000) * 86400000 + 86400000,
        unknownTime: 'include', excludeEmptyUsage: true } };
  } finally { db.close(); }
  return { ...snapshot, seed, ...result };
}

function summarize(trials) {
  return Object.fromEntries(scenarios.map(scenario => [scenario, Object.fromEntries(variants.map(variant => {
    const rows = trials.flatMap(trial => trial.samples).filter(row => row.scenario === scenario && row.variant === variant);
    return [variant, { ...stats(rows.map(row => row.refreshMs)), prepare: stats(rows.map(row => row.prepareMs)),
      aggregatePasses: rows.map(row => row.aggregatePasses), stores: rows.map(row => row.stores),
      store: stats(rows.map(row => row.storeMs)) }];
  }))]));
}

async function main() {
  const options = { smoke: false, syntheticOnly: false, before: '', after: root,
    hypothesis: 'Batch up to 32 affected seed sessions into one TEMP aggregation pass while retaining component-local commits.',
    output: resolve(root, 'tests/results/benchmarks/temp-batch-ab.json') };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--output=')) options.output = resolve(arg.slice(9));
    else if (arg.startsWith('--before=')) options.before = resolve(arg.slice(9));
    else if (arg.startsWith('--after=')) options.after = resolve(arg.slice(8));
    else if (arg.startsWith('--hypothesis=')) options.hypothesis = arg.slice(13);
    else if (arg === '--smoke') options.smoke = true;
    else if (arg === '--synthetic-only') options.syntheticOnly = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  assert.ok(options.before, 'Pass --before=<built baseline checkout> and optionally --after=<built candidate checkout>');
  const inputs = { A: options.before, B: options.after };
  for (const input of Object.values(inputs)) assert.ok(fs.existsSync(join(input, 'dist/src/summary/scanner.js')), 'Build both inputs first');
  assert.ok(!fs.existsSync(options.output), 'Choose a new output path');
  const cache = join(root, 'tests/.cache'); await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, 'temp-batch-'));
  const report = { startedAtSeoul: seoul(), hypothesis: options.hypothesis,
    pairs: options.smoke ? 1 : 10, warmups: options.smoke ? 0 : 3, readSamples: 1,
    environment: { node: process.version, cpu: cpus()[0]?.model, platform: process.platform, timezone,
      tempStore: 'FILE', cacheKiB: 4096, mmapBytes: 0 },
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    workingTreeAtStart: execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    sources: Object.fromEntries(variants.map(variant => [variant, fingerprints(inputs[variant], 'src')])),
    runnerSha256: sha(fs.readFileSync(__filename)),
    helperSha256: sha(fs.readFileSync(join(__dirname, 'incremental-refresh.cjs'))),
    packageLockSha256: sha(fs.readFileSync(join(root, 'package-lock.json'))), datasets: [] };
  try {
    const products = {};
    for (const variant of variants) {
      products[variant] = join(directory, variant);
      await mkdir(products[variant]); await cp(join(inputs[variant], 'dist'), join(products[variant], 'dist'), { recursive: true });
    }
    report.builds = Object.fromEntries(variants.map(variant => [variant, fingerprints(products[variant], 'dist/src')]));
    const versionDb = new DatabaseSync(':memory:');
    report.environment.sqlite = versionDb.prepare('SELECT sqlite_version() version').get().version; versionDb.close();
    const datasets = options.smoke ? [{ name: 'synthetic-100', requests: 100, 'turns-per-session': 10 }]
      : [...(options.syntheticOnly ? [] : [{ name: 'current', real: true }]), { name: 'synthetic-10000', requests: 10000, 'turns-per-session': 100 },
        { name: 'synthetic-100', requests: 100, 'turns-per-session': 10 }];
    for (const spec of datasets) {
      const dataRoot = join(directory, spec.name); await mkdir(dataRoot);
      const snapshot = await prepareDataset(dataRoot, spec, products.A);
      const configPath = join(dataRoot, 'config.json');
      await writeFile(configPath, JSON.stringify({ ...products, directory, roots: snapshot.roots, seed: snapshot.seed,
        filter: snapshot.filter, requests: snapshot.requests, tokens: snapshot.tokens, readSamples: report.readSamples }));
      const entry = { name: spec.name, requests: snapshot.requests, tokens: snapshot.tokens, sessions: snapshot.sessions,
        seedFailures: snapshot.seedFailures, inventory: snapshot.inventory, inputSha256: snapshot.sha256,
        baselineDatabaseSha256: sha(fs.readFileSync(snapshot.seed)), expected: snapshot.expected, range: snapshot.range,
        filter: snapshot.filter, initialRefreshMsAUnpaired: snapshot.initialRefreshMs,
        generator: spec.real ? undefined : { deterministic: true, seed: 'ordinal-v1 (no RNG)', providers: 'alternating sessions',
          projects: 10, turnsPerSession: spec['turns-per-session'], timestamps: '2026-07-01 plus sessionIndex%14 days; index/100 days',
          status: 'all completed', models: 'two per provider alternating by request' }, trials: [] };
      console.log(`${entry.name}: ${entry.requests} requests, ${entry.sessions} sessions, ${snapshot.files.length} files`);
      for (let pair = -report.warmups; pair < report.pairs; pair++) {
        const order = Math.abs(pair) % 2 ? ['B', 'A'] : ['A', 'B'], both = {};
        for (const variant of order) both[variant] = await runWorker(configPath, variant, pair, join(dataRoot, `pair-${pair}`, variant));
        for (const scenario of scenarios) {
          const a = both.A.samples.find(row => row.scenario === scenario), b = both.B.samples.find(row => row.scenario === scenario);
          for (const key of ['requests', 'tokens', 'parsed', 'failed', 'bodyBytes', 'factsSha256', 'aggregatesSha256', 'independent', 'stores']) {
            assert.equal(canonical(a[key]), canonical(b[key]), `A/B ${entry.name}/${scenario}/${key}`);
          }
        }
        for (const group of groups) assert.equal(both.A.reads[group].sha256, both.B.reads[group].sha256, `read/${group}`);
        if (pair >= 0) entry.trials.push(...order.map(variant => ({ variant, pair, ...both[variant] })));
      }
      for (const file of snapshot.files) assert.equal(sha(fs.readFileSync(file.path)), file.sha256, 'Frozen input was not restored');
      entry.summary = summarize(entry.trials);
      entry.readSummary = Object.fromEntries(groups.map(group => [group, Object.fromEntries(variants.map(variant =>
        [variant, stats(entry.trials.filter(trial => trial.variant === variant).flatMap(trial => trial.reads[group].samplesMs))]))]));
      entry.correctness = { abAllSamples: 'passed', javascriptRequestAggregation: 'passed', rawSqlVsRollups: 'passed',
        foreignKeysAndIntegrity: 'passed', snapshotRestored: true };
      report.datasets.push(entry);
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output + '.partial', JSON.stringify(report, null, 2) + '\n');
    }
    report.completedAtSeoul = seoul();
    await writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    await rm(options.output + '.partial');
    console.log(`Saved ${options.output}`);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(cache) + sep) && basename(directory).startsWith('temp-batch-'));
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') worker(...process.argv.slice(3)).then(() => process.disconnect(), error => {
  process.send({ kind: 'failure', code: error.code ?? error.name, message: String(error.message).split('\n')[0].slice(0, 160) });
  process.exitCode = 1; process.disconnect();
});
else if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
