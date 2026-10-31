// 현재 제품과 인덱스만 사용하는 실험 저장소를 같은 원본·사전 상태에서 순차 비교한다.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { mkdir, mkdtemp, rm, writeFile, utimes } = require('node:fs/promises');
const { join, resolve, dirname, basename, sep, relative } = require('node:path');
const { tmpdir, cpus } = require('node:os');
const { performance } = require('node:perf_hooks');
const { backup } = require('node:sqlite');
const { refreshSummary } = require('../../dist/src/summary/scanner');
const { SummaryStaging } = require('../../dist/src/summary/staging');
const raw = require('../../dist/src/summary/db/queries');
const { buildRollupUsageQueries } = require('../../dist/src/summary/db/rollup-queries');
const { seedSynthetic } = require('./sql-explain.cjs');
const { openDatabase, INDEX_SQL } = require('./index-only-candidate.cjs');
const { synthetic, realSnapshot, deltaSnapshot, fingerprint, sessionText, fixedMtime, sha } = require('./index-only-fixtures.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul', variants = ['A', 'B'];
const time = () => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const order = round => round % 2 ? ['B', 'A'] : variants;
const median = a => { const b = [...a].sort((x, y) => x - y); return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2; };
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b), q = p => sorted[Math.floor((sorted.length - 1) * p)];
  return { samples, median: median(samples), p10: q(.1), p90: q(.9), min: sorted[0], max: sorted.at(-1) };
}
function paired(a, b) { return { differenceMs: stats(a.map((v, i) => v - b[i])), bFasterPairs: a.filter((v, i) => b[i] < v).length }; }
function hashes() {
  const paths = [];
  function walk(path) {
    for (const item of fs.readdirSync(join(root, path), { withFileTypes: true })) {
      const name = join(path, item.name);
      if (item.isDirectory()) walk(name);
      else if (/\.(ts|js|cjs)$/.test(name)) paths.push(name);
    }
  }
  walk('src'); walk('dist/src');
  paths.push('package-lock.json', ...['index-only.cjs', 'index-only-candidate.cjs', 'index-only-fixtures.cjs', 'incremental-refresh.cjs', 'sql-explain.cjs'].map(n => join('tests/benchmarks', n)));
  return Object.fromEntries(paths.sort().map(p => [p.replaceAll('\\', '/'), sha(fs.readFileSync(join(root, p)))]));
}
function inventory(db) {
  const c = db.connection;
  return { ...c.prepare(`SELECT count(*) requests,count(DISTINCT project_key) projects,
    (SELECT count(*) FROM sessions) sessions,(SELECT count(*) FROM turn_model_usage) models,
    coalesce(sum(total_tokens),0) tokens FROM turn_summary`).get(),
    providers: c.prepare('SELECT provider,count(*) requests FROM turn_summary GROUP BY provider').all(),
    maxSessionRequests: c.prepare('SELECT max(n) n FROM (SELECT count(*) n FROM turn_summary GROUP BY provider,session_id)').get().n };
}
function factHash(db) {
  const h = require('node:crypto').createHash('sha256');
  for (const [table, sql] of [
    ['requests', 'SELECT * FROM turn_summary ORDER BY provider,session_id,root_turn_id'],
    ['models', 'SELECT t.provider,t.session_id,t.root_turn_id,m.* FROM turn_summary t JOIN turn_model_usage m ON t.id=m.turn_id ORDER BY t.provider,t.session_id,t.root_turn_id,m.model'],
    ['caps', 'SELECT t.provider,t.session_id,t.root_turn_id,m.* FROM turn_summary t JOIN turn_capability_usage m ON t.id=m.turn_id ORDER BY t.provider,t.session_id,t.root_turn_id,m.category,m.name'],
    ['costs', 'SELECT t.provider,t.session_id,t.root_turn_id,m.* FROM turn_summary t JOIN turn_costs m ON t.id=m.turn_id ORDER BY t.provider,t.session_id,t.root_turn_id'],
    ['projects', 'SELECT * FROM projects ORDER BY project_key'], ['sessions', 'SELECT * FROM sessions ORDER BY provider,session_id'],
    ['manifest', 'SELECT provider,session_id,size_bytes,parser_version,processing_status,last_error,source_missing,content_hash FROM manifest ORDER BY provider,path'],
  ]) {
    h.update(table);
    for (const row of db.connection.prepare(sql).iterate()) {
      for (const key of ['id', 'turn_id', 'updated_at', 'diagnostic_file_id']) delete row[key];
      h.update(JSON.stringify(row));
    }
  }
  return h.digest('hex');
}
function integrity(db) {
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
}
function space(db, path) {
  const c = db.connection, page = schema => {
    const count = c.prepare(`PRAGMA ${schema}.page_count`).get().page_count;
    return count * c.prepare(`PRAGMA ${schema}.page_size`).get().page_size;
  };
  c.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const tables = c.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const result = { fileBytes: fs.statSync(path).size, allocatedBytes: page('main'), tempAllocatedBytes: page('temp'),
    freelistPages: c.prepare('PRAGMA freelist_count').get().freelist_count,
    tables: tables.map(({ name }) => {
      const columns = c.prepare(`PRAGMA table_info(${name})`).all();
      const count = c.prepare(`SELECT count(*) n FROM ${name}`).get().n;
      return { name, rows: count, columns: columns.length, storedValuesIncludingNull: count * columns.length,
        nonNullValues: c.prepare(`SELECT ${columns.map(v => `count(${v.name})`).join('+')} n FROM ${name}`).get().n };
    }),
    schema: c.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
    indexes: tables.flatMap(({ name }) => c.prepare(`PRAGMA index_list(${name})`).all().map(index => ({ table: name, ...index,
      columns: c.prepare(`PRAGMA index_xinfo('${index.name}')`).all() }))) };
  try { result.objects = c.prepare('SELECT name,sum(pgsize) bytes,sum(payload) payload,sum(unused) unused FROM dbstat GROUP BY name ORDER BY name').all(); }
  catch { result.objectsUnavailable = 'This SQLite build does not expose dbstat'; }
  return result;
}

