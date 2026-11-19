// 설치 DB의 읽기 전용 사본과 고정 합성 입력에서 도표별 평균 계산 생략 전후를 비교한다.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { cpus, totalmem } = require('node:os');
const { basename, dirname, join, relative, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync, backup } = require('node:sqlite');
const { seedSynthetic, describe, stats } = require('./sql-explain.cjs');

const root = resolve(__dirname, '../..');
const dateSeoul = '2026-11-12';
const timezone = 'Asia/Seoul';
const warmups = 3;
const pairs = 10;
const componentFields = ['avg_input_tokens', 'avg_output_tokens', 'avg_cache_write_input_tokens', 'avg_cache_read_input_tokens'];
const groups = ['day', 'month', 'session', 'project'];
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) =>
  typeof item === 'number' && !Number.isInteger(item) ? Number(item.toPrecision(11)) : item);
const digest = value => sha(canonical(value));
const seoulClock = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: timezone, dateStyle: 'short', timeStyle: 'medium',
}).format(new Date());

function treeFingerprint(directory) {
  const files = fs.readdirSync(directory, { recursive: true }).filter(name => fs.statSync(join(directory, name)).isFile()).sort();
  return { files: files.length, sha256: digest(files.map(name => [name.replaceAll('\\', '/'), sha(fs.readFileSync(join(directory, name)))])) };
}

function freezeProducts(workspace) {
  const products = {};
  for (const label of ['A', 'B']) {
    const directory = join(workspace, label);
    fs.mkdirSync(directory);
    fs.cpSync(join(root, 'src'), join(directory, 'src'), { recursive: true });
    fs.cpSync(join(root, 'localization'), join(directory, 'localization'), { recursive: true });
    fs.symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const config = JSON.parse(fs.readFileSync(join(root, 'tsconfig.json'), 'utf8'));
    config.include = ['src/**/*.ts'];
    fs.writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify(config));
    if (label === 'B') {
      for (const file of ['src/summary/db/queries/raw/usage.ts', 'src/summary/db/queries/rollup/usage.ts']) {
        const path = join(directory, file), source = fs.readFileSync(path, 'utf8');
        const condition = "const includeComponentAverages = filter.chartMetric === undefined || filter.chartMetric === 'averageTokens';";
        assert.equal(source.split(condition).length, 2, 'Exactly one selection condition per SQL builder');
        fs.writeFileSync(path, source.replace(condition, 'const includeComponentAverages = true;'));
      }
    }
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(directory, 'tsconfig.json')], {
      cwd: root, stdio: 'pipe', windowsHide: true,
    });
    products[label] = {
      directory,
      Database: require(join(directory, 'dist/src/summary/db')).SummaryDatabase,
      raw: require(join(directory, 'dist/src/summary/db/queries')),
      rollup: require(join(directory, 'dist/src/summary/db/rollup-queries')),
      source: treeFingerprint(join(directory, 'src')),
      build: treeFingerprint(join(directory, 'dist/src')),
    };
  }
  return products;
}

function readFacts(db) {
  const turns = db.connection.prepare('SELECT * FROM turn_summary ORDER BY id').all();
  const models = db.connection.prepare('SELECT * FROM turn_model_usage ORDER BY turn_id, model').all();
  return { turns, models };
}

function keyFor(row, group, by) {
  return JSON.stringify([row.provider, by === 'model' ? row.model : null,
    ['project', 'session'].includes(group) ? row.project_key : null,
    group === 'session' ? row.session_id : null, ['day', 'month'].includes(group) ? row.period : null]);
}

