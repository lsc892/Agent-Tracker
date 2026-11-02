// 저장 실험의 고정 합성 입력·결과 대조·반복 순서를 공유한다.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const Module = require('node:module');
const root = resolve(__dirname, '../..');
const productRoot = resolve(process.env.AGENT_TRACKER_BENCH_PRODUCT ?? root);
const timezone = 'Asia/Seoul';
function loadSnapshot(name, extra = '') {
  const filename = join(productRoot, `dist/src/summary/db/${name === 'sessions' ? 'sessions' : 'rollups'}.js`);
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(join(productRoot, 'dist/src/summary/db'));
  mod._compile(readFileSync(join(root, `tests/fixtures/storage-ab/incremental-${name}.js.txt`), 'utf8') + extra, filename);
  return mod.exports;
}
const { SessionStore, benchmark: incrementalHelpers } = loadSnapshot('sessions', '\nexports.benchmark = { turnValues, TURN_COLUMNS };');
const { UsageRollupStore } = loadSnapshot('rollups');
const { SummaryDatabase } = require(join(productRoot, 'dist/src/summary/db'));
class IncrementalDatabase extends SummaryDatabase {
  constructor(path) {
    super(path);
    this.sqlite.rollups = new UsageRollupStore(this.sqlite);
    this.sessions = new SessionStore(this.sqlite, this.billing);
  }
}
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, v) => typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(10)) : v);
const digest = value => sha(canonical(value));
const time = () => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: values };
}
function order(length, sample) {
  const indices = Array.from({ length }, (_, i) => (i + sample) % length);
  return sample % 2 ? indices.reverse() : indices;
}
function summary(sid, index) {
  const provider = sid % 2 ? 'codex' : 'claude';
  const input = 1000 + index % 1000, output = 100 + index % 100;
  const start = Date.UTC(2022, 0, 1) + ((sid * 197 + index % 90) % 1826) * 86400000 + index % 100 * 1000;
  const first = { model: `${provider}-model-${index % 3}`, input_tokens: input, output_tokens: output,
    cache_write_input_tokens: 100, cache_read_input_tokens: 200 };
  const models = [first];
  if (index % 5 === 0) {
    first.input_tokens -= 50; first.output_tokens -= 10;
    models.push({ model: `${provider}-helper`, input_tokens: 50, output_tokens: 10, cache_write_input_tokens: 0, cache_read_input_tokens: 0 });
  }
  return { provider, project_key: `/fixture/project-${Math.floor(sid / 2) % 20}`, project_name: `Project ${Math.floor(sid / 2) % 20}`,
    session_id: `session-${sid}`, session_name: `Session ${sid}`, root_turn_id: `request-${sid}-${index}`,
    request_title: `Request ${index}`, started_at_ms: start, completed_at_ms: start + 1000,
    duration_ms: 1000, duration_quality: 'exact', input_tokens: input, output_tokens: output,
    cache_write_input_tokens: 100, cache_read_input_tokens: 200, total_tokens: input + output,
    status: 'completed', updated_at: '2026-10-29T00:00:00.000Z', model_usage: models,
    capability_usage: index % 3 ? [] : [{ category: 'skill', name: 'fixture-skill', usage_count: 1 }] };
}
function replacement(sid, turns) {
  return { sessions: [{ provider: sid % 2 ? 'codex' : 'claude', session_id: `session-${sid}` }], files: [],
    summaries: Array.from({ length: turns }, (_, i) => summary(sid, i)) };
}
function seed(db, count, turns) {
  const c = db.connection;
  const project = c.prepare('INSERT OR IGNORE INTO projects VALUES (?,?)');
  const session = c.prepare('INSERT OR IGNORE INTO sessions VALUES (?,?,?)');
  const columns = ['provider','project_key','session_id','root_turn_id','request_title','started_at_ms','completed_at_ms',
    'duration_ms','duration_quality','input_tokens','output_tokens','cache_write_input_tokens','cache_read_input_tokens',
    'total_tokens','status','updated_at'];
  const insert = c.prepare(`INSERT INTO turn_summary(${columns}) VALUES(${columns.map(() => '?')})`);
  const model = c.prepare('INSERT INTO turn_model_usage VALUES(?,?,?,?,?,?,?,?)');
  const cap = c.prepare('INSERT INTO turn_capability_usage VALUES(?,?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const row = summary(Math.floor(i / turns), i % turns);
      project.run(row.project_key, row.project_name); session.run(row.provider, row.session_id, row.session_name);
      const id = insert.run(...columns.map(k => row[k])).lastInsertRowid;
      for (const m of row.model_usage) model.run(id, m.model, m.input_tokens, m.output_tokens,  m.cache_write_input_tokens, m.cache_read_input_tokens, null, 'fixture');
      for (const u of row.capability_usage) cap.run(id, u.category, u.name, u.usage_count);
    }
  });
  db.queryUsagePage({}, 'total', timezone, { limit: 100, offset: 0 }, 'provider');
}
function state(db) {
  const c = db.connection;
  const queries = {
    turns: `SELECT provider,project_key,session_id,root_turn_id,request_title,started_at_ms,completed_at_ms,duration_ms,duration_quality,
      input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens,total_tokens,status,quality_flags,diagnostic_file_id,diagnostic_offset,last_error
      FROM turn_summary ORDER BY provider,session_id,root_turn_id`,
    models: `SELECT t.provider,t.session_id,t.root_turn_id,u.model,u.input_tokens,u.output_tokens,u.cache_write_input_tokens,u.cache_read_input_tokens,
      u.estimated_cost_usd,u.pricing_version FROM turn_model_usage u JOIN turn_summary t ON t.id=u.turn_id ORDER BY t.provider,t.session_id,t.root_turn_id,u.model`,
    capabilities: `SELECT t.provider,t.session_id,t.root_turn_id,u.category,u.name,u.usage_count FROM turn_capability_usage u JOIN turn_summary t ON t.id=u.turn_id
      ORDER BY t.provider,t.session_id,t.root_turn_id,u.category,u.name`,
    costs: `SELECT t.provider,t.session_id,t.root_turn_id,c.billing_mode,c.cost_usd,c.unknown_costs,c.pricing_version FROM turn_costs c JOIN turn_summary t ON t.id=c.turn_id
      ORDER BY t.provider,t.session_id,t.root_turn_id`,
  };
  for (const table of ['usage_request_daily', 'usage_model_daily']) {
    const columns = c.prepare(`PRAGMA table_info(${table})`).all().map(v => v.name).filter(v => v !== 'local_month' && v !== 'last_successful_update');
    queries[table] = `SELECT ${columns} FROM ${table} ORDER BY provider,session_id,project_key,local_day${table.includes('model') ? ',model_key' : ''}`;
  }
  return Object.fromEntries(Object.entries(queries).map(([key, sql]) => [key, digest(c.prepare(sql).all())]));
}
function integrity(db) {
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(Object.values(db.connection.prepare('PRAGMA integrity_check').get())[0], 'ok');
}
function write(db, input, path) {
  db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const before = performance.now(); db.replaceSessions(structuredClone(input));
  return { elapsedMs: performance.now() - before, walBytes: statSync(`${path}-wal`).size };
}
function fingerprint(paths) { return Object.fromEntries(paths.map(p => [p.replaceAll('\\', '/'), sha(readFileSync(p))])); }
module.exports = { assert, root, productRoot, timezone, IncrementalDatabase, incrementalHelpers, sha, digest, canonical, time, stats, order, summary, replacement, seed, state, integrity, write, fingerprint };
