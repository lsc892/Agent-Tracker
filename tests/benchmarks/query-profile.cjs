// 현재 공개 조회 API의 SQL을 실제 DB 사본과 합성 데이터에서 실행해 병목을 찾는다.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { cpus, tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync, backup } = require('node:sqlite');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const raw = require('../../dist/src/summary/db/queries');
const { buildRollupUsageQueries } = require('../../dist/src/summary/db/rollup-queries');
const { periodBounds } = require('../../dist/src/summary/db/timezone');
const { seedSynthetic } = require('./sql-explain.cjs');
const { querySourceFiles } = require('./query-source-files.cjs');

const root = resolve(__dirname, '../..');
const timezone = 'Asia/Seoul';
const DAY = 86400000;
const samples = 9;
const requestsWithoutCostsOnly = process.argv.includes('--requests-without-costs');
const hash = value => createHash('sha256').update(value).digest('hex');
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0],
    maxMs: sorted.at(-1), samplesMs: values };
};

function addSyntheticDetails(db) {
  db.transaction(() => db.connection.exec(`
    INSERT INTO turn_costs
      SELECT id,'api',total_tokens * 0.000001,0,'query-profile' FROM turn_summary;
    INSERT INTO turn_capability_usage
      SELECT id,CASE id%4 WHEN 0 THEN 'skill' WHEN 1 THEN 'subagent' WHEN 2 THEN 'plugin' ELSE 'model' END,
        'fixture-capability-' || (id%31),1 + id%3 FROM turn_summary WHERE id%7=0;
    INSERT INTO manifest(provider,source_root,path,session_id,processing_status,recorded_at)
      SELECT provider,'/fixture','/fixture/' || session_id,session_id,'done','2026-10-31T00:00:00Z' FROM sessions;
  `));
}

function usageSpec(db, name, filter, group, by, sort = { key: 'period', direction: 'desc' }, offset = 0) {
  const query = buildRollupUsageQueries(filter, group, timezone, by, undefined, sort) ?? {
    mode: 'raw', rows: raw.buildUsageQuery(filter, group, timezone, by, undefined, sort),
    count: raw.buildUsageCountQuery(filter, group, timezone, by),
  };
  return { name, mode: query.mode, filter, group, by, sort, offset,
    parts: [
      { role: 'rows', ...query.rows, args: [...query.rows.values, 100, offset], method: 'all' },
      { role: 'count', ...query.count, args: query.count.values, method: 'get' },
    ], invoke: () => db.queryUsagePage(filter, group, timezone, { limit: 100, offset, tableSort: sort }, by) };
}