// 원본 facts를 JS로 집계한다. 제품의 SQL·평균·날짜 함수를 호출하지 않는다.
function independentMeans(facts, group, by) {
  const modelMap = new Map();
  for (const model of facts.models) {
    const items = modelMap.get(model.turn_id) ?? [];
    items.push(model); modelMap.set(model.turn_id, items);
  }
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const expected = new Map();
  for (const turn of facts.turns) {
    let period = null;
    if (turn.started_at_ms !== null && ['day', 'month'].includes(group)) {
      const parts = Object.fromEntries(date.formatToParts(new Date(turn.started_at_ms)).map(part => [part.type, part.value]));
      period = `${parts.year}-${parts.month}${group === 'day' ? `-${parts.day}` : ''}`;
    }
    const models = modelMap.get(turn.id) ?? [];
    const entries = by === 'model' && models.length ? models : [null];
    for (const model of entries) {
      const input = model ? model.input_tokens : turn.input_tokens;
      const output = model ? model.output_tokens : turn.output_tokens;
      const tokens = model ? input + output : turn.total_tokens;
      const modelName = model?.model ?? '';
      const recorded = tokens > 0 || (by === 'model' ? modelName !== '' : models.some(item => item.model !== ''));
      const row = { ...turn, period, model: modelName === '' && tokens === 0 ? null : modelName };
      const key = keyFor(row, group, by);
      const sum = expected.get(key) ?? { turn_count: 0, completed_turns: 0, recorded_turns: 0, recorded_completed_turns: 0,
        input_tokens: 0, output_tokens: 0, total_tokens: 0, samples: 0, sampleTokens: 0,
        sampleInput: 0, sampleOutput: 0, durationSum: 0, turns_with_duration: 0,
        exact_duration_turns: 0, derived_duration_turns: 0, approximate_duration_turns: 0, missing_duration_turns: 0,
        writeSum: 0, readSum: 0, writeKnown: 0, readKnown: 0,
        sampleWrite: 0, sampleRead: 0, sampleWriteKnown: 0, sampleReadKnown: 0 };
      const write = model ? model.cache_write_input_tokens : turn.cache_write_input_tokens;
      const read = model ? model.cache_read_input_tokens : turn.cache_read_input_tokens;
      sum.turn_count++; sum.completed_turns += Number(turn.status === 'completed');
      sum.recorded_turns += Number(recorded);
      sum.recorded_completed_turns += Number(recorded && turn.status === 'completed');
      sum.input_tokens += input; sum.output_tokens += output; sum.total_tokens += tokens;
      sum.writeSum += write ?? 0; sum.readSum += read ?? 0;
      sum.writeKnown += Number(write !== null); sum.readKnown += Number(read !== null);
      if (turn.status === 'completed' && recorded) {
        sum.samples++; sum.sampleTokens += tokens; sum.sampleInput += input; sum.sampleOutput += output;
        sum.sampleWrite += write ?? 0; sum.sampleRead += read ?? 0;
        sum.sampleWriteKnown += Number(write !== null); sum.sampleReadKnown += Number(read !== null);
        if (turn.duration_ms !== null) { sum.durationSum += turn.duration_ms; sum.turns_with_duration++; }
        for (const quality of ['exact', 'derived', 'approximate']) sum[`${quality}_duration_turns`] += Number(turn.duration_quality === quality);
        sum.missing_duration_turns += Number(turn.duration_ms === null);
      }
      expected.set(key, sum);
    }
  }
  return new Map([...expected].map(([key, sum]) => [key, {
    ...Object.fromEntries(['turn_count', 'completed_turns', 'recorded_turns', 'recorded_completed_turns',
      'input_tokens', 'output_tokens', 'total_tokens', 'turns_with_duration', 'exact_duration_turns',
      'derived_duration_turns', 'approximate_duration_turns', 'missing_duration_turns'].map(field => [field, sum[field]])),
    cache_write_input_tokens: sum.writeKnown === sum.turn_count ? sum.writeSum : null,
    cache_read_input_tokens: sum.readKnown === sum.turn_count ? sum.readSum : null,
    avg_tokens_per_turn: sum.samples ? sum.sampleTokens / sum.samples : null,
    avg_input_tokens: sum.samples ? sum.sampleInput / sum.samples : null,
    avg_output_tokens: sum.samples ? sum.sampleOutput / sum.samples : null,
    avg_cache_write_input_tokens: sum.samples && sum.sampleWriteKnown === sum.samples ? sum.sampleWrite / sum.samples : null,
    avg_cache_read_input_tokens: sum.samples && sum.sampleReadKnown === sum.samples ? sum.sampleRead / sum.samples : null,
    avg_duration_ms: sum.turns_with_duration ? sum.durationSum / sum.turns_with_duration : null,
  }]));
}

