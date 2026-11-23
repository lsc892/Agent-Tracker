// 설치 DB 스냅샷에서 실제 조회 SQL의 인덱스 제거 전후 시간과 계획을 비교한다.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { join, relative, resolve, sep } = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

const [output, input, build = 'dist'] = process.argv.slice(2);
assert.ok(output && input, 'Usage: node index-removal-explain.cjs <report.json> <input.sqlite> [build-dir]');
assert.ok(!fs.existsSync(output), 'Use a new report path');
const dbModule = resolve(build, 'src/summary/db');
const { SummaryDatabase } = require(dbModule);
const { periodBounds } = require(join(dbModule, 'timezone'));
const timezone = 'Asia/Seoul';
const rounds = 9;
const warmups = 2;
const hash = value => createHash('sha256').update(value).digest('hex');
const shaFile = file => hash(fs.readFileSync(file));
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const normalize = (_key, value) => {
  if (typeof value === 'number' && !Number.isInteger(value)) return Number(value.toPrecision(11));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  }
  return value;
};
const digest = value => hash(JSON.stringify(value, normalize) ?? 'undefined');

function scopes(c) {
  const select = columns => c.prepare(`SELECT ${columns}, count(*) n
    FROM turn_summary GROUP BY 1,2 ORDER BY n DESC, 1, 2 LIMIT 1`).get();
  const project = select('provider,project_key');
  const session = select('provider,session_id');
  const provider = project.provider;
  const projectKey = project.project_key;
  const sessionId = session.session_id;
  const day = c.prepare(`SELECT agent_tracker_period(started_at_ms, ?, 'day') day, count(*) n
    FROM turn_summary WHERE provider=? AND project_key=? AND started_at_ms IS NOT NULL
    GROUP BY 1 ORDER BY n DESC, day DESC LIMIT 1`).get(timezone, provider, projectKey);
  const month = day.day.slice(0, 7);
  const dayBounds = periodBounds(day.day, timezone);
  const monthBounds = periodBounds(month, timezone);
  const dayFilter = { ...dayBounds, unknownTime: 'exclude' };
  const projectMonth = { ...monthBounds, provider, projectKey, unknownTime: 'exclude' };
  const projectDay = { ...dayFilter, provider, projectKey };
  const sessionScope = { provider: session.provider, sessionId };
  const partialMonth = { ...projectMonth, fromMs: monthBounds.fromMs + 12 * 3600000, toMs: monthBounds.toMs - 12 * 3600000 };
  const count = ({ provider: p, projectKey: k, fromMs, toMs }) => c.prepare(`SELECT count(*) n
    FROM turn_summary WHERE (? IS NULL OR provider=?) AND (? IS NULL OR project_key=?)
      AND started_at_ms>=? AND started_at_ms<?`).get(p ?? null, p ?? null, k ?? null, k ?? null, fromMs, toMs).n;
  return {
    dayFilter, projectDay, projectMonth, partialMonth, sessionScope,
    redact: value => value === projectKey ? '<selected-project>' : value === sessionId ? '<selected-session>' : value,
    details: { day: day.day, month, projectProvider: provider, sessionProvider: session.provider,
      allDayTurns: count(dayFilter), projectDayTurns: day.n, projectMonthTurns: count(projectMonth),
      projectPartialMonthTurns: count(partialMonth), selectedProjectTurns: project.n, selectedSessionTurns: session.n },
  };
}

function workloads(db, filters) {
  const result = [];
  const add = (name, invoke) => result.push({ name, invoke });
  const page = { limit: 100, offset: 0 };
  const usage = (label, filter, group, by, key = 'period') => add(label, () =>
    db.queryUsagePage(filter, group, timezone, { ...page, tableSort: { key, direction: 'desc' } }, by));
  for (const by of ['provider', 'model']) {
    for (const group of ['total', 'day', 'month', 'project', 'session', 'turn']) {
      usage(`all/${group}/${by}`, {}, group, by);
      usage(`all/${group}/${by}/costs`, { includeCosts: true }, group, by);
    }
    usage(`all/turn/${by}/token-sort`, {}, 'turn', by, 'tokens');
    usage(`all/turn/${by}/model-sort`, {}, 'turn', by, 'model');
    usage(`all/turn/${by}/cost-sort`, { includeCosts: true }, 'turn', by, 'cost');
    usage(`one-day/day/${by}`, filters.dayFilter, 'day', by);
    usage(`one-day/turn/${by}`, filters.dayFilter, 'turn', by);
    usage(`one-day/turn/${by}/costs`, { ...filters.dayFilter, includeCosts: true }, 'turn', by);
    usage(`project-day/day/${by}`, filters.projectDay, 'day', by);
    usage(`project-day/turn/${by}`, filters.projectDay, 'turn', by);
    usage(`project-month/month/${by}`, filters.projectMonth, 'month', by);
    usage(`project-month/session/${by}`, filters.projectMonth, 'session', by);
    usage(`project-month/turn/${by}/costs`, { ...filters.projectMonth, includeCosts: true }, 'turn', by);
    usage(`project-partial-month/month/${by}`, filters.partialMonth, 'month', by);
    usage(`one-session/turn/${by}/costs`, { ...filters.sessionScope, includeCosts: true }, 'turn', by);
  }
  for (const kind of ['project', 'session']) add(`names/${kind}`, () => db.queryNames({ kind, ...page }));
  for (const category of ['skill', 'subagent', 'plugin', 'model']) {
    add(`capability/all/${category}`, () => db.queryCapabilities({}, category, 0, page.limit));
    add(`capability/one-day/${category}`, () => db.queryCapabilities(filters.dayFilter, category, 0, page.limit));
  }
  add('diagnostics/page', () => db.diagnostics(page));
  add('diagnostics/counts', () => db.diagnosticCounts());
  add('billing/one-session', () => db.sessionBilling(filters.sessionScope.provider, filters.sessionScope.sessionId));
  return result;
}

