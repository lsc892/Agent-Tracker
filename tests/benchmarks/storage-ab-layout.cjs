// PK·보조 인덱스·월 컬럼을 분리하고 맞춤 SQL과 실제 증분 갱신을 같은 입력으로 비교한다.
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { statSync } = require('node:fs');
const { assert, productRoot: root, IncrementalDatabase: SummaryDatabase, timezone, seed, replacement, state, integrity, stats, order, write } = require('./storage-ab-common.cjs');
const { buildRollupUsageQueries } = require(join(root, 'dist/src/summary/db/rollup-queries'));
const { buildUsageQuery } = require(join(root, 'dist/src/summary/db/queries'));
const { compareResults } = require('./sql-rollup.cjs');
const variants = ['session', 'session-index', 'day', 'day-index', 'month-column', 'month-column-index', 'month', 'month-index'];
const tables = ['usage_request_daily', 'usage_model_daily'];
function install(db, name) {
  const month = name.startsWith('month'), changedPk = name.startsWith('day') || name === 'month' || name === 'month-index';
  const insertColumns = {};
  db.transaction(() => {
    for (const table of tables) {
      const columns = db.connection.prepare(`PRAGMA table_info(${table})`).all().map(v => v.name);
      insertColumns[table] = columns;
      let sql = db.connection.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(table).sql;
      const oldPk = `provider, session_id, project_key, local_day${table.includes('model') ? ', model_key' : ''}`;
      // Rebuild the unchanged PK too, so fresh page packing is not attributed to a PK change.
      {
        sql = sql.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_next`);
        if (month) sql = sql.replace('local_day TEXT NOT NULL,', "local_day TEXT NOT NULL, local_month TEXT NOT NULL,");
        if (changedPk) sql = sql.replace(/PRIMARY KEY\([^)]*\)/,
          `PRIMARY KEY(${month ? 'local_month' : 'local_day'}, provider, session_id, project_key${month ? ', local_day' : ''}${table.includes('model') ? ', model_key' : ''})`);
        else assert.ok(sql.includes(`PRIMARY KEY(${oldPk})`));
        db.connection.exec(sql);
        db.connection.exec(`INSERT INTO ${table}_next(${columns}${month ? ',local_month' : ''}) SELECT ${columns}${month ? ',substr(local_day,1,7)' : ''} FROM ${table}
          ORDER BY provider,session_id,project_key,local_day${table.includes('model') ? ',model_key' : ''};
          DROP TABLE ${table}; ALTER TABLE ${table}_next RENAME TO ${table};
          CREATE INDEX idx_${table}_day ON ${table}(local_day,provider);
          CREATE INDEX idx_${table}_project_day ON ${table}(provider,project_key,local_day);`);
      }
      if (name.endsWith('-index')) db.connection.exec(`CREATE INDEX bench_${table}_session ON ${table}(provider,session_id)`);
    }
  });
  if (month) {
    // Preserve product aggregate SQL and bind values; materialize the month on every product INSERT.
    const original = db.sqlite.statement.bind(db.sqlite);
    db.sqlite.statement = sql => {
      for (const table of tables) {
        const prefix = `INSERT INTO ${table} `;
        if (sql.startsWith(prefix)) sql = `INSERT INTO ${table}(${insertColumns[table]},local_month)
          SELECT s.*,substr(local_day,1,7) FROM (${sql.slice(prefix.length)}) s`;
      }
      return original(sql);
    };
  }
  db.connection.exec('ANALYZE');
}
function queries(spec, month) {
  const q = buildRollupUsageQueries(spec.filter, 'month', timezone, spec.by);
  assert.equal(q.mode, 'rollup');
  if (!month) return q;
  for (const key of ['rows', 'count']) {
    q[key].sql = q[key].sql.replaceAll("substr(NULLIF(local_day, ''), 1, length(local_day) - 3)", 'local_month')
      .replace(/session_id,\s+local_day,/g, 'session_id, local_month, local_day,')
      .replaceAll('local_day >= ?', 'local_month >= ?').replaceAll('local_day < ?', 'local_month < ?');
    q[key].values = q[key].values.map(v => typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) ? v.slice(0, 7) : v);
    if (spec.filter.fromMs !== undefined && spec.filter.toMs - spec.filter.fromMs < 32 * 86400000) {
      assert.ok(q[key].sql.includes('local_month >= ? AND local_month < ?'));
      q[key].sql = q[key].sql.replace('local_month >= ? AND local_month < ?', 'local_month = ?');
      q[key].values.pop();
    }
  }
  return q;
}
function prepared(db, spec, month) {
  const q = queries(spec, month);
  const rows = db.connection.prepare(q.rows.sql), count = db.connection.prepare(q.count.sql);
  const run = () => { const result = rows.all(...q.rows.values, 10000000, 0); const total = count.get(...q.count.values).count; return { result, total }; };
  return { run, q, plan: db.connection.prepare(`EXPLAIN QUERY PLAN ${q.rows.sql}`).all(...q.rows.values, 100, 0).map(v => v.detail) };
}
function verify(db) {
  for (const by of ['provider','model']) for (const group of ['total','month','session']) {
    // Whole-table hashes already prove untouched sessions agree. Check the changed session's
    // public semantics directly; grouping every session repeats correlated MIN lookups N times.
    const filter = group === 'session' ? { provider: 'claude', sessionId: 'session-0' } : {};
    const q = buildRollupUsageQueries(filter, group, timezone, by), raw = buildUsageQuery(filter, group, timezone, by);
    compareResults(db.connection.prepare(raw.sql).all(...raw.values, 10000000, 0),
      db.connection.prepare(q.rows.sql).all(...q.rows.values, 10000000, 0), `layout write ${by}/${group}`);
  }
}
async function runLayout(directory, options) {
  const result = [];
  for (const turns of options.layoutTurns) {
    const paths = variants.map(v => join(directory, `layout-${turns}-${v}.sqlite`));
    const dbs = paths.map(p => new SummaryDatabase(p));
    try {
      for (let i = 0; i < dbs.length; i++) { seed(dbs[i], options.requests, turns); install(dbs[i], variants[i]); }
      const baseline = state(dbs[0]); dbs.forEach(db => assert.deepEqual(state(db), baseline));
      const reads = [];
      for (const by of ['provider', 'model']) for (const scope of ['one-month', 'six-months', 'all', 'project-month', 'provider-month']) {
        const filter = { unknownTime: 'exclude' };
        if (scope !== 'all') Object.assign(filter, { fromMs: Date.UTC(2022, 1, 1) - 9 * 3600000,
          toMs: Date.UTC(2022, scope === 'six-months' ? 7 : 2, 1) - 9 * 3600000 });
        if (scope === 'project-month') Object.assign(filter, { provider: 'claude', projectKey: '/fixture/project-0' });
        if (scope === 'provider-month') filter.provider = 'claude';
        const spec = { by, filter }, ps = dbs.map((db, i) => prepared(db, spec, variants[i].startsWith('month')));
        const raw = buildUsageQuery(filter, 'month', timezone, by);
        const expected = dbs[0].connection.prepare(raw.sql).all(...raw.values, 10000000, 0);
        const probeMs = [];
        ps.forEach(p => { const start = performance.now(); const actual = p.run(); probeMs.push(performance.now() - start);
          compareResults(expected, actual.result, `${by}/${scope}`); assert.equal(actual.total, expected.length); });
        const samples = ps.map(() => []), iterations = Math.max(1, Math.min(30, Math.ceil(10 / Math.max(...probeMs))));
        for (let round = -options.warmup; round < options.samples; round++) for (const i of order(ps.length, Math.abs(round))) {
          const start = performance.now(); for (let j = 0; j < iterations; j++) ps[i].run();
          if (round >= 0) samples[i].push((performance.now() - start) / iterations);
        }
        reads.push({ by, scope, groups: expected.length, iterationsPerSample: iterations, variants: Object.fromEntries(variants.map((v, i) => [v, {
          latency: stats(samples[i]), plan: ps[i].plan, sql: ps[i].q }])) });
      }
      const base = replacement(0, turns), added = structuredClone(base), moved = structuredClone(base), deleted = structuredClone(base);
      const extra = structuredClone(base.summaries.at(-1)); extra.root_turn_id = 'append'; added.summaries.push(extra);
      moved.summaries[0].started_at_ms += 366 * 86400000; moved.summaries[0].completed_at_ms += 366 * 86400000;
      deleted.summaries.shift();
      const writes = [];
      for (const [scenario, input] of [['same', base], ['append', added], ['date-move', moved], ['delete', deleted]]) {
        const samples = dbs.map(() => []);
        for (let round = -options.warmup; round < options.samples; round++) for (const i of order(dbs.length, Math.abs(round))) {
          dbs[i].replaceSessions(structuredClone(base)); const value = write(dbs[i], input, paths[i]);
          if (round >= 0) samples[i].push(value);
        }
        const expected = state(dbs[0]); dbs.forEach(db => { assert.deepEqual(state(db), expected); verify(db); });
        writes.push({ scenario, hashes: expected, variants: Object.fromEntries(variants.map((v, i) => [v, { latency: stats(samples[i].map(v => v.elapsedMs)), samples: samples[i] }])) });
      }
      const space = Object.fromEntries(dbs.map((db, i) => {
        db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)'); integrity(db);
        const objects = db.connection.prepare('SELECT name,sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY name').all();
        return [variants[i], { fileBytes: statSync(paths[i]).size, rollupBytes: objects.filter(v => tables.some(t => v.name.includes(t))).reduce((n, v) => n + v.bytes, 0), objects }];
      }));
      result.push({ requests: options.requests, turnsPerSession: turns,
        population: dbs[0].connection.prepare(`SELECT count(*) AS requests,count(DISTINCT session_id) AS sessions,
          min(started_at_ms) AS firstMs,max(started_at_ms) AS lastMs FROM turn_summary`).get(),
        rollupRows: Object.fromEntries(tables.map(t => [t, dbs[0].connection.prepare(`SELECT count(*) AS n FROM ${t}`).get().n])),
        reads, writes, space });
      console.log(`Layout: ${options.requests}/${turns} complete`);
    } finally { dbs.forEach(db => db.close()); }
  }
  return result;
}
module.exports = { runLayout };