function allRows(db, spec) {
  const rows = []; let total;
  do {
    const page = db.queryUsagePage(spec.filter, spec.group, timezone, { limit: 1000, offset: rows.length, tableSort: spec.sort }, spec.by);
    total ??= page.total; assert.equal(page.total, total);
    assert.ok(page.rows.length || rows.length === total, 'Pagination advances');
    rows.push(...page.rows);
  } while (rows.length < total);
  assert.equal(rows.length, total);
  return rows;
}

function validateRows(rows, expected, spec, optimized) {
  assert.equal(rows.length, expected.size, 'Independent group count');
  for (const row of rows) {
    const wanted = expected.get(keyFor(row, spec.group, spec.by));
    assert.ok(wanted, 'Independent group identity');
    for (const [field, value] of Object.entries(wanted)) {
      if (optimized && spec.metric !== 'averageTokens' && componentFields.includes(field)) {
        assert.equal(row[field], null, `Unused ${field}`);
      } else if (value === null) assert.equal(row[field], null, `Independent ${field}`);
      else assert.ok(Math.abs(row[field] - value) <= 1e-9 * Math.max(1, Math.abs(value)), `Independent ${field}`);
    }
  }
}

function sharedRows(rows, metric) {
  return rows.map(row => Object.fromEntries(Object.entries(row)
    .filter(([field]) => metric === 'averageTokens' || !componentFields.includes(field))));
}

function queryDiagnostic(product, db, spec) {
  const query = product.rollup.buildRollupUsageQueries(spec.filter, spec.group, timezone, spec.by, undefined, spec.sort, true);
  const selected = query?.rows ?? product.raw.buildUsageQuery(spec.filter, spec.group, timezone, spec.by, undefined, spec.sort, true);
  const values = [...selected.values, 100, 0];
  const bytecode = db.connection.prepare(`EXPLAIN ${selected.sql}`).all(...values);
  return { mode: query?.mode ?? 'raw', sqlSha256: sha(selected.sql), instructions: bytecode.length,
    aggregateSteps: bytecode.filter(row => row.opcode === 'AggStep').map(row => row.p4),
    queryPlan: db.connection.prepare(`EXPLAIN QUERY PLAN ${selected.sql}`).all(...values).map(row => row.detail) };
}

function readCases() {
  const result = [];
  for (const group of groups) for (const by of ['provider', 'model']) for (const includeCosts of [false, true]) {
    for (const metric of ['tokens', 'averageTokens']) {
      result.push({ name: `${group}/${by}/${includeCosts ? 'raw-costs' : 'rollup'}/${metric}`,
        group, by, metric, sort: { key: 'period', direction: 'desc' },
        filter: { providers: ['claude', 'codex'], excludeEmptyUsage: true, includeCosts, chartMetric: metric } });
    }
  }
  return result;
}

function measureReads(products, dbs, facts) {
  const results = [];
  const expected = new Map();
  for (const spec of readCases()) {
    const oracleKey = `${spec.group}/${spec.by}`;
    if (!expected.has(oracleKey)) expected.set(oracleKey, independentMeans(facts, spec.group, spec.by));
    const full = Object.fromEntries(['A', 'B'].map(label => [label, allRows(dbs[label], spec)]));
    for (const label of ['A', 'B']) validateRows(full[label], expected.get(oracleKey), spec, label === 'A');
    assert.equal(digest(sharedRows(full.A, spec.metric)), digest(sharedRows(full.B, spec.metric)), 'All shared output fields agree');
    const diagnostics = Object.fromEntries(['A', 'B'].map(label => [label, queryDiagnostic(products[label], dbs[label], spec)]));
    if (spec.metric === 'averageTokens') assert.equal(diagnostics.A.sqlSha256, diagnostics.B.sqlSha256, 'Control SQL is identical');
    const invoke = label => dbs[label].queryUsagePage(spec.filter, spec.group, timezone, { limit: 100, offset: 0, tableSort: spec.sort }, spec.by);
    const pilot = ['A', 'B'].map(label => { const start = performance.now(); invoke(label); return performance.now() - start; });
    const iterations = Math.min(25, Math.max(1, Math.ceil(12 / Math.max(...pilot, 0.05))));
    const samples = { A: [], B: [] };
    for (let pair = -warmups; pair < pairs; pair++) {
      for (const label of Math.abs(pair) % 2 ? ['B', 'A'] : ['A', 'B']) {
        const start = performance.now();
        for (let repeat = 0; repeat < iterations; repeat++) invoke(label);
        const elapsed = (performance.now() - start) / iterations;
        if (pair >= 0) samples[label].push(elapsed);
      }
    }
    const A = stats(samples.A), B = stats(samples.B);
    results.push({ name: spec.name, group: spec.group, by: spec.by, metric: spec.metric,
      includeCosts: spec.filter.includeCosts, groups: full.A.length, pageRows: Math.min(100, full.A.length),
      iterationsPerSample: iterations, A, B, improvementPercent: (B.medianMs - A.medianMs) / B.medianMs * 100,
      fasterPairs: samples.A.filter((value, index) => value < samples.B[index]).length,
      sharedResultSha256: digest(sharedRows(full.A, spec.metric)), oraclePassed: true, diagnostics });
  }
  return results;
}