// SQL과 독립적인 JS 집계이며 입력은 requests/models의 비집계 행만 사용한다.
function oracleFacts(db) {
  const models = new Map();
  for (const row of db.connection.prepare('SELECT * FROM turn_model_usage').all()) {
    if (!models.has(row.turn_id)) models.set(row.turn_id, []);
    models.get(row.turn_id).push(row);
  }
  return db.connection.prepare('SELECT * FROM turn_summary').all().flatMap(t => (models.get(t.id) ?? [null]).map(m => {
    const total = m ? m.input_tokens + m.output_tokens : t.total_tokens;
    return { ...t, model: !(m?.model ?? '') && !total ? null : m?.model ?? '',
      input_tokens: m?.input_tokens ?? t.input_tokens, output_tokens: m?.output_tokens ?? t.output_tokens,
      cache_read_input_tokens: m ? m.cache_read_input_tokens : t.cache_read_input_tokens,
      cache_write_input_tokens: m ? m.cache_write_input_tokens : t.cache_write_input_tokens,
      total_tokens: total, recorded: total > 0 || !!m?.model };
  }));
}
const dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
function oracle(facts, spec) {
  const result = new Map(), f = spec.filter;
  for (const row of facts) {
    if (f.projectKey !== undefined && row.project_key !== f.projectKey) continue;
    if (f.provider !== undefined && row.provider !== f.provider) continue;
    if (f.sessionId !== undefined && row.session_id !== f.sessionId) continue;
    if (f.unknownTime === 'only' && row.started_at_ms !== null) continue;
    if (f.unknownTime === 'exclude' && row.started_at_ms === null) continue;
    if (row.started_at_ms !== null && (f.fromMs !== undefined && row.started_at_ms < f.fromMs || f.toMs !== undefined && row.started_at_ms >= f.toMs)) continue;
    const period = row.started_at_ms === null ? null : dayFormat.format(row.started_at_ms).slice(0, spec.group === 'day' ? 10 : 7);
    const key = JSON.stringify([row.provider, row.model, period, spec.id === 'Q3' ? row.session_id : null]);
    if (!result.has(key)) result.set(key, { rows: [], provider: row.provider, model: row.model, period, session_id: spec.id === 'Q3' ? row.session_id : null });
    result.get(key).rows.push(row);
  }
  return [...result.values()].map(g => {
    const completed = g.rows.filter(r => r.status === 'completed' && (!f.excludeEmptyUsage || r.recorded));
    const sum = (a, name) => a.reduce((n, r) => n + r[name], 0);
    const value = { provider: g.provider, model: g.model, period: g.period, session_id: g.session_id,
      turn_count: g.rows.length, completed_turns: g.rows.filter(r => r.status === 'completed').length,
      recorded_turns: g.rows.filter(r => r.recorded).length,
      recorded_completed_turns: g.rows.filter(r => r.status === 'completed' && r.recorded).length };
    for (const name of ['input_tokens', 'output_tokens', 'total_tokens', 'cache_read_input_tokens', 'cache_write_input_tokens']) {
      value[name] = g.rows.some(r => r[name] === null) ? null : sum(g.rows, name);
      const avgName = name === 'total_tokens' ? 'avg_tokens_per_turn' : `avg_${name}`;
      value[avgName] = !completed.length || completed.some(r => r[name] === null) ? null : sum(completed, name) / completed.length;
    }
    return value;
  });
}
function compareOracle(actual, expected) {
  const key = r => JSON.stringify([r.provider, r.model, r.period, r.session_id]);
  const lookup = new Map(actual.map(r => [key(r), r]));
  assert.equal(lookup.size, actual.length); assert.equal(actual.length, expected.length);
  for (const row of expected) for (const [name, value] of Object.entries(row)) {
    const got = lookup.get(key(row))?.[name];
    if (typeof value === 'number' && !Number.isInteger(value)) assert.ok(Math.abs(got - value) <= 1e-9 * Math.max(1, Math.abs(value)), name);
    else assert.equal(got, value, name);
  }
}
function queries(variant, spec) {
  const q = variant === 'A' ? buildRollupUsageQueries(spec.filter, spec.group, timezone, 'model') : {
    rows: raw.buildUsageQuery(spec.filter, spec.group, timezone, 'model'),
    count: raw.buildUsageCountQuery(spec.filter, spec.group, timezone, 'model'), mode: 'raw' };
  assert.ok(q);
  if (spec.id === 'Q3') {
    // 공개 API에 월×세션 조합이 없어 실제 builder의 차원만 확장한다.
    for (const part of ['rows', 'count']) q[part].sql = q[part].sql.replaceAll('GROUP BY provider, model, period', 'GROUP BY provider, model, period, session_id');
    q.rows.sql = q.rows.sql.replace('NULL AS session_id', 'session_id');
  }
  return q;
}
function specs(db) {
  const selected = db.connection.prepare('SELECT project_key,count(*) n FROM turn_summary GROUP BY project_key ORDER BY n DESC,project_key LIMIT 1').get().project_key;
  const from = db.connection.prepare('SELECT min(started_at_ms) n FROM turn_summary').get().n;
  const day = dayFormat.format(from), month = day.slice(0, 7), next = new Date(`${month}-01T00:00:00+09:00`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const monthStart = Date.parse(`${month}-01T00:00:00+09:00`), monthEnd = next.getTime();
  const periods = [
    ['day', Date.parse(`${day}T00:00:00+09:00`), Date.parse(`${day}T00:00:00+09:00`) + 86400000],
    ['partial', monthStart + 7 * 86400000 + 12 * 3600000, monthStart + 10 * 86400000 + 13 * 3600000],
    ['month', monthStart, monthEnd], ['cross-month', monthStart + 14 * 86400000 + 12 * 3600000, monthEnd + 14 * 86400000 + 13 * 3600000],
    ['all', undefined, undefined], ['empty', Date.parse('2099-01-01T00:00:00Z'), Date.parse('2099-01-02T00:00:00Z')],
  ];
  return periods.flatMap(([period, fromMs, toMs]) => ['Q1', 'Q2', 'Q3'].map(id => ({ id, period, group: id === 'Q1' ? 'day' : 'month',
    filter: { excludeEmptyUsage: true, unknownTime: 'exclude', ...(fromMs === undefined ? {} : { fromMs, toMs }), ...(id === 'Q1' ? {} : { projectKey: selected }) } })));
}
function explain(db, q, page) {
  const values = [...q.values, ...(page ? [100, 0] : [])];
  // 파라미터 값의 원본 경로·ID는 보존하지 않고 논리적으로 마스킹한다.
  return { sql: q.sql, parameters: q.values.map(v => typeof v === 'string' && /[\\/]/.test(v) && v !== timezone ? '<selected-project>' : v),
    steps: db.connection.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...values).map(r => r.detail) };
}
function readBench(dbs, options, extraSpecs = []) {
  const facts = oracleFacts(dbs.A), reads = [];
  for (const spec of [...specs(dbs.A), ...extraSpecs]) {
    const expected = oracle(facts, spec), prepared = {};
    for (const v of variants) {
      const q = queries(v, spec), rows = dbs[v].connection.prepare(q.rows.sql), count = dbs[v].connection.prepare(q.count.sql);
      const full = rows.all(...q.rows.values, 10000000, 0);
      compareOracle(full, expected); assert.equal(count.get(...q.count.values).count, expected.length);
      prepared[v] = { q, full: () => ({ rows: rows.all(...q.rows.values, 10000000, 0), total: count.get(...q.count.values).count }),
        page: () => spec.id === 'Q3' ? { rows: dbs[v].connection.prepare(q.rows.sql).all(...q.rows.values, 100, 0),
          total: dbs[v].connection.prepare(q.count.sql).get(...q.count.values).count }
          : dbs[v].queryUsagePage(spec.filter, spec.group, timezone, { limit: 100 }, 'model') };
    }
    const item = { id: spec.id, period: spec.period, inputModelFacts: facts.filter(r => {
      const f = spec.filter;
      if (f.projectKey && f.projectKey !== r.project_key) return false;
      if (f.unknownTime === 'only') return r.started_at_ms === null;
      if (r.started_at_ms === null) return f.unknownTime === 'include';
      return (f.fromMs === undefined || r.started_at_ms >= f.fromMs) && (f.toMs === undefined || r.started_at_ms < f.toMs);
    }).length, groups: expected.length, resultSha256: sha(JSON.stringify(expected)), variants: { A: {}, B: {} } };
    item.correctnessTotals = { tokensAllStatuses: expected.reduce((n, r) => n + r.total_tokens, 0),
      completedModelRequestDenominator: expected.reduce((n, r) => n + (spec.filter.excludeEmptyUsage ? r.recorded_completed_turns : r.completed_turns), 0),
      completedTokenNumerator: expected.reduce((n, r) => n + (r.avg_tokens_per_turn ?? 0) * (spec.filter.excludeEmptyUsage ? r.recorded_completed_turns : r.completed_turns), 0) };
    for (const mode of ['page', 'full']) {
      const samples = { A: [], B: [] };
      for (let round = -2; round < options.readSamples; round++) for (const v of order(Math.abs(round))) {
        let value;
        const start = performance.now();
        for (let i = 0; i < 3; i++) value = prepared[v][mode]();
        if (round >= 0) samples[v].push((performance.now() - start) / 3);
        assert.equal(value.total, expected.length);
      }
      for (const v of variants) item.variants[v][mode] = stats(samples[v]);
      item[`${mode}Paired`] = paired(samples.A, samples.B);
    }
    for (const v of variants) item.variants[v].plan = { mode: prepared[v].q.mode,
      rows: explain(dbs[v], prepared[v].q.rows, true), count: explain(dbs[v], prepared[v].q.count, false) };
    reads.push(item);
  }
  return reads;
}