function workloads(db) {
  const c = db.connection;
  const latest = c.prepare('SELECT max(started_at_ms) n FROM turn_summary').get().n;
  assert.ok(latest !== null);
  const end = periodBounds(new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(latest), timezone).toMs;
  const base = { providers: ['claude', 'codex'], excludeEmptyUsage: true };
  const month = { ...base, fromMs: end - 30 * DAY, toMs: end, unknownTime: 'exclude' };
  const project = c.prepare('SELECT provider,project_key,count(*) n FROM turn_summary GROUP BY provider,project_key ORDER BY n DESC,provider,project_key LIMIT 1').get();
  const session = c.prepare('SELECT provider,session_id,count(*) n FROM turn_summary GROUP BY provider,session_id ORDER BY n DESC,provider,session_id LIMIT 1').get();
  const result = [];
  for (const costs of [false, true]) for (const by of ['provider', 'model']) {
    const filter = { ...base, includeCosts: costs };
    for (const group of ['total', 'day', 'month', 'project', 'session']) {
      result.push(usageSpec(db, `${group}-${by}-${costs ? 'costs' : 'tokens'}`, filter, group, by));
    }
    for (const group of ['day', 'month']) {
      result.push(usageSpec(db, `recent30-${group}-${by}-${costs ? 'costs' : 'tokens'}`, { ...month, includeCosts: costs }, group, by));
    }
  }
  for (const by of ['provider', 'model']) {
    result.push(usageSpec(db, `partial30-day-${by}`, { ...month, fromMs: month.fromMs + 12 * 3600000, toMs: end - 3600000 }, 'day', by));
    result.push(usageSpec(db, `project30-month-${by}`, { ...month, provider: project.provider, projectKey: project.project_key }, 'month', by));
    result.push(usageSpec(db, `one-session-${by}`, { ...base, provider: session.provider, sessionId: session.session_id }, 'session', by));
    for (const costs of [false, true]) for (const key of ['period', 'tokens', 'model']) {
      const filter = { ...base, includeCosts: costs };
      const sort = { key, direction: 'desc' };
      const rows = raw.buildTurnsQuery(raw.buildQueryFilter(filter), costs, by, true, sort);
      const count = raw.buildTurnsCountQuery(filter, by);
      result.push({ name: `turns-${by}-sort-${key}${costs ? '' : '-no-costs'}`, mode: 'raw', parts: [
        { role: 'rows', ...rows, args: [...rows.values, 0, 100, 0], method: 'all' },
        { role: 'count', ...count, args: count.values, method: 'get' },
      ], invoke: () => db.queryUsagePage(filter, 'turn', timezone, { limit: 100, tableSort: sort }, by) });
    }
  }
  for (const kind of ['project', 'session']) {
    const query = { kind, providers: base.providers, limit: 100, offset: 0 };
    const names = raw.buildNameQueries(query);
    result.push({ name: `names-${kind}`, mode: 'raw', parts: [
      { role: 'rows', ...names.rows, args: [...names.rows.values, 100, 0], method: 'all' },
      { role: 'count', ...names.count, args: names.count.values, method: 'get' },
    ], invoke: () => db.queryNames(query) });
  }
  for (const category of ['skill', 'subagent', 'plugin', 'model']) {
    const q = raw.buildCapabilityQueries(base, category);
    result.push({ name: `capabilities-${category}`, mode: 'raw', parts: [
      { role: 'rows', ...q.ranking, args: [...q.ranking.values, 100, 0], method: 'all' },
      { role: 'count', ...q.counts, args: q.counts.values, method: 'get' },
    ], invoke: () => db.queryCapabilities(base, category) });
  }
  const diagnostics = raw.buildDiagnosticQueries({ providers: base.providers });
  result.push({ name: 'diagnostics-coverage', mode: 'raw', parts: Object.entries(diagnostics).map(([role, q]) => ({
    role, ...q, args: [...q.values, ...(role === 'counts' ? [] : [0, 1, 0])], method: role === 'counts' ? 'get' : 'all',
  })), invoke: () => db.diagnostics({ limit: 1, providers: base.providers }) });
  return result;
}

function measureParts(c, spec) {
  const statements = spec.parts.map(p => c.prepare(p.sql));
  const execute = () => {
    const times = [], signature = [];
    for (const [i, part] of spec.parts.entries()) {
      const start = performance.now();
      const value = statements[i][part.method](...part.args);
      times.push(performance.now() - start);
      signature.push(value);
    }
    return { times, signature };
  };
  const first = execute();
  const expectedHash = hash(JSON.stringify(first.signature));
  execute(); execute();
  const iterations = Math.min(30, Math.max(1, Math.ceil(6 / Math.max(first.times.reduce((a, b) => a + b, 0), .01))));
  const partSamples = spec.parts.map(() => []), bundleSamples = [];
  for (let round = 0; round < samples; round++) {
    const totals = spec.parts.map(() => 0);
    for (let n = 0; n < iterations; n++) {
      const value = execute();
      value.times.forEach((ms, i) => { totals[i] += ms; });
    }
    totals.forEach((ms, i) => partSamples[i].push(ms / iterations));
    bundleSamples.push(totals.reduce((a, b) => a + b, 0) / iterations);
  }
  assert.equal(hash(JSON.stringify(execute().signature)), expectedHash, 'Query output changed during measurements');
  return { name: spec.name, mode: spec.mode, resultSha256: expectedHash, iterationsPerSample: iterations,
    bundle: summary(bundleSamples), parts: spec.parts.map((p, i) => ({ role: p.role, method: p.method,
      sql: p.sql, parameters: p.args.map(v => typeof v === 'string' && ![timezone, 'claude', 'codex', 'skill', 'subagent', 'plugin', 'model'].includes(v) ? '<selected-key>' : v),
      timing: summary(partSamples[i]), returnedRows: Array.isArray(first.signature[i]) ? first.signature[i].length : 1,
      plan: c.prepare(`EXPLAIN QUERY PLAN ${p.sql}`).all(...p.args).map(r => r.detail) })) };
}

