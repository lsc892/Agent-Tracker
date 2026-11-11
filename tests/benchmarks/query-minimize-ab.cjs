// 고정 제품·입력에서 저장 구간과 실제 조회 작업을 분리해 측정하고 결과 동등성을 대조한다.
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { cpus, release } = require('node:os');
const { dirname, join, relative, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const helpers = require('./incremental-refresh.cjs');
const { independentCheck, stats } = require('./temp-batch-ab.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul';
const groups = ['day', 'month', 'session', 'project'];
const categories = ['skill', 'subagent', 'plugin', 'model'];
const scenarios = ['initial', 'append-one', 'unchanged'];
const peerStages = ['begin', 'prepare', 'manifest', 'indexSummaries', 'metadata', 'deleteMissing', 'summaries',
  'reconnectDiagnostics', 'removeSources', 'rollups', 'pruneNames', 'commit'];
const filter = { providers: ['claude', 'codex'], fromMs: Date.UTC(2025, 11, 31, 15),
  toMs: Date.UTC(2026, 11, 31, 15), unknownTime: 'include', excludeEmptyUsage: true };
const sha = value => createHash('sha256').update(value).digest('hex');
const clock = () => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const normalized = value => {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => !['updated_at', 'recorded_at'].includes(key)).map(key => [key, normalized(value[key])]));
  return typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(10)) : value;
};
const digest = value => sha(JSON.stringify(normalized(value)));

function fingerprint(directory) {
  const entries = [];
  function walk(path) {
    for (const file of fs.readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const child = join(path, file.name);
      if (file.isDirectory()) walk(child);
      else if (file.isFile()) entries.push([relative(directory, child).replaceAll('\\', '/'), sha(fs.readFileSync(child))]);
    }
  }
  walk(directory);
  return { files: entries.length, sha256: sha(JSON.stringify(entries)) };
}