function instrument(db, detailed) {
  const c = db.connection, originalExec = c.exec, originalPrepare = c.prepare;
  const originalReplace = db.replaceSessions, originalNormalize = SummaryStaging.prototype.prepareSummaries;
  const originalRead = require('../../dist/src/summary/jsonl').readJsonl;
  const rollups = db.sqlite.rollups, originalRollup = rollups.refreshChangedSessions;
  const data = { storeCallMs: 0, normalizeMs: 0, readParseMs: 0, transactionMs: 0, beginWaitMs: 0, commits: 0, storeCalls: 0,
    reads: {}, tempMaxAllocatedBytes: 0, tempTables: [], writeChanges: 0, rollupMaintenanceMs: 0, directStatementWrites: {} };
  let begun;
  const collect = (sql, row) => {
    if (!row) return;
    const table = /\bFROM\s+([a-z_]+)/i.exec(sql)?.[1] ?? 'other';
    const item = data.reads[table] ??= { rows: 0, valuesIncludingNull: 0 };
    item.rows++; item.valuesIncludingNull += Object.keys(row).length;
  };
  if (detailed) c.prepare = function(sql) {
    const stmt = originalPrepare.call(this, sql);
    const run = stmt.run;
    stmt.run = function(...args) {
      const value = run.apply(this, args);
      const target = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|DELETE\s+FROM|UPDATE)\s+([a-z_]+)/i.exec(sql)?.[1] ?? 'other';
      const item = data.directStatementWrites[target] ??= { calls: 0, changedRowsExcludingCascades: 0 };
      item.calls++; item.changedRowsExcludingCascades += Number(value.changes); return value;
    };
    for (const method of ['get', 'all', 'iterate']) {
      const original = stmt[method];
      if (method === 'iterate') stmt[method] = function*(...args) { for (const row of original.apply(this, args)) { collect(sql, row); yield row; } };
      else stmt[method] = function(...args) { const value = original.apply(this, args); for (const row of method === 'all' ? value : [value]) collect(sql, row); return value; };
    }
    return stmt;
  };
  const sampleTemp = () => {
    const count = originalPrepare.call(c, 'PRAGMA temp.page_count').get().page_count;
    data.tempMaxAllocatedBytes = Math.max(data.tempMaxAllocatedBytes, count * originalPrepare.call(c, 'PRAGMA temp.page_size').get().page_size);
    const names = originalPrepare.call(c, "SELECT name FROM sqlite_temp_schema WHERE type='table'").all().map(r => r.name);
    data.tempTables = [...new Set([...data.tempTables, ...names])].sort();
  };
  c.exec = function(sql) {
    const start = performance.now(), result = originalExec.call(this, sql);
    if (/^BEGIN\b/.test(sql.trim())) { begun = start; data.beginWaitMs += performance.now() - start; }
    if (sql.trim() === 'COMMIT') { data.commits++; if (begun !== undefined) data.transactionMs += performance.now() - begun; begun = undefined; }
    if (detailed && /CREATE TEMP|COMMIT/.test(sql)) sampleTemp();
    return result;
  };
  db.replaceSessions = function(...args) {
    const start = performance.now(); data.storeCalls++;
    try { return originalReplace.apply(this, args); } finally { data.storeCallMs += performance.now() - start; if (detailed) sampleTemp(); }
  };
  rollups.refreshChangedSessions = function(...args) {
    const start = performance.now();
    try { return originalRollup.apply(this, args); } finally { data.rollupMaintenanceMs += performance.now() - start; }
  };
  SummaryStaging.prototype.prepareSummaries = function(...args) {
    const start = performance.now();
    try { return originalNormalize.apply(this, args); } finally { data.normalizeMs += performance.now() - start; }
  };
  require('../../dist/src/summary/jsonl').readJsonl = async function(...args) {
    const start = performance.now();
    try { return await originalRead.apply(this, args); } finally { data.readParseMs += performance.now() - start; }
  };
  const beforeChanges = originalPrepare.call(c, 'SELECT total_changes() n').get().n;
  return { data, restore() {
    data.writeChanges = originalPrepare.call(c, 'SELECT total_changes() n').get().n - beforeChanges;
    c.exec = originalExec; c.prepare = originalPrepare; db.replaceSessions = originalReplace;
    SummaryStaging.prototype.prepareSummaries = originalNormalize;
    rollups.refreshChangedSessions = originalRollup;
    require('../../dist/src/summary/jsonl').readJsonl = originalRead;
  } };
}
async function refresh(db, path, roots, detailed = false) {
  const meter = instrument(db, detailed), phases = {};
  let phase = 'setup', last = performance.now();
  const start = performance.now(); let result;
  try { result = await refreshSummary(db, { dbPath: path, roots }, undefined, p => {
    if (p.phase !== phase) { const now = performance.now(); phases[phase] = (phases[phase] ?? 0) + now - last; phase = p.phase; last = now; }
  }); } finally { meter.restore(); }
  const refreshTotalMs = performance.now() - start;
  assert.equal(result.interrupted, false, `refresh interrupted: ${result.error}`);
  assert.equal(result.failed, 0, 'A source failed to parse/store');
  return { refreshTotalMs, ...meter.data, phases, parsed: result.parsed, discovered: result.discovered,
    reused: result.reused, failed: result.failed, bodyBytes: result.bodyBytes,
    walBytesAtRefreshEnd: fs.existsSync(path + '-wal') ? fs.statSync(path + '-wal').size : 0 };
}
async function writeBench(directory, name, snapshot, options, baseSnapshots, roots = snapshot.roots, mutate) {
  // 10,000 파일의 전체 parser/COMMIT 반복 비용 때문에 W1만 3표본으로 줄인다.
  const measuredCount = snapshot.files.length >= 10000 && name.endsWith('-initial') ? 3 : options.writeSamples;
  const samples = { A: [], B: [] }, diagnostics = {}, firstQuery = { A: [], B: [] }, setup = { A: [], B: [] };
  let expectedHash;
  for (let round = -1; round < measuredCount + 1; round++) for (const v of order(Math.abs(round))) {
    const diagnostic = round === measuredCount;
    const path = join(directory, `${name}-${round}-${v}.sqlite`);
    if (baseSnapshots) await backup(baseSnapshots[v].connection, path);
    const setupStart = performance.now(), db = openDatabase(path, v), setupMs = performance.now() - setupStart;
    const restore = mutate ? await mutate() : async () => {};
    try {
      db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const sample = await refresh(db, path, roots, diagnostic);
      const queryStart = performance.now(); db.queryUsagePage({}, 'month', timezone, { limit: 100 }, 'model');
      const firstQueryMs = performance.now() - queryStart;
      if (round >= 0 && !diagnostic) { samples[v].push(sample); firstQuery[v].push(firstQueryMs); setup[v].push(setupMs); }
      if (diagnostic) {
        const allocation = space(db, path);
        diagnostics[v] = { ...sample, storageAfter: { allocatedBytes: allocation.allocatedBytes, fileBytes: allocation.fileBytes,
          freelistPages: allocation.freelistPages, tables: allocation.tables } };
      }
      const state = factHash(db);
      expectedHash ??= state; assert.equal(state, expectedHash, `${name}: semantic state mismatch`);
      integrity(db);
      if (snapshot.expected) for (const field of ['requests', 'tokens', 'sessions', 'projects']) assert.equal(inventory(db)[field], snapshot.expected[field], `${name}/${field}`);
      if (name === 'unchanged') { assert.equal(sample.bodyBytes, 0); assert.equal(sample.storeCalls, 0); }
      if (round === 0) console.log(`${name} ${v}: ${sample.refreshTotalMs.toFixed(1)} ms; parsed=${sample.parsed}; bytes=${sample.bodyBytes}`);
    } finally { db.close(); await restore(); }
    // Windows에서 비동기 backup 대상의 해제 직후 삭제를 피하고 종료 시 일괄 정리한다.
  }
  return { name, measuredCount, executionOrder: Array.from({ length: measuredCount + 2 }, (_, i) => ({ round: i - 1, order: order(Math.abs(i - 1)) })),
    resultSha256: expectedHash, diagnostics, variants: Object.fromEntries(variants.map(v => [v, {
    samples: samples[v], refresh: stats(samples[v].map(s => s.refreshTotalMs)), store: stats(samples[v].map(s => s.storeCallMs)),
    firstQuery: stats(firstQuery[v]), readyTotal: stats(samples[v].map((s, i) => s.refreshTotalMs + firstQuery[v][i])),
    setup: stats(setup[v]), setupThroughReady: stats(samples[v].map((s, i) => setup[v][i] + s.refreshTotalMs + firstQuery[v][i])) }])),
    paired: paired(samples.A.map(s => s.refreshTotalMs), samples.B.map(s => s.refreshTotalMs)) };
}

