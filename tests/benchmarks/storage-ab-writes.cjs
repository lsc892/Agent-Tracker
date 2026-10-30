// 요청별 TEMP/EXCEPT와 한 번 적재한 TEMP/JOIN 비교, 기존 일괄 교체와 크기별 혼합 경로를 측정한다.
const { join } = require('node:path');
const { assert, productRoot: root, IncrementalDatabase, incrementalHelpers, timezone, replacement, summary, state, integrity, stats, order, write } = require('./storage-ab-common.cjs');
const { SummaryDatabase: BulkDatabase } = require(join(root, 'dist/src/summary/db'));
const { SessionStore: BulkSessionStore } = require(join(root, 'dist/src/summary/db/sessions'));
const { estimateCost, PRICING_VERSION } = require(join(root, 'dist/src/summary/pricing'));
const { turnValues, TURN_COLUMNS } = incrementalHelpers;
const modelColumns = ['model','input_tokens','output_tokens','cache_write_input_tokens','cache_read_input_tokens','estimated_cost_usd','pricing_version'];
const capColumns = ['category','name','usage_count'];
function installBatch(db) {
  db.sessions.applySummaries = function(replacement, hasSession, now) {
    const c = this.database.connection, stmt = sql => this.database.statement(sql);
    c.exec(`CREATE TEMP TABLE IF NOT EXISTS bench_next AS SELECT 0 AS seq,0 AS explicit_time,${TURN_COLUMNS} FROM turn_summary WHERE 0;
      CREATE UNIQUE INDEX IF NOT EXISTS temp.bench_next_seq ON bench_next(seq);
      CREATE UNIQUE INDEX IF NOT EXISTS temp.bench_next_key ON bench_next(provider,session_id,root_turn_id);
      CREATE TEMP TABLE IF NOT EXISTS bench_models(seq INTEGER,model TEXT,input_tokens INTEGER,output_tokens INTEGER,
        cache_write_input_tokens INTEGER,cache_read_input_tokens INTEGER,estimated_cost_usd REAL,pricing_version TEXT,PRIMARY KEY(seq,model)) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS bench_caps(seq INTEGER,category TEXT,name TEXT,usage_count INTEGER,PRIMARY KEY(seq,category,name)) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS bench_model_changes(seq INTEGER PRIMARY KEY);
      CREATE TEMP TABLE IF NOT EXISTS bench_cap_changes(seq INTEGER PRIMARY KEY);
      DELETE FROM bench_next; DELETE FROM bench_models; DELETE FROM bench_caps; DELETE FROM bench_model_changes; DELETE FROM bench_cap_changes;`);
    const insert = stmt(`INSERT INTO bench_next VALUES(${Array(TURN_COLUMNS.length + 2).fill('?')})`);
    const model = stmt('INSERT INTO bench_models VALUES(?,?,?,?,?,?,?,?)'), cap = stmt('INSERT INTO bench_caps VALUES(?,?,?,?)');
    const retained = stmt('SELECT 1 FROM db_retained_turns WHERE provider=? AND root_turn_id=? LIMIT 1');
    const project = stmt(`INSERT INTO projects VALUES(?,?) ON CONFLICT(project_key) DO UPDATE SET project_name=excluded.project_name WHERE project_name<>excluded.project_name`);
    const session = stmt(`INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(provider,session_id) DO UPDATE SET session_name=excluded.session_name
      WHERE excluded.session_name IS NOT NULL AND session_name IS NOT excluded.session_name`);
    const addProject = stmt('INSERT OR IGNORE INTO db_replacement_projects VALUES(?)');
    const inputs = [];
    for (const row of replacement.summaries) {
      assert.ok(hasSession.get(row.provider, row.session_id));
      if (retained.get(row.provider, row.root_turn_id)) continue;
      const seq = inputs.length; inputs.push(row);
      project.run(row.project_key, row.project_name); session.run(row.provider, row.session_id, row.session_name?.trim() || null); addProject.run(row.project_key);
      insert.run(seq, Number(row.updated_at !== undefined), ...turnValues(row, now));
      // Reuse the exact product validators and price computation, while removing per-request TEMP resets and comparisons.
      for (const m of row.model_usage ?? []) {
        for (const key of ['input_tokens','output_tokens','cache_write_input_tokens','cache_read_input_tokens'])
          if (m[key] != null) assert.ok(Number.isSafeInteger(m[key]) && m[key] >= 0);
        assert.ok((m.cache_write_input_tokens ?? 0) + (m.cache_read_input_tokens ?? 0) <= m.input_tokens);
        model.run(seq, m.model, m.input_tokens, m.output_tokens, m.cache_write_input_tokens ?? null, m.cache_read_input_tokens ?? null, estimateCost(row.provider, m), PRICING_VERSION);
      }
      if (row.model_usage) for (const key of ['input_tokens','output_tokens','cache_write_input_tokens','cache_read_input_tokens'])
        assert.equal(row.model_usage.reduce((n, m) => n + (m[key] ?? 0), 0), row[key] ?? 0);
      for (const u of row.capability_usage ?? []) {
        assert.ok(Number.isSafeInteger(u.usage_count) && u.usage_count > 0 && u.name.length <= 512 && ['skill','subagent','plugin','model'].includes(u.category));
        cap.run(seq, u.category, u.name, u.usage_count);
      }
    }
    const joinKey = 't.provider=n.provider AND t.session_id=n.session_id AND t.root_turn_id=n.root_turn_id';
    if (replacement.preserveCapabilities) c.exec(`DELETE FROM bench_caps WHERE seq IN (SELECT n.seq FROM bench_next n JOIN turn_summary t ON ${joinKey});
      INSERT INTO bench_caps SELECT n.seq,u.category,u.name,u.usage_count FROM bench_next n JOIN turn_summary t ON ${joinKey} JOIN turn_capability_usage u ON u.turn_id=t.id;`);
    for (const [table, next, changed, columns] of [['turn_model_usage','bench_models','bench_model_changes',modelColumns], ['turn_capability_usage','bench_caps','bench_cap_changes',capColumns]]) {
      const previous = `SELECT n.seq,${columns.map(k => `u.${k}`)} FROM bench_next n JOIN turn_summary t ON ${joinKey} JOIN ${table} u ON u.turn_id=t.id`;
      const future = `SELECT seq,${columns} FROM ${next}`;
      c.exec(`INSERT OR IGNORE INTO ${changed} SELECT seq FROM (${previous} EXCEPT ${future});
        INSERT OR IGNORE INTO ${changed} SELECT seq FROM (${future} EXCEPT ${previous});`);
    }
    const mismatch = TURN_COLUMNS.filter(k => k !== 'updated_at').map(k => `t.${k} IS NOT n.${k}`).join(' OR ');
    const matches = stmt(`SELECT n.seq,t.id,t.project_key AS old_project,t.started_at_ms AS old_start,t.updated_at AS old_time,
      (t.id IS NULL OR ${mismatch} OR (n.explicit_time AND t.updated_at IS NOT n.updated_at)) AS changed,
      (t.id IS NULL OR mc.seq IS NOT NULL) AS models_changed,(t.id IS NULL OR cc.seq IS NOT NULL) AS caps_changed
      FROM bench_next n LEFT JOIN turn_summary t ON ${joinKey} LEFT JOIN bench_model_changes mc ON mc.seq=n.seq
      LEFT JOIN bench_cap_changes cc ON cc.seq=n.seq ORDER BY n.seq`).all();
    const addTurn = stmt(`INSERT INTO turn_summary(${TURN_COLUMNS}) VALUES(${TURN_COLUMNS.map(() => '?')})`);
    const update = stmt(`UPDATE turn_summary SET ${TURN_COLUMNS.map(k => `${k}=?`)} WHERE id=?`);
    const seen = stmt('INSERT INTO db_replacement_turns VALUES(?)');
    for (const match of matches) {
      const row = inputs[match.seq], changed = match.changed || match.models_changed || match.caps_changed;
      const values = turnValues(row, changed ? now : match.old_time ?? now);
      let id = match.id;
      if (changed) {
        if (id != null) { this.database.rollups.captureTurns('id=?', [id]); update.run(...values, id); }
        else id = addTurn.run(...values).lastInsertRowid;
        if (match.id == null || match.old_project !== row.project_key || match.old_start !== row.started_at_ms) this.database.rollups.captureTurns('id=?', [id]);
      }
      seen.run(id);
      for (const [changed, table, next, columns] of [[match.models_changed,'turn_model_usage','bench_models',modelColumns], [match.caps_changed,'turn_capability_usage','bench_caps',capColumns]]) if (changed) {
        stmt(`DELETE FROM ${table} WHERE turn_id=?`).run(id);
        stmt(`INSERT INTO ${table} SELECT ?,${columns} FROM ${next} WHERE seq=?`).run(id, match.seq);
      }
      this.saveSummaryCost(row, id);
    }
  };
}
function oracle(db) {
  const { buildUsageQuery } = require(join(root, 'dist/src/summary/db/queries'));
  const { compareResults } = require('./sql-rollup.cjs');
  for (const by of ['provider','model']) for (const group of ['total','month','session']) {
    const q = buildUsageQuery({}, group, timezone, by);
    compareResults(db.connection.prepare(q.sql).all(...q.values, 10000000, 0),
      db.queryUsagePage({}, group, timezone, { limit: 1000, offset: 0 }, by).rows, `write oracle ${by}/${group}`);
  }
}
async function runWrites(directory, options) {
  const variants = ['bulk','per-request','batch-join','hybrid-100'], results = [];
  for (const turns of options.writeTurns) {
    const paths = variants.map(v => join(directory, `writes-${turns}-${v}.sqlite`));
    const dbs = [new BulkDatabase(paths[0]), new IncrementalDatabase(paths[1]), new IncrementalDatabase(paths[2]), new IncrementalDatabase(paths[3])];
    installBatch(dbs[2]); installBatch(dbs[3]);
    const batchStore = dbs[3].sessions, bulkStore = new BulkSessionStore(dbs[3].sqlite, dbs[3].billing);
    dbs[3].replaceSessions = input => (input.summaries.length <= 100 ? bulkStore : batchStore).replaceSessions(input);
    try {
      const base = replacement(0, turns);
      const append = structuredClone(base); append.summaries.push(summary(0, turns));
      const move = structuredClone(base); move.summaries[0].started_at_ms += 366 * 86400000; move.summaries[0].completed_at_ms += 366 * 86400000;
      const deleted = structuredClone(base); deleted.summaries.shift();
      const all = structuredClone(base); all.summaries.forEach(v => { v.request_title += ' changed'; v.model_usage[0].model += '-new'; v.capability_usage = [{ category: 'skill', name: 'changed-skill', usage_count: 2 }]; });
      dbs.forEach(db => { db.replaceSessions(structuredClone(base)); db.queryUsagePage({}, 'total', timezone, { limit: 100, offset: 0 }, 'provider'); });
      for (const [scenario, input] of [['initial',base],['same',base],['append',append],['date-move',move],['delete',deleted],['all-changed',all]]) {
        const samples = dbs.map(() => []);
        for (let round = -options.warmup; round < options.samples; round++) for (const i of order(dbs.length, Math.abs(round))) {
          if (scenario === 'initial') dbs[i].replaceSessions({ sessions: base.sessions, files: [], summaries: [] });
          else dbs[i].replaceSessions(structuredClone(base));
          const value = write(dbs[i], input, paths[i]); if (round >= 0) samples[i].push(value);
        }
        const expected = state(dbs[0]); dbs.forEach(db => { assert.deepEqual(state(db), expected, `${turns}/${scenario}`); oracle(db); });
        results.push({ turnsPerSession: turns, scenario, hashes: expected, variants: Object.fromEntries(variants.map((v, i) => [v, {
          latency: stats(samples[i].map(v => v.elapsedMs)), samples: samples[i] }])) });
      }
      // Ensure child deletion, preservation, duplicate detection and validation all keep atomicity.
      for (const db of dbs) {
        db.replaceSessions(structuredClone(base));
        const preserved = structuredClone(base); preserved.preserveCapabilities = true; preserved.summaries.forEach(v => delete v.capability_usage);
        db.replaceSessions(preserved); assert.deepEqual(state(db), state(dbs[0]));
        const before = state(db), invalid = structuredClone(base); invalid.summaries.at(-1).input_tokens = -1;
        assert.throws(() => db.replaceSessions(invalid)); assert.deepEqual(state(db), before);
        const duplicate = structuredClone(base); duplicate.summaries.push(structuredClone(base.summaries[0]));
        assert.throws(() => db.replaceSessions(duplicate)); assert.deepEqual(state(db), before); integrity(db);
      }
      console.log(`Writes: ${turns} complete`);
    } finally { dbs.forEach(db => db.close()); }
  }
  return results;
}
module.exports = { runWrites, installBatch };
