// 같은 현재 소스에서 요청별 증분 저장을 롤백한 효과와 실제 주요 조회를 측정한다.
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { mkdtemp, mkdir, readFile, writeFile, truncate, utimes, rm } = require('node:fs/promises');
const { join, resolve, dirname, basename } = require('node:path');
const { tmpdir, cpus } = require('node:os');
const { performance } = require('node:perf_hooks');
const helpers = require('./incremental-refresh.cjs');
const variants = ['before', 'after'];
const scenarios = ['initial', 'unchanged', 'reparse-same', 'codex-append', 'claude-append', 'codex-extend'];
const sha = value => createHash('sha256').update(value).digest('hex');
const seoul = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2; };
const stats = values => ({ median: median(values), min: Math.min(...values), max: Math.max(...values) });

function sources(root) {
  const result = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = directory + '/' + entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) result[path] = sha(fs.readFileSync(join(root, path)));
    }
  }
  walk('src');
  return result;
}

function instrument(db) {
  const exec = db.connection.exec, prepare = db.connection.prepare;
  let enabled = false, operations = {};
  function record(name, action) {
    if (!enabled) return action();
    const start = performance.now();
    try { return action(); }
    finally { const row = operations[name] ??= { calls: 0, ms: 0 }; row.calls++; row.ms += performance.now() - start; }
  }
  function kind(sql) {
    const match = /^\s*(INSERT(?: OR (?:IGNORE|REPLACE))? INTO|DELETE FROM|UPDATE)\s+(turn_summary|turn_model_usage|turn_capability_usage|turn_costs|usage_request_daily|usage_model_daily)\b/i.exec(sql);
    return match ? `${match[1].split(' ')[0].toLowerCase()}/${match[2]}` : undefined;
  }
  db.connection.exec = function(sql) {
    const name = kind(sql);
    return name ? record(name, () => Reflect.apply(exec, this, [sql])) : Reflect.apply(exec, this, [sql]);
  };
  db.connection.prepare = function(sql) {
    const statement = Reflect.apply(prepare, this, [sql]), name = kind(sql);
    if (name) {
      const run = statement.run;
      statement.run = function(...values) { return record(name, () => Reflect.apply(run, this, values)); };
    }
    return statement;
  };
  return {
    start: () => { operations = {}; enabled = true; }, stop: () => { enabled = false; return operations; },
    close: () => { db.connection.exec = exec; db.connection.prepare = prepare; },
  };
}

function querySpecs(db, referenceMs) {
  const project = db.connection.prepare(`SELECT provider,project_key,count(*) n FROM turn_summary
    GROUP BY provider,project_key ORDER BY n DESC,provider,project_key LIMIT 1`).get();
  assert.ok(project);
  const week = { fromMs: referenceMs - 7 * 86400000, toMs: referenceMs, unknownTime: 'exclude' };
  const month = { fromMs: referenceMs - 30 * 86400000, toMs: referenceMs, unknownTime: 'exclude' };
  return [
    ['period-day-30d', 'day', month], ['period-month-30d', 'month', month],
    ['project-sessions-all', 'session', { provider: project.provider, projectKey: project.project_key }],
    ['project-sessions-30d', 'session', { ...month, provider: project.provider, projectKey: project.project_key }],
    ['average-7d', 'total', week], ['average-30d', 'total', month],
  ].flatMap(([name, group, filter]) => ['provider', 'model'].map(by => ({ name: `${name}/${by}`, group, by, filter })));
}

function queries(db, buildUsageQuery, referenceMs) {
  return querySpecs(db, referenceMs).map(spec => {
    const execute = () => db.queryUsagePage(spec.filter, spec.group, 'Asia/Seoul', { limit: 100 }, spec.by);
    for (let index = 0; index < 3; index++) execute();
    const times = [];
    let page;
    for (let index = 0; index < 7; index++) { const start = performance.now(); page = execute(); times.push(performance.now() - start); }
    const raw = buildUsageQuery(spec.filter, spec.group, 'Asia/Seoul', spec.by);
    const expected = db.connection.prepare(raw.sql).all(...raw.values, 100, 0).map(helpers.normalized);
    const actual = page.rows.map(helpers.normalized);
    assert.deepEqual(actual, expected, `Workload raw mismatch: ${spec.name}`);
    const counts = db.connection.prepare(`SELECT count(*) n,count(DISTINCT session_id) sessions FROM turn_summary
      WHERE started_at_ms>=? AND started_at_ms<?`).get(referenceMs - 30 * 86400000, referenceMs);
    return { name: spec.name, timingMs: stats(times), rows: page.rows.length, total: page.total,
      outputSha256: sha(JSON.stringify(actual)), recent30Requests: counts.n, recent30Sessions: counts.sessions };
  });
}