function metadataFiles(snapshot, directory) {
  const files = [];
  for (const home of new Set(snapshot.roots.map(source => source.dataHome).filter(Boolean))) {
    for (const file of fs.readdirSync(home, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      const path = join(home, file.name), bytes = fs.readFileSync(path);
      files.push({ path, name: relative(directory, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha(bytes) });
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function allUsage(db, group, usageFilter, by) {
  const rows = []; let total;
  for (let offset = 0; ; offset += 1000) {
    const page = db.queryUsagePage(usageFilter, group, timezone, { limit: 1000, offset }, by);
    total ??= page.total; assert.equal(page.total, total); rows.push(...page.rows);
    if (rows.length >= total) break;
    assert.ok(page.rows.length, 'Nonempty remaining result must advance pagination');
  }
  assert.equal(rows.length, total);
  return rows;
}

// 모델별 정규화 facts를 JS로 합산한다. 제품 SQL·집계 builder는 사용하지 않는다.
function independentModelMeans(db, usageFilter, group, actual) {
  const models = new Map();
  for (const row of db.connection.prepare('SELECT * FROM turn_model_usage').all()) {
    if (!models.has(row.turn_id)) models.set(row.turn_id, []);
    models.get(row.turn_id).push(row);
  }
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const key = row => JSON.stringify([row.provider, row.model,
    ['project', 'session'].includes(group) ? row.project_key : null,
    group === 'session' ? row.session_id : null, ['day', 'month'].includes(group) ? row.period : null]);
  const expected = new Map();
  for (const request of db.connection.prepare('SELECT * FROM turn_summary').all()) {
    if (request.started_at_ms !== null && (request.started_at_ms < usageFilter.fromMs || request.started_at_ms >= usageFilter.toMs)) continue;
    if (request.started_at_ms === null && usageFilter.unknownTime !== 'include') continue;
    const period = request.started_at_ms === null ? null : date.format(request.started_at_ms).slice(0, group === 'month' ? 7 : 10);
    for (const model of models.get(request.id) ?? [undefined]) {
      const input = model?.input_tokens ?? request.input_tokens, output = model?.output_tokens ?? request.output_tokens;
      const tokens = input + output, modelName = model?.model ?? '';
      const row = { ...request, period, model: modelName === '' && tokens === 0 ? null : modelName };
      const groupKey = key(row), sum = expected.get(groupKey) ?? { count: 0, tokens: 0, input: 0, output: 0, samples: 0, sampleTokens: 0 };
      sum.count++; sum.tokens += tokens; sum.input += input; sum.output += output;
      if (request.status === 'completed' && (!usageFilter.excludeEmptyUsage || tokens > 0 || modelName !== '')) {
        sum.samples++; sum.sampleTokens += tokens;
      }
      expected.set(groupKey, sum);
    }
  }
  assert.equal(actual.length, expected.size, `Independent model group count/${group}`);
  for (const row of actual) {
    const sum = expected.get(key(row)); assert.ok(sum, `Independent model key/${group}`);
    assert.deepEqual([row.turn_count, row.total_tokens, row.input_tokens, row.output_tokens],
      [sum.count, sum.tokens, sum.input, sum.output], `Independent model totals/${group}`);
    const mean = sum.samples ? sum.sampleTokens / sum.samples : null;
    assert.equal(digest(row.avg_tokens_per_turn), digest(mean), `Independent model token mean/${group}`);
  }
  return { groups: expected.size, rowsSha256: digest(actual) };
}

function queryWorkloads(db) {
  const operations = [];
  for (const includeCosts of [false, true]) for (const by of ['provider', 'model']) for (const group of groups) {
    const usageFilter = { ...filter, includeCosts };
    operations.push({ name: `usage/${group}/${by}/${includeCosts ? 'costs' : 'tokens'}`,
      family: 'usage', invoke: () => db.queryUsagePage(usageFilter, group, timezone,
        { limit: 100, offset: 0, tableSort: { key: 'period', direction: 'desc' } }, by) });
  }
  for (const by of ['provider', 'model']) for (const includeCosts of [false, true]) for (const key of ['period', 'tokens', 'model']) {
    operations.push({ name: `requests/${by}/${key}/${includeCosts ? 'costs' : 'tokens'}`,
      family: 'requests', invoke: () => db.queryUsagePage({ ...filter, includeCosts }, 'turn', timezone,
        { limit: 100, offset: 0, tableSort: { key, direction: 'desc' } }, by) });
  }
  for (const kind of ['project', 'session']) operations.push({ name: `names/${kind}`, family: 'names',
    invoke: () => db.queryNames({ kind, providers: filter.providers, limit: 100, offset: 0 }) });
  operations.push({ name: 'capabilities/all-four', family: 'capabilities', invoke: () => {
    if (typeof db.queryAllCapabilities === 'function') return db.queryAllCapabilities(filter, {}, {});
    return Object.fromEntries(categories.map(category => [category, db.queryCapabilities(filter, category, 0, 100)]));
  } });
  operations.push({ name: 'coverage/counts-consumer', family: 'coverage', invoke: () =>
    typeof db.diagnosticCounts === 'function' ? db.diagnosticCounts(filter.providers)
      : typeof db.queryCoverageCounts === 'function' ? db.queryCoverageCounts(filter.providers)
      : db.diagnostics({ limit: 1, providers: filter.providers }).counts });
  return operations;
}

function observeSql(db) {
  const connection = db.connection, originalPrepare = connection.prepare;
  let active;
  connection.prepare = function(sql, ...rest) {
    const statement = Reflect.apply(originalPrepare, this, [sql, ...rest]);
    for (const method of ['all', 'get', 'run']) {
      const original = statement[method];
      statement[method] = function(...values) {
        if (!active) return Reflect.apply(original, this, values);
        const state = active, started = performance.now();
        try { return Reflect.apply(original, this, values); }
        finally {
          let item = state.get(sql);
          if (!item) { item = { sql, calls: 0, totalMs: 0, method, args: values }; state.set(sql, item); }
          item.calls++; item.totalMs += performance.now() - started; item.args = values;
        }
      };
    }
    return statement;
  };
  const finish = plans => {
    const captured = active; active = undefined;
    return [...captured.values()].sort((a, b) => b.totalMs - a.totalMs).map(({ args, ...item }) => {
      let plan;
      if (plans) {
        try { plan = Reflect.apply(originalPrepare, connection, [`EXPLAIN QUERY PLAN ${item.sql}`]).all(...args).map(row => row.detail); }
        catch { plan = ['not available']; }
      }
      return { ...item, ...(plan ? { plan } : {}) };
    });
  };
  return { start: () => { assert.equal(active, undefined); active = new Map(); }, finish,
    restore: () => { active = undefined; connection.prepare = originalPrepare; } };
}

function measureReads(db, observer, config) {
  if (config.storageOnly) return [];
  return queryWorkloads(db).map(operation => {
    const first = operation.invoke(), expected = digest(first);
    for (let n = 0; n < config.readWarmups; n++) operation.invoke();
    const samples = [];
    for (let n = 0; n < config.readSamples; n++) {
      const started = performance.now(); operation.invoke(); samples.push(performance.now() - started);
    }
    observer.start(); const diagnostic = operation.invoke(), sql = observer.finish(config.profileOnly);
    assert.equal(digest(diagnostic), expected, `Stable public result/${operation.name}`);
    return { name: operation.name, family: operation.family, timing: stats(samples), resultSha256: expected,
      resultRows: Array.isArray(first.rows) ? first.rows.length : undefined, sqlDiagnostic: sql };
  });
}

function totals(db) {
  return { ...db.connection.prepare('SELECT COUNT(*) requests,COALESCE(SUM(total_tokens),0) tokens FROM turn_summary').get() };
}

function measureBilling(db, observer, target, config) {
  if (!config.includeBilling) return [];
  const scope = [target.provider ?? 'codex', target.session_id];
  const costs = () => db.connection.prepare(`SELECT c.* FROM turn_costs c
    JOIN turn_summary t ON t.id=c.turn_id WHERE t.provider=? AND t.session_id=? ORDER BY c.turn_id`).all(...scope);
  const originalCosts = costs();
  const selection = () => db.connection.prepare('SELECT * FROM session_billing WHERE provider=? AND session_id=?').get(...scope);
  const originalSelection = selection();
  const result = () => ({ costs: costs(), selection: selection() });
  const restore = () => db.transaction(() => {
    db.connection.prepare('DELETE FROM session_billing WHERE provider=? AND session_id=?').run(...scope);
    if (originalSelection) db.connection.prepare('INSERT INTO session_billing VALUES(?,?,?)')
      .run(originalSelection.provider, originalSelection.session_id, originalSelection.billing_mode);
    db.connection.prepare(`DELETE FROM turn_costs WHERE turn_id IN (
      SELECT id FROM turn_summary WHERE provider=? AND session_id=?)`).run(...scope);
    const insert = db.connection.prepare('INSERT INTO turn_costs VALUES(?,?,?,?,?)');
    for (const cost of originalCosts) insert.run(cost.turn_id, cost.billing_mode, cost.cost_usd, cost.unknown_costs, cost.pricing_version);
  });
  const results = [];
  try {
    for (const mode of ['api', 'subscription', 'unknown']) {
      restore(); db.setSessionBilling(...scope, mode);
      assert.equal(selection()?.billing_mode, mode);
      const expected = digest(result());
      for (let n = 0; n < config.readWarmups; n++) { restore(); db.setSessionBilling(...scope, mode); }
      const samples = [];
      for (let n = 0; n < config.readSamples; n++) {
        restore(); const started = performance.now();
        db.setSessionBilling(...scope, mode); samples.push(performance.now() - started);
        assert.equal(digest(result()), expected, 'Stable billing results from the same original state');
      }
      restore(); observer.start(); db.setSessionBilling(...scope, mode);
      const sql = observer.finish(config.profileOnly);
      assert.equal(digest(result()), expected);
      results.push({ mode, requests: originalCosts.length, timing: stats(samples), resultSha256: expected, sqlDiagnostic: sql });
    }
  } finally { restore(); }
  assert.deepEqual(costs(), originalCosts); assert.deepEqual(selection(), originalSelection);
  return results;
}

async function worker(configPath, variant, pairText, directory) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')), product = config.products[variant];
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { refreshSummary, PARSER_VERSION } = require(join(product, 'dist/src/summary/scanner'));
  const { buildUsageQuery } = require(join(product, 'dist/src/summary/db/queries'));
  await fsp.mkdir(directory, { recursive: true });
  const dbPath = join(directory, 'summary.sqlite'), openStart = performance.now(), db = new SummaryDatabase(dbPath);
  const openMs = performance.now() - openStart;
  const observer = config.profileOnly ? observeSql(db) : { start() {}, finish() { return []; }, restore() {} };
  const samples = [];
  let target;
  try {
    const activationStart = performance.now();
    db.queryUsagePage(filter, 'day', timezone, { limit: 100 });
    const emptyRollupActivationMs = performance.now() - activationStart;
    async function refresh(scenario) {
      if (config.profileOnly) observer.start();
      const started = performance.now();
      const result = await refreshSummary(db, { dbPath, roots: config.snapshot.roots, timezone,
        collectCapabilities: true, retainDeletedSourceUsage: true });
      const elapsedMs = performance.now() - started;
      const sql = config.profileOnly ? observer.finish(true) : [];
      assert.equal(result.failed, 0); assert.equal(result.interrupted, false); assert.equal(result.error, undefined);
      const { scanId: _scanId, completedAt: _completedAt, ...refreshResult } = result;
      const sample = { scenario, elapsedMs, refresh: refreshResult, totals: totals(db), sqlDiagnostic: sql };
      samples.push(sample); process.send({ kind: 'progress', scenario, ms: elapsedMs });
      return sample;
    }
    const initial = await refresh('initial');
    if (config.snapshot.expected) assert.deepEqual(initial.totals,
      { requests: config.snapshot.expected.requests, tokens: config.snapshot.expected.tokens });
    const initialDistribution = { ...initial.totals,
      sessions: db.connection.prepare('SELECT COUNT(*) n FROM sessions').get().n,
      projects: db.connection.prepare('SELECT COUNT(*) n FROM projects').get().n,
      models: db.connection.prepare('SELECT COUNT(*) n FROM turn_model_usage').get().n,
      capabilities: db.connection.prepare('SELECT COUNT(*) n FROM turn_capability_usage').get().n };
    const beforeRows = digest(db.connection.prepare('SELECT * FROM turn_summary ORDER BY id').all());
    target = helpers.chooseTarget(db, 'codex', config.directory);
    await helpers.inspectCodexTarget(target, product);
    await helpers.appendRows(target, helpers.codexAppendRows(target, 'query-minimize-added-request', 'query-minimize-added-response'), config.directory, 1);
    const appended = await refresh('append-one');
    assert.deepEqual(appended.totals, { requests: initial.totals.requests + 1, tokens: initial.totals.tokens + 130 });
    const added = db.connection.prepare('SELECT id FROM turn_summary WHERE root_turn_id=?').all('query-minimize-added-request');
    assert.equal(added.length, 1);
    assert.equal(digest(db.connection.prepare('SELECT * FROM turn_summary WHERE id<>? ORDER BY id').all(added[0].id)), beforeRows);
    const reads = measureReads(db, observer, config);
    const averages = {}, independent = {};
    for (const by of ['provider', 'model']) for (const group of groups) {
      const started = performance.now(), rows = allUsage(db, group, filter, by);
      averages[`${group}/${by}`] = { elapsedMs: performance.now() - started, groups: rows.length, rowsSha256: digest(rows) };
      for (const excludeEmptyUsage of [true, false]) {
        const usageFilter = { ...filter, excludeEmptyUsage };
        const actual = excludeEmptyUsage ? rows : allUsage(db, group, usageFilter, by);
        independent[`${group}/${by}/${excludeEmptyUsage}`] = by === 'provider'
          ? independentCheck(db, usageFilter, group, actual) : independentModelMeans(db, usageFilter, group, actual);
      }
    }
    const checked = helpers.verify(db, buildUsageQuery);
    const billing = measureBilling(db, observer, target, config);
    const unchanged = await refresh('unchanged');
    assert.deepEqual(unchanged.totals, appended.totals); assert.equal(unchanged.refresh.bodyBytes, 0);
    assert.equal(unchanged.refresh.parsed, 0); assert.deepEqual(unchanged.refresh.timings.storage, {});
    assert.deepEqual(helpers.verify(db, buildUsageQuery), checked);
    const pragmas = Object.fromEntries(['journal_mode', 'synchronous', 'wal_autocheckpoint', 'cache_size', 'temp_store', 'mmap_size']
      .map(name => [name, Object.values(db.connection.prepare(`PRAGMA ${name}`).get())[0]]));
    process.send({ kind: 'result', result: { variant, pair: Number(pairText), openMs, emptyRollupActivationMs,
      samples, reads, averages, billing, independent, checked, initialDistribution, pragmas, parserVersion: PARSER_VERSION,
      sqlite: db.connection.prepare('SELECT sqlite_version() version').get().version,
      appendTarget: { provider: 'codex', existingSessionRequests: target.requests, sourceBytesBefore: target.originalBytes } } });
  } finally {
    if (target) { await fsp.truncate(target.path, target.originalBytes); await fsp.utimes(target.path, target.originalAtime, target.originalMtime); }
    observer.restore(); db.close();
  }
}

function runWorker(config, variant, pair, directory) {
  return new Promise((done, fail) => {
    let result, errorText = '';
    const child = fork(__filename, ['--worker', config, variant, String(pair), directory], {
      execArgv: ['--no-warnings'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    child.stderr.on('data', value => { errorText += value.toString(); });
    child.on('message', message => {
      if (message.kind === 'result') result = message.result;
      if (message.kind === 'progress') console.log(`${variant} ${pair} ${message.scenario}: ${message.ms.toFixed(3)} ms`);
    });
    child.on('error', fail);
    child.on('exit', code => code === 0 && result ? done(result) : fail(new Error(`Worker ${variant} failed: ${errorText.split('\n')[0] || code}`)));
  });
}

function assertPair(pair) {
  assert.deepEqual(pair.A.initialDistribution, pair.B.initialDistribution, 'Initial inventory equality');
  assert.deepEqual(pair.A.checked, pair.B.checked, 'Persisted facts and raw/rollup equality');
  for (const scenario of scenarios) assert.deepEqual(
    pair.A.samples.find(sample => sample.scenario === scenario).totals,
    pair.B.samples.find(sample => sample.scenario === scenario).totals, `Totals/${scenario}`);
  assert.deepEqual(pair.A.reads.map(item => [item.name, item.resultSha256]), pair.B.reads.map(item => [item.name, item.resultSha256]), 'All public read results equal');
  assert.deepEqual(pair.A.billing.map(item => [item.mode, item.requests, item.resultSha256]),
    pair.B.billing.map(item => [item.mode, item.requests, item.resultSha256]), 'Billing writes and restored state equal');
  assert.deepEqual(pair.A.independent, pair.B.independent, 'Independent provider/model means equal');
}

function summarize(trials) {
  const compare = select => {
    const A = stats(trials.map(pair => select(pair.A))), B = stats(trials.map(pair => select(pair.B)));
    return { A, B, improvementPercent: A.medianMs ? (A.medianMs - B.medianMs) / A.medianMs * 100 : null,
      BWinPairs: trials.filter(pair => select(pair.B) < select(pair.A)).length };
  };
  const sampleFor = (result, scenario) => result.samples.find(sample => sample.scenario === scenario);
  const storage = Object.fromEntries(scenarios.map(scenario => {
    const stages = [...new Set(trials.flatMap(pair => ['A', 'B'].flatMap(variant =>
      Object.keys(sampleFor(pair[variant], scenario).refresh.timings.storage))))].sort();
    return [scenario, Object.fromEntries(stages.map(stage => {
      const value = (result, field) => sampleFor(result, scenario).refresh.timings.storage[stage]?.[field] ?? 0;
      const A = trials.map(pair => value(pair.A, 'calls')), B = trials.map(pair => value(pair.B, 'calls'));
      return [stage, { elapsed: compare(result => value(result, 'totalMs')),
        calls: { A, B, medianA: stats(A).medianMs, medianB: stats(B).medianMs } }];
    }))];
  }));
  const topTwoPeerStages = Object.fromEntries(scenarios.map(scenario => [scenario,
    peerStages.filter(stage => storage[scenario][stage]).map(stage => ({ stage,
      A: storage[scenario][stage].elapsed.A.medianMs, B: storage[scenario][stage].elapsed.B.medianMs }))
      .sort((a, b) => b.A - a.A).slice(0, 2)]));
  return { refresh: Object.fromEntries(scenarios.map(scenario => [scenario,
    compare(value => value.samples.find(sample => sample.scenario === scenario).elapsedMs)])),
  storage, topTwoPeerStages,
  reads: Object.fromEntries(trials[0].A.reads.map(item => [item.name,
    compare(value => value.reads.find(read => read.name === item.name).timing.medianMs)])),
  billing: Object.fromEntries(trials[0].A.billing.map(item => [item.mode,
    compare(value => value.billing.find(operation => operation.mode === item.mode).timing.medianMs)])),
  averages: Object.fromEntries(Object.keys(trials[0].A.averages).map(name => [name,
    compare(value => value.averages[name].elapsedMs)])) };
}

function baselineRanks(result) {
  return { reads: [...result.reads].sort((a, b) => b.timing.medianMs - a.timing.medianMs)
    .map(item => ({ name: item.name, family: item.family, medianMs: item.timing.medianMs })),
  storage: Object.fromEntries(result.samples.map(sample => [sample.scenario,
    peerStages.map(stage => ({ stage, ...(sample.refresh.timings.storage[stage] ?? { calls: 0, totalMs: 0 }) }))
      .sort((a, b) => b.totalMs - a.totalMs)])) };
}

async function main() {
  const options = { workspace: '', before: '', after: '', output: '', pairs: 10, warmups: 3,
    readWarmups: 3, readSamples: 0, datasets: 'current,synthetic-10000,synthetic-100',
    experiment: 'query-minimize', dateSeoul: clock().slice(0, 10) };
  let profileOnly = false, prepareOnly = false, storageOnly = false, includeBilling = false;
  for (const arg of process.argv.slice(2)) {
    if (['--baseline-only', '--profile-only'].includes(arg)) { profileOnly = true; continue; }
    if (arg === '--prepare-only') { prepareOnly = true; continue; }
    if (arg === '--storage-only') { storageOnly = true; continue; }
    if (arg === '--billing') { includeBilling = true; continue; }
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    assert.ok(match && Object.hasOwn(options, match[1]), 'Unknown or incomplete argument');
    options[match[1]] = ['pairs', 'warmups', 'readWarmups', 'readSamples'].includes(match[1]) ? Number(match[2]) : match[2];
  }
  for (const name of ['workspace', 'before', 'after', 'output']) if (options[name]) options[name] = resolve(options[name]);
  assert.ok(options.workspace && options.before, '--workspace and --before required');
  for (const name of ['pairs', 'warmups', 'readWarmups', 'readSamples']) assert.ok(Number.isSafeInteger(options[name]) && options[name] >= 0);
  assert.ok(options.pairs > 0);
  options.readSamples ||= profileOnly ? 10 : 1;
  const specifications = [{ name: 'current', real: true },
    { name: 'synthetic-10000', requests: 10000, 'turns-per-session': 100 },
    { name: 'synthetic-100', requests: 100, 'turns-per-session': 10 }]
    .filter(spec => options.datasets.split(',').includes(spec.name));
  assert.ok(specifications.length);
  await fsp.mkdir(options.workspace, { recursive: true });
  const snapshots = [];
  for (const specification of specifications) {
    const directory = join(options.workspace, specification.name), snapshotPath = join(directory, 'snapshot.json');
    if (!fs.existsSync(snapshotPath)) {
      await fsp.mkdir(directory, { recursive: true });
      const snapshot = await helpers.makeSnapshot(directory, { ...specification, after: options.before });
      await fsp.writeFile(snapshotPath, JSON.stringify(snapshot), { flag: 'wx' });
    }
    snapshots.push({ ...specification, directory, snapshot: JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) });
  }
  if (prepareOnly) { console.log('Frozen inputs prepared.'); return; }
  assert.ok(options.output && (profileOnly || options.after), '--output and an A/B pair (or --profile-only) required');
  assert.equal(fs.existsSync(options.output), false, 'Never overwrite measurements');
  const paired = Boolean(options.after);
  const products = paired ? { A: options.before, B: options.after } : { A: options.before };
  const trialRoot = await fsp.mkdtemp(join(options.workspace, profileOnly ? 'profile-' : 'trials-'));
  const report = { experiment: options.experiment, dateSeoul: options.dateSeoul, startedAtSeoul: clock(), profileOnly, storageOnly, includeBilling,
    timezone, filter, warmupPairs: profileOnly ? 0 : options.warmups, measuredPairs: profileOnly ? 1 : options.pairs,
    readWarmups: options.readWarmups, readSamplesPerProcess: options.readSamples,
    command: ['node', '--no-warnings', relative(root, __filename).replaceAll('\\', '/'), ...process.argv.slice(2)],
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    runnerSha256: sha(fs.readFileSync(__filename)), helpersSha256: Object.fromEntries(['incremental-refresh.cjs', 'temp-batch-ab.cjs']
      .map(name => [name, sha(fs.readFileSync(join(__dirname, name)))])),
    products: Object.fromEntries(Object.entries(products).map(([variant, product]) => [variant,
      { source: fingerprint(join(product, 'src')), build: fingerprint(join(product, 'dist/src')) }])),
    environment: { node: process.version, platform: process.platform, release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
    method: { timing: 'Actual refreshSummary through COMMIT/optimize and full public query API return; no process startup, copy, append, source restore or correctness checks inside timers.',
      reads: storageOnly ? 'Focused storage comparison: broad UI read workloads omitted; all-page day/month/session/project token means on provider/model bases remain timed and independently checked.'
        : 'Warm cache; fixed 2026 calendar interval; limit100/offset0; three request sorts, costs on/off, provider/model, all four categories as one consumer operation. All-page averages are also measured separately.',
      instrumentation: profileOnly
        ? 'SQL instrumentation wraps prepare/all/get/run and retains wrapper overhead; these diagnostic timings are not pure product latency.'
        : 'No SQL prepare/all/get/run wrappers are installed. SQL execution counts are measured by separate correctness validation. Built-in product StageProfiler remains enabled; overlapping timers are not summed.',
      rankings: 'Read operations ranked separately from storage peer stages. Different user operations/frequencies are not a single combined bottleneck ranking.',
      cache: 'OS cache uncontrolled; no forced GC or cache reset. Each variant/trial uses a fresh process and new DB; empty rollup activation occurs before refresh timing.',
      billing: includeBilling ? 'Largest accepted Codex session; api/subscription/unknown each time starts from restored original selection and costs. Timing includes public setSessionBilling through COMMIT; restore and result checks are outside timers.' : 'not measured',
      correctness: 'A/B semantic facts and public result hashes; raw/rollup10 dimensions; independent JS provider/model token means for four groups with empty usage both included/excluded; +1request/+130tokens, prior rows unchanged, unchanged refresh skip, FK/integrity.',
      limitations: 'No independent parser oracle for private real logs, UI/extension-host IPC/network/quota/heap peak or hostile cancellation cases. Generated synthetic logs are ordinary deterministic requests; capability density is reported rather than manufactured.' }, datasets: [] };
  for (const dataset of snapshots) {
    for (const file of dataset.snapshot.files) assert.equal(sha(fs.readFileSync(file.path)), file.sha256, 'Frozen input hash');
    const metadata = metadataFiles(dataset.snapshot, dataset.directory);
    const publicMetadata = metadata.map(({ path: _path, ...file }) => file);
    const work = join(trialRoot, dataset.name); await fsp.mkdir(work, { recursive: true });
    const configPath = join(work, 'config.json');
    await fsp.writeFile(configPath, JSON.stringify({ products, directory: dataset.directory, snapshot: dataset.snapshot,
      profileOnly, storageOnly, includeBilling, readWarmups: options.readWarmups, readSamples: options.readSamples }));
    const entry = { name: dataset.name, transcriptSha256: dataset.snapshot.sha256, metadata: publicMetadata,
      inputSha256: sha(JSON.stringify({ transcripts: dataset.snapshot.sha256, metadata: publicMetadata })), inventory: dataset.snapshot.inventory,
      expected: dataset.snapshot.expected ?? null, trials: [], warmupChecks: [] };
    const startPair = profileOnly ? 0 : -options.warmups, endPair = profileOnly ? 1 : options.pairs;
    for (let pair = startPair; pair < endPair; pair++) {
      const both = {}, order = !paired ? ['A'] : profileOnly || !((pair + options.warmups) % 2) ? ['A', 'B'] : ['B', 'A'];
      for (const variant of order) both[variant] = await runWorker(configPath, variant, pair, join(work, `pair-${pair}`, variant));
      if (paired) assertPair(both);
      if (pair < 0) entry.warmupChecks.push({ pair, equal: true }); else entry.trials.push(both);
      await fsp.writeFile(join(options.workspace, `${options.experiment}-partial.json`), JSON.stringify({ ...report, currentDataset: entry }, null, 2));
    }
    for (const file of dataset.snapshot.files) assert.equal(sha(fs.readFileSync(file.path)), file.sha256, 'Frozen sources restored');
    assert.deepEqual(metadataFiles(dataset.snapshot, dataset.directory), metadata, 'Frozen name metadata unchanged');
    entry.distribution = entry.trials[0].A.initialDistribution;
    entry.correctness = { frozenSourcesRestored: true, frozenNamesUnchanged: true, rawAndRollup: true, independentMeans: true, exactAppendDelta: true,
      foreignKeysAndIntegrity: true, allAbPairs: paired ? true : 'not applicable' };
    if (profileOnly) entry.rankings = paired ? Object.fromEntries(['A', 'B'].map(variant => [variant, baselineRanks(entry.trials[0][variant])]))
      : baselineRanks(entry.trials[0].A);
    if (paired) entry.summary = summarize(entry.trials);
    report.environment.sqlite = entry.trials[0].A.sqlite; report.datasets.push(entry);
    console.log(`${dataset.name}: ${entry.distribution.requests} initial requests; completed.`);
  }
  report.completedAtSeoul = clock();
  for (const [variant, product] of Object.entries(products)) {
    assert.deepEqual(fingerprint(join(product, 'src')), report.products[variant].source, 'Fixed source fingerprint');
    assert.deepEqual(fingerprint(join(product, 'dist/src')), report.products[variant].build, 'Fixed build fingerprint');
  }
  await fsp.mkdir(dirname(options.output), { recursive: true });
  await fsp.writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Saved ${relative(root, options.output)}`);
}

if (process.argv[2] === '--worker') worker(...process.argv.slice(3)).then(() => process.disconnect(), error => {
  console.error(`${error.name}: ${error.message.split('\n')[0]}`); process.exitCode = 1; process.disconnect();
});
else main().catch(error => { console.error(`${error.name}: ${error.message.split('\n')[0]}`); process.exitCode = 1; });