async function readyPair(directory, snapshot, suffix) {
  const pair = {};
  for (const v of variants) {
    const path = join(directory, `${suffix}-${v}.sqlite`), db = openDatabase(path, v);
    await refresh(db, path, snapshot.roots);
    db.queryUsagePage({}, 'month', timezone, { limit: 100 }, 'model');
    db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)'); pair[v] = db;
  }
  assert.equal(factHash(pair.A), factHash(pair.B));
  return pair;
}
function optionsFor(args) {
  const o = { smoke: false, real: false, readSamples: 9, writeSamples: 5,
    output: 'docs/benchmarks/2026-10-31/DbTradeoff-index-only.json' };
  for (const arg of args) {
    if (arg === '--smoke') { o.smoke = true; o.readSamples = 3; o.writeSamples = 3; }
    else if (arg === '--real') o.real = true;
    else if (arg.startsWith('--output=')) o.output = arg.slice(9);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return o;
}
async function main() {
  const options = optionsFor(process.argv.slice(2)), output = resolve(options.output);
  assert.ok(!fs.existsSync(output) && !fs.existsSync(output.replace(/\.json$/, '.md')), 'Use a new report name');
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-index-only-'));
  const frozenHashes = hashes();
  const report = { startedSeoul: time(), sourceHashes: frozenHashes,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    workingTreeAtStart: execFileSync('git', ['status', '--short'], { encoding: 'utf8', windowsHide: true }).trim(),
    environment: { node: process.version, cpu: cpus()[0].model, platform: process.platform, arch: process.arch },
    method: { timezone, readSamples: options.readSamples, writeSamples: options.writeSamples,
      queryWarmups: 2, queryIterationsPerSample: 3, writeWarmups: 1, order: 'AB/BA alternating, sequential shared process',
      cold: 'OS caches uncontrolled; first query is first use on a fresh/restored DB, not cold disk IO',
      w1: 'refreshSummary entry through all COMMIT and return; DB setup measured separately; first lazy query separately and directly summed per trial',
      diagnostics: 'Separate extra trial; get/all/iterate returned rows+column values, total_changes, TEMP allocation; not included in timed samples',
      common: 'Actual scanner, parsers, normalization staging TEMP, manifest/name/cost/capability facts and FK retained',
      candidate: 'No usage_* tables, no replacement/diff TEMP, same facts PKs; six secondary indexes; JS sets+indexed per-session DELETE/INSERT',
      note: 'User requested A/B of whole designs. B is a combined design change, not index-only delta attribution; PK-only experiment intentionally outside scope.',
      counters: { scanstatus: 'unavailable: node:sqlite StatementSync exposes no scanstatus API',
        stmtStatus: 'unavailable: node:sqlite exposes no VM_STEP/FULLSCAN_STEP/SORT counters',
        physicalIO: 'unmeasured: no VFS/OS IO tracing; bodyBytes is original reader output, not physical disk IO',
        dbstat: 'probed per dataset', peakMemory: 'unmeasured: shared-process RSS cannot isolate synchronous peaks' },
      precision: 'Integers/counts exact; average tolerance 1e-9 relative; result hashes only, no source text/title/path/session identifiers',
      percentile: 'Nearest lower rank floor((n-1)*p); 9 read/5 write batches; large W1 uses 3 due to 10,000 parser+COMMIT cost; each query sample averages 3 calls',
      noAnalyzeOverride: 'Product optimize behavior retained; same PRAGMAs on both; no manual ANALYZE or checkpoint inside measured refresh',
      indexDDL: INDEX_SQL,
      hypotheses: [
        'B removes rollup rows and maintenance; storage/setup/refresh should shrink unless redundant indexes and JS per-session work dominate.',
        'B date/project indexes restrict narrow scans, but all-range queries still group matching model facts N; A processes rollup rows R.',
        'A should benefit most when a long session compresses many requests into few days; with one request/session R is about N and wide rollup rows may cost more.',
        'B rewrites the entire changed session even for +1; A diff threshold is oldCount>=1000 and changes<=min(32,floor(oldCount/10)). +33/+50 exercise fallback.',
      ] }, datasets: [] };
  const save = async () => { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
  try {
    const cases = options.smoke ? [['smoke-30', 3, 10, 1], ['smoke-long', 3, 10, 1000]] : [
      ['small-300', 10, 30, 1], ['small-500', 10, 50, 1], ['large-100x100', 100, 100, 1],
      ['small-long-1000', 10, 30, 1000], ['large-long-1000', 100, 100, 1000],
    ];
    const snapshots = [];
    if (options.real) snapshots.push(['real-365', await realSnapshot(join(directory, 'real'))]);
    for (const [name, p, s, long] of cases) snapshots.push([name, await synthetic(join(directory, name), p, s, long)]);
    for (const [name, snapshot] of snapshots) {
      console.log(`Dataset ${name}: freezing ${snapshot.files.length} files`);
      const input = await fingerprint(snapshot), dataset = { name, input, expected: snapshot.expected, longTurns: snapshot.longTurns, writes: [] };
      report.datasets.push(dataset);
      dataset.writes.push(await writeBench(directory, `${name}-initial`, snapshot, options));
      const dbs = await readyPair(directory, snapshot, name);
      try {
        dataset.counts = inventory(dbs.A);
        if (!report.environment.sqlite) {
          report.environment.sqlite = dbs.A.connection.prepare('SELECT sqlite_version() v').get().v;
          report.environment.compileOptions = dbs.A.connection.prepare('PRAGMA compile_options').all();
          report.environment.pragmas = Object.fromEntries(['journal_mode', 'synchronous', 'page_size', 'cache_size', 'temp_store', 'foreign_keys', 'automatic_index', 'wal_autocheckpoint'].map(p => [p, dbs.A.connection.prepare(`PRAGMA ${p}`).get()]));
        }
        dataset.space = Object.fromEntries(variants.map(v => [v, space(dbs[v], join(directory, `${name}-${v}.sqlite`))]));
        dataset.reads = readBench(dbs, options);
        if ((snapshot.files.length >= 300 && !snapshot.longTurns) || snapshot.longTurns === 1) {
          const count = snapshot.files.length >= 10000 ? 10000 : 300;
          if (snapshot.files.length >= count) {
            const delta = await deltaSnapshot(join(directory, `${name}-delta`), snapshot, count);
            const base = await readyPair(directory, { roots: delta.baseRoots }, `${name}-base`);
            try { dataset.writes.push(await writeBench(directory, 'delta-50', delta, options, base)); } finally { Object.values(base).forEach(db => db.close()); }
            const full = await readyPair(directory, delta, `${name}-full`);
            try { dataset.writes.push(await writeBench(directory, 'unchanged', delta, options, full)); } finally { Object.values(full).forEach(db => db.close()); }
          }
        }
        if (snapshot.longTurns > 1) {
          const target = snapshot.files[0], original = fs.readFileSync(target.path);
          const changes = (options.smoke ? [1, 50] : [1, 31, 32, 33, 50]).map(amount => ({ name: `append-${amount}`, amount, value: sessionText(target, snapshot.longTurns + amount) }));
          if (!options.smoke) {
            changes.push({ name: 'delete-one', amount: -1, value: sessionText(target, snapshot.longTurns - 1) });
            const edited = original.toString().trimEnd().split('\n').map(line => JSON.parse(line));
            const usage = edited.find(r => r.message?.usage || r.payload?.usage);
            (usage.message?.usage ?? usage.payload.usage).input_tokens += 7;
            changes.push({ name: 'edit-one', amount: 0, value: { text: edited.map(r => JSON.stringify(r)).join('\n') + '\n', tokens: sessionText(target, snapshot.longTurns).tokens + 7 } });
            changes.push({ name: 'all-changed', amount: 0, value: sessionText({ ...target, ordinal: target.ordinal + 1 }, snapshot.longTurns) });
          }
          for (const change of changes) {
            const changed = change.value;
            const expected = { ...snapshot.expected, requests: snapshot.expected.requests + change.amount,
              tokens: snapshot.expected.tokens + changed.tokens - sessionText(target, snapshot.longTurns).tokens };
            dataset.writes.push(await writeBench(directory, change.name, { ...snapshot, expected }, options, dbs, snapshot.roots, async () => {
              await writeFile(target.path, changed.text); await utimes(target.path, fixedMtime, new Date('2026-10-02T00:00:00Z'));
              return async () => { await writeFile(target.path, original); await utimes(target.path, fixedMtime, fixedMtime); };
            }));
          }
        }
        integrity(dbs.A); integrity(dbs.B);
      } finally { Object.values(dbs).forEach(db => db.close()); }
      assert.deepEqual(await fingerprint(snapshot), input);
      console.log(`Dataset ${name}: queries/accuracy/space passed`); await save();
    }
    // 경계·상태·빈 모델/사용량·NULL 캐시는 실제 제품 raw 사실 fixture에서 독립 oracle과 대조한다.
    const edge = {};
    for (const v of variants) {
      edge[v] = openDatabase(join(directory, `edge-${v}.sqlite`), v); seedSynthetic(edge[v], 500);
      edge[v].connection.exec(`UPDATE turn_model_usage SET cache_read_input_tokens=NULL WHERE turn_id%19=0;
        UPDATE turn_summary SET cache_read_input_tokens=NULL WHERE id%19=0;
        UPDATE turn_model_usage SET model='' WHERE turn_id%23=0 AND model NOT LIKE '%helper';`);
      edge[v].queryUsagePage({}, 'month', timezone, { limit: 100 }, 'model');
    }
    const edgeSpecs = ['include', 'only'].flatMap(unknownTime => [false, true].map(excludeEmptyUsage => ({
      id: 'Q1', period: `unknown-${unknownTime}-excludeEmpty-${excludeEmptyUsage}`, group: 'day', filter: { unknownTime, excludeEmptyUsage } })));
    try { report.edgeCases = { counts: inventory(edge.A), reads: readBench(edge, options, edgeSpecs) }; }
    finally { Object.values(edge).forEach(db => db.close()); }
    assert.deepEqual(hashes(), frozenHashes, 'Source/build changed during experiment');
    report.completedSeoul = time(); await save();
    console.log(`Saved ${relative(root, output)}`);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('agent-tracker-index-only-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { oracle, compareOracle, queries, specs, optionsFor };