async function worker(configPath, variant, pair, trialPath) {
  const config = JSON.parse(await readFile(configPath, 'utf8')), product = config[variant];
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { SummaryStaging } = require(join(product, 'dist/src/summary/staging'));
  const { refreshSummary, PARSER_VERSION } = require(join(product, 'dist/src/summary/scanner'));
  const { buildUsageQuery } = require(join(product, 'dist/src/summary/db/queries'));
  await mkdir(trialPath, { recursive: true });
  const dbPath = join(trialPath, 'summary.sqlite'), db = new SummaryDatabase(dbPath), targets = [], samples = [];
  const probe = instrument(db), originalPrepare = SummaryStaging.prototype.prepareSummaries, originalReplace = db.replaceSessions;
  let prepareMs = 0, replaceMs = 0, replacements = 0, scenario;
  SummaryStaging.prototype.prepareSummaries = function(...args) {
    const start = performance.now(); try { return Reflect.apply(originalPrepare, this, args); } finally { prepareMs += performance.now() - start; }
  };
  db.replaceSessions = function(...args) {
    const start = performance.now(); replacements++;
    try { return Reflect.apply(originalReplace, this, args); } finally { replaceMs += performance.now() - start; }
  };
  try {
    for (const [ordinal, current] of scenarios.entries()) {
      scenario = current;
      if (scenario === 'reparse-same') db.connection.exec('UPDATE manifest SET parser_version=0');
      if (scenario === 'codex-append') {
        const target = helpers.chooseTarget(db, 'codex', config.directory); targets.push(target);
        await helpers.inspectCodexTarget(target, product);
        await helpers.appendRows(target, helpers.codexAppendRows(target, 'benchmark-incremental-codex', 'benchmark-codex-response'), config.directory, ordinal);
      }
      if (scenario === 'claude-append') {
        const target = helpers.chooseTarget(db, 'claude', config.directory); targets.push(target);
        const rows = helpers.claudeRows(target.session_id);
        rows[0].cwd = db.connection.prepare('SELECT project_key FROM turn_summary WHERE provider=? AND session_id=? LIMIT 1').get('claude', target.session_id).project_key;
        await helpers.appendRows(target, rows, config.directory, ordinal);
      }
      if (scenario === 'codex-extend') await helpers.appendRows(targets[0], helpers.codexAppendRows(targets[0], 'benchmark-incremental-codex', 'benchmark-codex-extension', 19), config.directory, ordinal);
      db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      prepareMs = 0; replaceMs = 0; replacements = 0;
      let phase, phaseStart = performance.now(); const phases = {};
      const start = phaseStart; probe.start();
      const refreshed = await refreshSummary(db, { dbPath, roots: config.roots }, undefined, progress => {
        if (progress.phase !== phase) {
          const now = performance.now(); phases[phase ?? 'startup'] = now - phaseStart; phaseStart = now; phase = progress.phase;
          if (phase === 'parsing') process.send({ kind: 'progress', variant, pair, scenario });
        }
      });
      const refreshMs = performance.now() - start, operations = probe.stop();
      const queryStart = performance.now(); db.queryUsagePage({}, 'month', 'Asia/Seoul', { limit: 100 }, 'provider');
      const firstQueryMs = performance.now() - queryStart;
      assert.equal(refreshed.interrupted, false); assert.equal(refreshed.error, undefined); assert.equal(refreshed.failed, 0);
      const totals = db.connection.prepare('SELECT count(*) requests,sum(total_tokens) tokens FROM turn_summary').get();
      if (scenario === 'initial' && config.expected) {
        assert.equal(totals.requests, config.expected.requests); assert.equal(totals.tokens, config.expected.tokens);
      }
      if (scenario.endsWith('append')) {
        assert.equal(totals.requests, samples.at(-1).requests + 1); assert.equal(totals.tokens, samples.at(-1).tokens + 130);
      }
      if (scenario === 'codex-extend') { assert.equal(totals.requests, samples.at(-1).requests); assert.equal(totals.tokens, samples.at(-1).tokens + 26); }
      if (scenario === 'unchanged') { assert.equal(refreshed.bodyBytes, 0); assert.equal(replacements, 0); }
      const checked = helpers.verify(db, buildUsageQuery);
      const sample = { variant, pair, scenario, refreshMs, firstQueryMs, elapsedMs: refreshMs + firstQueryMs,
        scanMs: phases.scanning ?? 0, parseMs: phases.parsing ?? 0, commitPhaseMs: phases.committing ?? 0,
        startupMs: phases.startup ?? 0, prepareMs, replaceMs, replacements, operations,
        ...totals, discovered: refreshed.discovered, parsed: refreshed.parsed, reused: refreshed.reused, bodyBytes: refreshed.bodyBytes,
        ...checked, workloads: scenario === 'initial' ? queries(db, buildUsageQuery, config.referenceMs) : undefined,
        targetRequests: scenario.endsWith('append') ? targets.at(-1).requests : undefined,
        walBytes: fs.existsSync(dbPath + '-wal') ? fs.statSync(dbPath + '-wal').size : 0 };
      samples.push(sample); process.send({ kind: 'sample', sample });
    }
    process.send({ kind: 'result', samples, sqlite: db.connection.prepare('SELECT sqlite_version() version').get().version, parser: PARSER_VERSION });
  } catch (error) {
    process.send({ kind: 'failure', scenario, code: error.code ?? error.name,
      actual: typeof error.actual === 'number' ? error.actual : undefined, expected: typeof error.expected === 'number' ? error.expected : undefined });
    throw error;
  } finally {
    probe.close(); SummaryStaging.prototype.prepareSummaries = originalPrepare; db.close();
    for (const target of targets) { assert.ok(target.path.startsWith(config.directory)); await truncate(target.path, target.originalBytes); await utimes(target.path, target.originalAtime, target.originalMtime); }
  }
}