function observe(connection) {
  const prepare = connection.prepare.bind(connection);
  let active;
  connection.prepare = (sql, ...options) => {
    const stmt = prepare(sql, ...options);
    for (const method of ['all', 'get']) {
      const original = stmt[method].bind(stmt);
      stmt[method] = (...args) => {
        active?.push({ sql, method, args });
        return original(...args);
      };
    }
    return stmt;
  };
  return {
    prepare,
    capture(invoke) {
      active = [];
      try { return { result: invoke(), queries: active }; }
      finally { active = undefined; }
    },
  };
}

function percentile(sorted, fraction) {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

function measure(a, b, ordinal, maxBatch) {
  const one = performance.now();
  a(); b();
  const perCall = (performance.now() - one) / 2;
  const batch = Math.min(maxBatch, Math.max(2, Math.ceil(4 / Math.max(perCall, 0.001))));
  const elapsed = fn => {
    const start = performance.now();
    for (let i = 0; i < batch; i++) fn();
    return (performance.now() - start) / batch;
  };
  for (let i = 0; i < warmups; i++) { elapsed(a); elapsed(b); }
  const samples = { A: [], B: [], order: [] };
  for (let i = 0; i < rounds; i++) {
    const ab = (i + ordinal) % 2 === 0;
    samples.order.push(ab ? 'AB' : 'BA');
    if (ab) { samples.A.push(elapsed(a)); samples.B.push(elapsed(b)); }
    else { samples.B.push(elapsed(b)); samples.A.push(elapsed(a)); }
  }
  const stats = values => {
    const sorted = [...values].sort((x, y) => x - y);
    return { median: percentile(sorted, 0.5), p10: percentile(sorted, 0.1), p90: percentile(sorted, 0.9) };
  };
  const differences = samples.B.map((time, i) => time - samples.A[i]);
  return { batch, samples, A: stats(samples.A), B: stats(samples.B), pairedDelta: stats(differences),
    slowerPairs: differences.filter(value => value > 0).length };
}

function schema(c) {
  return c.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_stat%' ORDER BY name`).all();
}

function inventory(c) {
  const pragma = key => Object.values(c.prepare('PRAGMA ' + key).get())[0];
  const settings = Object.fromEntries(['user_version', 'journal_mode', 'synchronous', 'page_size',
    'page_count', 'freelist_count', 'cache_size', 'temp_store', 'mmap_size', 'foreign_keys', 'automatic_index']
    .map(key => [key, pragma(key)]));
  const rows = Object.fromEntries(schema(c).filter(row => row.type === 'table')
    .map(({ name }) => [name, c.prepare('SELECT count(*) n FROM ' + quote(name)).get().n]));
  const options = c.prepare('PRAGMA compile_options').all().map(row => row.compile_options);
  const pages = options.includes('ENABLE_DBSTAT_VTAB')
    ? c.prepare('SELECT name,sum(pgsize) allocated FROM dbstat GROUP BY name ORDER BY name').all() : null;
  return { settings, rows, pages };
}

async function main() {
  const scratch = fs.mkdtempSync(join(os.tmpdir(), 'agent-tracker-index-removal-'));
  const baselinePath = join(scratch, 'A.sqlite'), candidatePath = join(scratch, 'B.sqlite');
  let a, b;
  try {
    const source = new DatabaseSync(resolve(input), { readOnly: true });
    const inputVersion = source.prepare('PRAGMA user_version').get().user_version;
    try { source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000'); await backup(source, baselinePath); }
    finally { source.close(); }
    const inputSha256 = shaFile(baselinePath);
    fs.copyFileSync(baselinePath, candidatePath);
    a = new SummaryDatabase(baselinePath);
    b = new SummaryDatabase(candidatePath);
    const variants = [a.connection, b.connection];
    const original = schema(variants[0]);
    const removed = original.filter(row => row.type === 'index' && row.sql !== null);
    assert.ok(removed.length > 0);
    const dropSql = removed.map(({ name }) => 'DROP INDEX ' + quote(name));
    for (const sql of dropSql) variants[1].exec(sql);
    assert.deepEqual(schema(variants[1]), original.filter(row => !removed.includes(row)));
    for (const c of variants) {
      c.exec('ANALYZE; PRAGMA query_only=ON');
      assert.equal(c.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(c.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(c.prepare('SELECT timezone FROM usage_rollup_meta WHERE singleton=1').get().timezone, timezone);
    }
    const filters = scopes(variants[0]);
    const observers = variants.map(observe);
    const workloadsA = workloads(a, filters), workloadsB = workloads(b, filters);
    const sqls = new Map();
    const api = workloadsA.map(({ name, invoke }, i) => {
      const candidate = workloadsB[i];
      assert.equal(candidate.name, name);
      const controlTrace = observers[0].capture(invoke);
      const candidateTrace = observers[1].capture(candidate.invoke);
      assert.deepEqual(controlTrace.queries, candidateTrace.queries, name);
      const resultSha256 = digest(controlTrace.result);
      assert.equal(digest(candidateTrace.result), resultSha256, name);
      for (const item of controlTrace.queries) {
        const key = JSON.stringify(item);
        if (!sqls.has(key)) sqls.set(key, { ...item, workloads: new Set() });
        sqls.get(key).workloads.add(name);
      }
      return { name, resultSha256, invoke, candidate: candidate.invoke };
    });
    const statements = [...sqls.values()].map((item, i) => {
      const prepared = observers.map(observer => observer.prepare(item.sql));
      const invoke = prepared.map(stmt => () => stmt[item.method](...item.args));
      const [rows, other] = invoke.map(fn => fn());
      const resultSha256 = digest(rows);
      assert.equal(digest(other), resultSha256, [...item.workloads].join(', '));
      return { ...item, invoke, id: 'Q' + String(i + 1).padStart(2, '0'), resultSha256,
        returnedRows: Array.isArray(rows) ? rows.length : rows === undefined ? 0 : 1 };
    });
    const timings = statements.map(({ invoke }, i) => measure(...invoke, i, 512));
    const apiTimings = api.map(item => ({ name: item.name, resultSha256: item.resultSha256,
      ...measure(item.invoke, item.candidate, 1, 128) }));
    const queries = statements.map(({ invoke, args, workloads: labels, ...item }, i) => {
      const [A, B] = observers.map(observer =>
        observer.prepare('EXPLAIN QUERY PLAN ' + item.sql).all(...args));
      return { ...item, args: args.map(filters.redact), workloads: [...labels], timing: timings[i], plan: { A, B } };
    });
    const sqlite = variants[0].prepare('SELECT sqlite_version() version').get().version;
    const options = variants[0].prepare('PRAGMA compile_options').all().map(row => row.compile_options);
    const [inventoryA, inventoryB] = variants.map(inventory);
    assert.deepEqual(inventoryA.rows, inventoryB.rows);
    const runtimeFiles = Object.keys(require.cache).filter(path => path.startsWith(resolve(build) + sep)).sort();
    const report = {
      hypothesis: 'Full-range GROUP BY/ORDER BY is likely to dominate absolute query time; dropping date indexes should most affect selective date ranges and the daily-rollup MIN/MAX readiness query.',
      inputVersion, inputSha256, runnerSha256: shaFile(__filename),
      compiledRuntime: Object.fromEntries(runtimeFiles.map(path => [relative(resolve(build), path).replaceAll('\\', '/'), shaFile(path)])),
      runtime: { node: process.version, sqlite, os: os.release(), platform: process.platform, cpu: os.cpus()[0].model, options },
      settings: { timezone, rounds, warmups, timingUnit: 'ms/call', analysis: 'ANALYZE both copies', vmCounters: 'not exposed by node:sqlite' },
      inputScopes: filters.details, variants: { A: { ...inventoryA, schema: original }, B: { ...inventoryB, schema: schema(variants[1]) } },
      dropSql, queries, api: apiTimings,
    };
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(`Compared ${queries.length} distinct SQL/binding combinations and ${api.length} API workloads.`);
    for (const query of [...queries].sort((x, y) => y.timing.B.median - x.timing.B.median).slice(0, 10)) {
      const { A, B } = query.timing;
      console.log(query.id, A.median.toFixed(3), B.median.toFixed(3), query.workloads[0]);
    }
  } finally {
    a?.connection.close();
    b?.connection.close();
    for (const name of fs.readdirSync(scratch)) fs.unlinkSync(join(scratch, name));
    fs.rmdirSync(scratch);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