async function profile(db, label) {
  const c = db.connection;
  const getCount = table => c.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  const beforeMeta = c.prepare('SELECT timezone,format_version FROM usage_rollup_meta').get() ?? null;
  const firstStart = performance.now();
  db.queryUsagePage({ providers: ['claude', 'codex'], excludeEmptyUsage: true }, 'day', timezone,
    { limit: 100, tableSort: { key: 'period', direction: 'desc' } }, 'provider');
  const firstReadMs = performance.now() - firstStart;
  const data = { label, requests: getCount('turn_summary'), modelRows: getCount('turn_model_usage'),
    sessions: getCount('sessions'), projects: getCount('projects'), sourceFiles: getCount('manifest'),
    capabilityRows: getCount('turn_capability_usage'), costRows: getCount('turn_costs'),
    requestDailyRows: getCount('usage_request_daily'), modelDailyRows: getCount('usage_model_daily'),
    rollupMetaBeforeFirstRead: beforeMeta, firstReadMs, firstReadIncludesRollupBuild: beforeMeta?.timezone !== timezone || beforeMeta?.format_version !== 1,
    queries: [], apiChecks: [] };
  const specs = workloads(db).filter(spec => !requestsWithoutCostsOnly || spec.name.endsWith('-no-costs'));
  for (const spec of specs) {
    const measured = measureParts(c, spec);
    data.queries.push(measured);
    console.log(`${label} ${spec.name}: ${measured.bundle.medianMs.toFixed(3)} ms`);
    await new Promise(resolve => setImmediate(resolve));
  }
  const ordered = [...data.queries].sort((a, b) => b.bundle.medianMs - a.bundle.medianMs);
  for (const item of ordered.slice(0, 5)) {
    const spec = specs.find(s => s.name === item.name);
    spec.invoke();
    const values = [];
    for (let n = 0; n < samples; n++) {
      const start = performance.now();
      spec.invoke();
      values.push(performance.now() - start);
    }
    data.apiChecks.push({ name: item.name, timing: summary(values) });
  }
  // Worker가 토큰 응답마다 추가하는 진단 페이지 비용을 개별 SQL과 구분해 기록한다.
  const coverage = [];
  for (let n = 0; n < samples; n++) {
    const start = performance.now();
    db.diagnostics({ limit: 1, providers: ['claude', 'codex'] });
    coverage.push(performance.now() - start);
  }
  data.coverageApi = summary(coverage);
  console.log(`${label} SLOWEST: ${ordered[0].name}, ${ordered[0].bundle.medianMs.toFixed(3)} ms; first read ${firstReadMs.toFixed(3)} ms`);
  return data;
}

async function main() {
  const output = resolve(process.argv[2] ?? 'tests/results/benchmarks/query-profile.json');
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-query-profile-'));
  const report = { createdAtSeoul: new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date()),
    environment: { node: process.version, cpu: cpus()[0]?.model, platform: process.platform, sqlite: null,
      sourceSha256: Object.fromEntries([...querySourceFiles({ compiled: true }), 'src/summary/db/reader.ts',
        'src/summary/db/schema.ts', 'src/summary/db/rollup-state.ts', 'tests/benchmarks/query-profile.cjs',
      ].map(path => [path, hash(readFileSync(join(root, path)))])) },
    method: { samples, warmup: 2, limit: 100, offset: 0, timezone, cacheKiB: 4096, tempStore: 'FILE',
      timing: 'Prepared SQL execution and JS row materialization; separate full public API validation for five slowest pages. Warm cache, no OS cache reset.',
      statistics: 'Product constructor optimize only; no forced ANALYZE.',
      scope: requestsWithoutCostsOnly ? 'Supplement: request detail SQL without costs (provider/model; period/tokens/model sorts).'
        : 'Read SQL for usage (costs on/off), requests (costs on/off, three sorts), names, capabilities, diagnostics. No ingestion/write benchmark, network calls, worker IPC or webview rendering.',
      synthetic: 'Existing deterministic SQL fixture: 10 requests/session, 20 projects, 90-day spread; add cost, capability and manifest rows. Not a parsing benchmark.' }, datasets: [] };
  try {
    const installed = join(process.env.APPDATA, 'Code/User/globalStorage/agenttracker.agent-tracker/agent-tracker.sqlite');
    const source = new DatabaseSync(installed, { readOnly: true });
    try {
      source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
      await backup(source, join(directory, 'installed-snapshot.sqlite'));
    } finally { source.close(); }
    const local = new SummaryDatabase(join(directory, 'installed-snapshot.sqlite'));
    try {
      report.environment.sqlite = local.connection.prepare('SELECT sqlite_version() v').get().v;
      report.datasets.push(await profile(local, 'installed-snapshot'));
    } finally { local.close(); }
    for (const size of [10000, 100000]) {
      const db = new SummaryDatabase(join(directory, `synthetic-${size}.sqlite`));
      try {
        seedSynthetic(db, size); addSyntheticDetails(db); db.optimize();
        report.datasets.push(await profile(db, `synthetic-${size}`));
      } finally { db.close(); }
    }
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Saved ${output}`);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('agent-tracker-query-profile-'));
    await rm(directory, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