function runWorker(config, variant, pair, directory) {
  return new Promise((resolveWorker, reject) => {
    const child = fork(__filename, ['--worker', config, variant, String(pair), directory], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    let result;
    child.on('message', message => {
      if (message.kind === 'result') result = message;
      if (message.kind === 'progress') console.log(`${pair < 0 ? 'warmup' : `pair ${pair + 1}`} ${variant} ${message.scenario}: parsing`);
      if (message.kind === 'failure') console.log(JSON.stringify(message));
      if (message.kind === 'sample') {
        const row = message.sample;
        console.log(`${pair < 0 ? 'warmup' : `pair ${pair + 1}`} ${variant} ${row.scenario}: total=${row.elapsedMs.toFixed(2)} scan=${row.scanMs.toFixed(2)} parse=${row.parseMs.toFixed(2)} prepare=${row.prepareMs.toFixed(2)} store=${row.replaceMs.toFixed(2)} ms`);
      }
    });
    child.on('error', reject); child.on('exit', code => code === 0 && result ? resolveWorker(result) : reject(new Error(`Rollback worker failed: ${variant}/${pair}/${code}`)));
  });
}

async function main() {
  const options = { before: '', after: '', real: false, requests: 0, pairs: 3, warmups: 1,
    report: resolve('tests/results/benchmarks/refresh-rollback.json'), 'turns-per-session': 100, referenceMs: Date.now() };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--real') { options.real = true; continue; }
    const match = /^--([^=]+)=(.+)$/.exec(arg); assert.ok(match && Object.hasOwn(options, match[1]));
    options[match[1]] = ['requests', 'pairs', 'warmups', 'turns-per-session', 'referenceMs'].includes(match[1]) ? Number(match[2]) : resolve(match[2]);
  }
  assert.ok(!fs.existsSync(options.report)); assert.ok(options.pairs >= 1 && options.warmups >= 0);
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-rollback-')), startedAtSeoul = seoul();
  try {
    const snapshot = await helpers.makeSnapshot(directory, options), config = join(directory, 'config.json');
    console.log(`Frozen ${options.real ? 'real' : 'synthetic'} input: ${snapshot.files.length} files, ${snapshot.inventory.reduce((n, row) => n + row.bytes, 0)} bytes`);
    await writeFile(config, JSON.stringify({ ...options, directory, roots: snapshot.roots, expected: snapshot.expected }));
    const trials = [];
    for (let pair = -options.warmups; pair < options.pairs; pair++) {
      const pairResults = [];
      for (const variant of pair >= 0 && pair % 2 ? [...variants].reverse() : variants) pairResults.push(await runWorker(config, variant, pair, join(directory, `${pair}-${variant}`)));
      for (const scenario of scenarios) {
        const rows = pairResults.map(result => result.samples.find(row => row.scenario === scenario));
        for (const key of ['factsSha256', 'aggregatesSha256', 'requests', 'tokens', 'parsed', 'bodyBytes']) assert.equal(rows[0][key], rows[1][key], `A/B mismatch ${scenario}/${key}`);
      }
      for (let index = 0; index < pairResults[0].samples[0].workloads.length; index++) {
        const rows = pairResults.map(result => result.samples[0].workloads[index]);
        assert.equal(rows[0].outputSha256, rows[1].outputSha256); assert.equal(rows[0].total, rows[1].total);
      }
      if (pair >= 0) trials.push(...pairResults);
    }
    for (const file of snapshot.files) { const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(file.path)) hash.update(chunk); assert.equal(hash.digest('hex'), file.sha256); }
    const samples = trials.flatMap(trial => trial.samples), summary = scenarios.map(scenario => {
      const row = { scenario };
      for (const variant of variants) {
        const chosen = samples.filter(sample => sample.variant === variant && sample.scenario === scenario);
        row[variant] = Object.fromEntries(['elapsedMs', 'refreshMs', 'firstQueryMs', 'scanMs', 'parseMs', 'prepareMs', 'replaceMs', 'commitPhaseMs', 'walBytes'].map(key => [key, stats(chosen.map(sample => sample[key]))]));
        row[variant].operations = Object.fromEntries([...new Set(chosen.flatMap(sample => Object.keys(sample.operations)))].map(key => [key, {
          calls: stats(chosen.map(sample => sample.operations[key]?.calls ?? 0)), ms: stats(chosen.map(sample => sample.operations[key]?.ms ?? 0)),
        }]));
      }
      row.changePercent = (row.after.elapsedMs.median / row.before.elapsedMs.median - 1) * 100;
      row.fasterPairs = samples.filter(sample => sample.variant === 'before' && sample.scenario === scenario).filter(sample => samples.find(other => other.variant === 'after' && other.scenario === scenario && other.pair === sample.pair).elapsedMs < sample.elapsedMs).length;
      for (const key of ['factsSha256', 'aggregatesSha256']) assert.equal(new Set(samples.filter(sample => sample.scenario === scenario).map(sample => sample[key])).size, 1);
      return row;
    });
    const workloads = trials[0].samples[0].workloads.map(spec => {
      const row = { name: spec.name, rows: spec.rows, total: spec.total, recent30Requests: spec.recent30Requests };
      for (const variant of variants) row[variant] = stats(trials.filter(trial => trial.samples[0].variant === variant).map(trial => trial.samples[0].workloads.find(other => other.name === spec.name).timingMs.median));
      return row;
    });
    const report = { startedAtSeoul, completedAtSeoul: seoul(), referenceMs: options.referenceMs,
      input: options.real ? 'real' : options.requests ? 'synthetic' : 'fixture', pairs: options.pairs, warmups: options.warmups,
      inventory: snapshot.inventory, expected: snapshot.expected, inputSha256: snapshot.sha256,
      sourceSha256: Object.fromEntries(variants.map(variant => [variant, sources(options[variant])])),
      revisions: Object.fromEntries(variants.map(variant => [variant, execFileSync('git', ['-C', options[variant], 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()])),
      runnerSha256: sha(fs.readFileSync(__filename)), helpersSha256: sha(fs.readFileSync(join(__dirname, 'incremental-refresh.cjs'))),
      environment: { node: process.version, sqlite: trials[0].sqlite, parser: trials[0].parser, cpu: cpus()[0].model, platform: process.platform },
      rawChecks: samples.reduce((n, sample) => n + sample.rawChecks, 0) + trials.length * workloads.length,
      summary, workloads, samples };
    await mkdir(dirname(options.report), { recursive: true }); await writeFile(options.report, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ report: options.report, summary: summary.map(row => ({ scenario: row.scenario, beforeMs: row.before.elapsedMs.median, afterMs: row.after.elapsedMs.median, changePercent: row.changePercent })) }));
  } finally { assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('agent-tracker-rollback-')); await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[2] === '--worker') worker(process.argv[3], process.argv[4], Number(process.argv[5]), process.argv[6]).then(() => process.disconnect(), () => { process.exitCode = 1; process.disconnect(); });
else main().catch(error => { console.error(error.message); process.exitCode = 1; });