function additionalRequest() {
  return { provider: 'codex', project_key: '/fixture/chart-metric-extra', project_name: 'Benchmark',
    session_id: 'chart-metric-extra', session_name: 'Benchmark', root_turn_id: 'chart-metric-extra',
    started_at_ms: Date.parse('2026-11-12T00:00:00Z'), completed_at_ms: Date.parse('2026-11-12T00:00:01Z'),
    duration_ms: 1000, duration_quality: 'exact', status: 'completed', input_tokens: 100, output_tokens: 30,
    cache_write_input_tokens: 10, cache_read_input_tokens: 20, total_tokens: 130,
    updated_at: '2026-11-12T00:00:01.000Z',
    model_usage: [{ model: 'benchmark-model', input_tokens: 100, output_tokens: 30, cache_write_input_tokens: 10, cache_read_input_tokens: 20 }] };
}

function measureAddition(products, base, directory, initial) {
  const samples = { A: [], B: [] }; let accepted;
  const postAdditionHashes = new Map();
  for (let pair = -warmups; pair < pairs; pair++) {
    for (const label of Math.abs(pair) % 2 ? ['B', 'A'] : ['A', 'B']) {
      const path = join(directory, `addition-${pair + warmups}-${label}.sqlite`);
      fs.copyFileSync(base, path);
      const db = new products[label].Database(path);
      try {
        const row = additionalRequest();
        const replacement = { scanId: 'chart-metric-benchmark', sessions: [{ provider: row.provider, session_id: row.session_id }],
          files: [], summaries: [row] };
        const start = performance.now(); db.replaceMemory(replacement);
        const elapsed = performance.now() - start;
        if (pair >= 0) samples[label].push(elapsed);
        const facts = readFacts(db);
        assert.equal(facts.turns.length, initial.turns.length + 1);
        assert.equal(facts.turns.reduce((sum, turn) => sum + turn.total_tokens, 0), initial.turns.reduce((sum, turn) => sum + turn.total_tokens, 0) + 130);
        const output = digest(facts);
        accepted ??= output; assert.equal(output, accepted, 'Added requests and model facts agree across restored trials');
        if (pair === -warmups) {
          for (const spec of readCases().filter(item => item.metric === 'averageTokens')) {
            const rows = allRows(db, spec);
            validateRows(rows, independentMeans(facts, spec.group, spec.by), spec, label === 'A');
            const result = digest(rows);
            if (postAdditionHashes.has(spec.name)) assert.equal(result, postAdditionHashes.get(spec.name), 'Post-addition aggregates agree');
            else postAdditionHashes.set(spec.name, result);
          }
        }
        assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
        assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      } finally { db.close(); }
    }
  }
  const A = stats(samples.A), B = stats(samples.B);
  return { A, B, improvementPercent: (B.medianMs - A.medianMs) / B.medianMs * 100,
    resultSha256: accepted, postAdditionOraclePassed: true,
    postAdditionGroupHashes: Object.fromEntries(postAdditionHashes),
    restoredTrials: (pairs + warmups) * 2, addedRequests: 1, addedTokens: 130 };
}

async function main() {
  const outputArg = process.argv.slice(2).find(arg => arg.startsWith('--output='));
  assert.equal(process.argv.length, outputArg ? 3 : 2, 'Only --output is supported');
  const output = outputArg ? resolve(outputArg.slice(9)) : join(root, `docs/benchmarks/${dateSeoul}/ChartMetricAB-${dateSeoul}.json`);
  assert.equal(fs.existsSync(output), false, 'Keep earlier raw results');
  const cache = join(root, 'tests/.cache'); fs.mkdirSync(cache, { recursive: true });
  const workspace = fs.mkdtempSync(join(cache, 'chart-metric-ab-'));
  const products = freezeProducts(workspace);
  const report = { experiment: 'chart-metric-component-averages', dateSeoul, startedAtSeoul: seoulClock(),
    hypothesis: 'Omitting four unused component averages reduces aggregate work while retaining table metrics.',
    variants: { A: 'Current working tree: selected chart controls component averages', B: 'Same snapshot: always calculate component averages' },
    presentation: 'Report improvement is B (before) to A (current). A is the optimized working-tree baseline.',
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
      logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
    scope: { warmupPairs: warmups, measuredPairs: pairs, pageSize: 100, timezone,
      period: 'All stored dates in a frozen snapshot; unknown dates included for every grouping.',
      timing: 'Public DB page API, including SQL preparation, execution and first-page materialization; warm rollups and cache.',
      control: 'averageTokens SQL is identical; tokens also represents requests and averageDuration SQL.',
      addition: 'One normalized request through replaceMemory, including active rollup update and COMMIT; source parsing excluded.',
      privacy: 'Only hashes, counts, timings and SQL plans are exported; snapshot contents stay in ignored cache.' },
    command: ['node', 'tests/benchmarks/chart-metric-ab.cjs', ...process.argv.slice(2)],
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    runnerSha256: sha(fs.readFileSync(__filename)), seedHelperSha256: sha(fs.readFileSync(join(__dirname, 'sql-explain.cjs'))),
    products: Object.fromEntries(Object.entries(products).map(([label, product]) => [label, { source: product.source, build: product.build }])),
    datasets: [] };
  for (const size of ['current', 10000, 100]) {
    const name = typeof size === 'number' ? `synthetic-${size}` : size;
    const directory = join(workspace, name); fs.mkdirSync(directory);
    const base = join(directory, 'snapshot.sqlite');
    if (size === 'current') {
      assert.ok(process.env.APPDATA, 'APPDATA identifies the installed VS Code statistics DB');
      const installed = join(process.env.APPDATA, 'Code/User/globalStorage/agenttracker.agent-tracker/agent-tracker.sqlite');
      const source = new DatabaseSync(installed, { readOnly: true });
      try { await backup(source, base); } finally { source.close(); }
    }
    const seedDb = new products.A.Database(base);
    let inventory, facts;
    try {
      if (typeof size === 'number') seedSynthetic(seedDb, size);
      seedDb.queryUsagePage({}, 'day', timezone);
      facts = readFacts(seedDb); inventory = describe(seedDb);
      report.environment.sqlite ??= seedDb.connection.prepare('SELECT sqlite_version() AS version').get().version;
    } finally { seedDb.close(); }
    assert.ok(facts.turns.length > 0);
    const baseSha256 = sha(fs.readFileSync(base));
    const dbs = {};
    for (const label of ['A', 'B']) {
      const path = join(directory, `${label}.sqlite`); fs.copyFileSync(base, path);
      dbs[label] = new products[label].Database(path);
    }
    let reads;
    try { reads = measureReads(products, dbs, facts); }
    finally { for (const db of Object.values(dbs)) db.close(); }
    const addition = measureAddition(products, base, directory, facts);
    assert.equal(sha(fs.readFileSync(base)), baseSha256, 'Frozen snapshot restored and unchanged');
    report.datasets.push({ name, inventory, inputSha256: digest(facts), snapshotSha256: baseSha256,
      distribution: typeof size === 'number' ? 'Deterministic sql-explain fixture: 10 requests/session, up to 20 projects, 90 calendar days from 2026-07-01; mixed status, missing times, zero usage and multiple models.' : 'Consistent read-only backup of the installed statistics DB.',
      reads, addition });
    console.log(`${name}: ${facts.turns.length} requests, ${reads.length} paired workloads, all output/oracle checks passed.`);
  }
  report.finishedAtSeoul = seoulClock();
  fs.mkdirSync(dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Raw results: ${relative(root, output)}`);
  console.log(`Private snapshots: ${basename(workspace)}`);
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
