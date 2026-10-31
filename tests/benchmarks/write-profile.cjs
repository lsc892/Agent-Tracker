// 통계 진입의 스캔·파싱·저장·첫 조회와 INSERT/UPDATE SQL 비용을 사본에서 측정한다.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { mkdtemp, mkdir, rm, truncate, utimes, writeFile } = require('node:fs/promises');
const { cpus, tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync, backup } = require('node:sqlite');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const { SummaryStaging } = require('../../dist/src/summary/staging');
const { refreshSummary } = require('../../dist/src/summary/scanner');
const reader = require('../../dist/src/summary/jsonl');
const { makeSnapshot, chooseTarget, inspectCodexTarget, appendRows, claudeRows, codexAppendRows } = require('./incremental-refresh.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul';
const sha = value => createHash('sha256').update(value).digest('hex');
const detailInitialOnly = process.argv.includes('--detail-initial-only');
const samples = detailInitialOnly ? 0 : 3;
const mainTables = new Set(['manifest', 'projects', 'sessions', 'turn_summary', 'turn_model_usage',
  'turn_capability_usage', 'turn_costs', 'session_billing', 'usage_request_daily', 'usage_model_daily', 'usage_rollup_meta']);
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: values };
};
const time = () => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());

function fingerprint() {
  const files = [__filename, join(__dirname, 'incremental-refresh.cjs')];
  for (const base of ['src/summary', 'dist/src/summary']) {
    for (const file of fs.readdirSync(join(root, base), { recursive: true })) {
      if (/\.(ts|js)$/.test(file)) files.push(join(root, base, file));
    }
  }
  return Object.fromEntries(files.sort().map(file => [require('node:path').relative(root, file).replaceAll('\\', '/'), sha(fs.readFileSync(file))]));
}

function inventory(db) {
  const c = db.connection;
  return { ...c.prepare(`SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens,
      count(DISTINCT project_key) projects FROM turn_summary`).get(),
    sessions: c.prepare('SELECT count(*) n FROM sessions').get().n,
    sourceFiles: c.prepare('SELECT count(*) n FROM manifest').get().n,
    models: c.prepare('SELECT count(*) n FROM turn_model_usage').get().n,
    requestDaily: c.prepare('SELECT count(*) n FROM usage_request_daily').get().n,
    modelDaily: c.prepare('SELECT count(*) n FROM usage_model_daily').get().n };
}

function factsHash(db) {
  const h = createHash('sha256');
  for (const [table, sql] of [
    ['requests', 'SELECT * FROM turn_summary ORDER BY provider,session_id,root_turn_id'],
    ...['turn_model_usage', 'turn_capability_usage', 'turn_costs'].map(table => [table,
      `SELECT t.provider,t.session_id,t.root_turn_id,u.* FROM turn_summary t JOIN ${table} u ON u.turn_id=t.id ORDER BY t.provider,t.session_id,t.root_turn_id${table === 'turn_model_usage' ? ',u.model' : table === 'turn_capability_usage' ? ',u.category,u.name' : ''}`]),
  ]) {
    h.update(table);
    for (const row of db.connection.prepare(sql).iterate()) {
      for (const key of ['id', 'turn_id', 'updated_at', 'diagnostic_file_id']) delete row[key];
      h.update(JSON.stringify(row));
    }
  }
  return h.digest('hex');
}

function sqlKind(sql) {
  const text = sql.trim();
  const multiple = /;\s*\S/.test(text.replace(/;\s*$/, ''));
  let operation = /^([A-Z]+)/i.exec(text)?.[1].toUpperCase() ?? 'OTHER';
  const table = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|DELETE\s+FROM|UPDATE)\s+([a-z_]+)/i.exec(text)?.[1] ?? null;
  if (multiple) operation = 'BATCH';
  else if (operation === 'INSERT' && /ON\s+CONFLICT[\s\S]+DO\s+UPDATE/i.test(text)) operation = 'UPSERT';
  else if (operation === 'INSERT' && /INSERT\s+OR\s+REPLACE/i.test(text)) operation = 'INSERT_OR_REPLACE';
  else if (operation === 'INSERT' && /INSERT\s+OR\s+IGNORE/i.test(text)) operation = 'INSERT_OR_IGNORE';
  return { operation, table, storage: table ? mainTables.has(table) ? 'main' : 'temp' : 'other' };
}

function observe(db, detailed) {
  const c = db.connection, originalExec = c.exec, originalPrepare = c.prepare;
  const originalReplace = db.replaceSessions, originalNormalize = SummaryStaging.prototype.prepareSummaries;
  const originalRead = reader.readJsonl, rollups = db.sqlite.rollups;
  const originalRebuild = rollups.rebuild, originalRefresh = rollups.refreshChangedSessions;
  const totalChanges = originalPrepare.call(c, 'SELECT total_changes() n');
  const lastChanges = originalPrepare.call(c, 'SELECT changes() n');
  const changesBefore = totalChanges.get().n;
  const statements = new Map(), originalMethods = new WeakMap();
  const data = { readParseMs: 0, normalizeMs: 0, storeMs: 0, storeCalls: 0, rollupRebuildMs: 0,
    rollupMaintenanceMs: 0, beginMs: 0, commitMs: 0, commits: 0, transactionMs: 0, transactionByPhase: {},
    sqlPrepareMs: 0, sqlExecuteMs: 0, directPersistentWritesMs: 0, directTempWritesMs: 0 };
  let phase = 'setup', begun, active = true;
  const record = (sql, method, elapsed, rows, changed) => {
    let item = statements.get(sql);
    if (!item) {
      item = { sql, ...sqlKind(sql), calls: 0, prepareCalls: 0, prepareMs: 0, executeMs: 0,
        maxCallMs: 0, directChangedRows: 0, directChangesMeasuredCalls: 0, returnedRows: 0, phases: {} };
      statements.set(sql, item);
    }
    if (method === 'prepare') { item.prepareCalls++; item.prepareMs += elapsed; data.sqlPrepareMs += elapsed; return; }
    item.calls++; item.executeMs += elapsed; item.maxCallMs = Math.max(item.maxCallMs, elapsed);
    item.returnedRows += rows; item.directChangedRows += changed ?? 0;
    if (changed !== undefined) item.directChangesMeasuredCalls++;
    const group = item.phases[phase] ??= { calls: 0, executeMs: 0, directChangedRows: 0 };
    group.calls++; group.executeMs += elapsed; group.directChangedRows += changed ?? 0;
    data.sqlExecuteMs += elapsed;
    if (['INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'INSERT_OR_REPLACE', 'INSERT_OR_IGNORE'].includes(item.operation)) {
      if (item.storage === 'main') data.directPersistentWritesMs += elapsed;
      if (item.storage === 'temp') data.directTempWritesMs += elapsed;
    }
  };
  const wrap = (stmt, sql) => {
    if (originalMethods.has(stmt)) return stmt;
    const saved = { run: stmt.run, get: stmt.get, all: stmt.all, iterate: stmt.iterate };
    originalMethods.set(stmt, saved);
    for (const method of ['run', 'get', 'all']) {
      const original = saved[method];
      stmt[method] = function(...args) {
        if (!active) return original.apply(this, args);
        const start = performance.now(), result = original.apply(this, args), elapsed = performance.now() - start;
        const dml = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
        record(sql, method, elapsed, method === 'all' ? result.length : method === 'get' && result ? 1 : 0,
          method === 'run' ? Number(result.changes) : dml ? lastChanges.get().n : undefined);
        return result;
      };
    }
    const original = saved.iterate;
    stmt.iterate = function*(...args) {
      if (!active) return yield* original.apply(this, args);
      const start = performance.now(), iterator = original.apply(this, args);
      let elapsed = performance.now() - start, count = 0;
      try {
        while (true) {
          const step = performance.now(), value = iterator.next();
          elapsed += performance.now() - step;
          if (value.done) break;
          count++; yield value.value;
        }
      } finally {
        const step = performance.now(); iterator.return?.(); elapsed += performance.now() - step;
        record(sql, 'iterate', elapsed, count);
      }
    };
    return stmt;
  };
  if (detailed) {
    for (const [sql, stmt] of db.sqlite.statements) wrap(stmt, sql);
    c.prepare = function(sql) {
      const start = performance.now(), stmt = originalPrepare.call(this, sql);
      record(sql, 'prepare', performance.now() - start, 0);
      return wrap(stmt, sql);
    };
  }
  c.exec = function(sql) {
    const start = performance.now(), result = originalExec.call(this, sql), end = performance.now();
    const text = sql.trim();
    if (/^BEGIN\b/i.test(text)) { begun = { start, phase }; data.beginMs += end - start; }
    if (text === 'COMMIT') {
      data.commitMs += end - start; data.commits++;
      if (begun) {
        const group = data.transactionByPhase[begun.phase] ??= { count: 0, elapsedMs: 0, commitMs: 0, maxMs: 0 };
        group.count++; group.elapsedMs += end - begun.start; group.commitMs += end - start;
        group.maxMs = Math.max(group.maxMs, end - begun.start);
        data.transactionMs += end - begun.start; begun = undefined;
      }
    }
    if (text === 'ROLLBACK') begun = undefined;
    if (detailed) {
      const kind = sqlKind(sql);
      record(sql, 'exec', end - start, 0, ['INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'INSERT_OR_REPLACE', 'INSERT_OR_IGNORE'].includes(kind.operation) ? lastChanges.get().n : undefined);
    }
    return result;
  };
  db.replaceSessions = function(...args) {
    const start = performance.now(); data.storeCalls++;
    try { return originalReplace.apply(this, args); } finally { data.storeMs += performance.now() - start; }
  };
  SummaryStaging.prototype.prepareSummaries = function(...args) {
    const start = performance.now();
    try { return originalNormalize.apply(this, args); } finally { data.normalizeMs += performance.now() - start; }
  };
  reader.readJsonl = async function(...args) {
    const start = performance.now();
    try { return await originalRead.apply(this, args); } finally { data.readParseMs += performance.now() - start; }
  };
  rollups.rebuild = function(...args) {
    const start = performance.now();
    try { return originalRebuild.apply(this, args); } finally { data.rollupRebuildMs += performance.now() - start; }
  };
  rollups.refreshChangedSessions = function(...args) {
    const start = performance.now();
    try { return originalRefresh.apply(this, args); } finally { data.rollupMaintenanceMs += performance.now() - start; }
  };
  return { data, setPhase(value) { phase = value; }, restore() {
    active = false;
    data.engineChangedRowsIncludingTempAndCascades = totalChanges.get().n - changesBefore;
    if (detailed) data.statements = [...statements.values()].sort((a, b) => b.executeMs - a.executeMs);
    // 일회성 statement는 보관하지 않는다. 제품의 고정 캐시만 원래 메서드로 복원한다.
    for (const stmt of db.sqlite.statements.values()) {
      const saved = originalMethods.get(stmt);
      if (saved) for (const [method, original] of Object.entries(saved)) stmt[method] = original;
    }
    c.exec = originalExec; c.prepare = originalPrepare; db.replaceSessions = originalReplace;
    SummaryStaging.prototype.prepareSummaries = originalNormalize; reader.readJsonl = originalRead;
    rollups.rebuild = originalRebuild; rollups.refreshChangedSessions = originalRefresh;
  } };
}

async function enter(path, snapshot, detailed) {
  const openStart = performance.now(), db = new SummaryDatabase(path), openMs = performance.now() - openStart;
  const meter = observe(db, detailed), phases = {};
  let phase = 'setup', phaseStart = performance.now(), result, refreshMs, queryMs;
  try {
    const start = performance.now();
    result = await refreshSummary(db, { dbPath: path, roots: snapshot.roots, timezone }, undefined, p => {
      if (p.phase !== phase) {
        const now = performance.now(); phases[phase] = (phases[phase] ?? 0) + now - phaseStart;
        phase = p.phase; phaseStart = now; meter.setPhase(phase);
      }
    });
    refreshMs = performance.now() - start;
    assert.equal(result.interrupted, false, `Refresh interrupted (${result.error})`);
    if (snapshot.expected) assert.equal(result.failed, 0);
    meter.setPhase('first-query');
    const queryStart = performance.now();
    db.queryUsagePage({ providers: ['claude', 'codex'], excludeEmptyUsage: true }, 'day', timezone,
      { limit: 100, tableSort: { key: 'period', direction: 'desc' } }, 'provider');
    db.diagnostics({ providers: ['claude', 'codex'], limit: 1 });
    queryMs = performance.now() - queryStart;
  } catch (error) { meter.restore(); db.close(); throw error; }
  meter.restore();
  return { db, sample: { openMs, refreshMs, firstQueryMs: queryMs, readyMs: openMs + refreshMs + queryMs,
    ...meter.data, phases, parsed: result.parsed, reused: result.reused, failed: result.failed,
    discovered: result.discovered, bodyBytes: result.bodyBytes } };
}

async function runScenario(directory, snapshot, label, base, mutate, saveReady) {
  const baseline = [], summary = { name: label, samples: baseline };
  let expectedHash;
  for (let round = 0; round <= samples; round++) {
    const diagnostic = round === samples, path = join(directory, `${label}-${round}.sqlite`);
    if (base) await backup(base, path);
    const restore = mutate ? await mutate() : async () => {};
    let db;
    try {
      const trial = await enter(path, snapshot, diagnostic); db = trial.db;
      const counts = inventory(db), digest = factsHash(db);
      expectedHash ??= digest; assert.equal(digest, expectedHash, `${label}: output changed between repetitions`);
      if (label === 'unchanged') { assert.equal(trial.sample.bodyBytes, 0); assert.equal(trial.sample.storeCalls, 0); }
      if (label === 'initial' && snapshot.expected) {
        assert.equal(counts.requests, snapshot.expected.requests); assert.equal(counts.tokens, snapshot.expected.tokens);
      }
      assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      if (saveReady && round === 0) await backup(db.connection, saveReady);
      if (diagnostic) summary.diagnostic = { ...trial.sample, counts };
      else baseline.push(trial.sample);
      summary.counts = counts;
      console.log(`${time()} ${label} ${diagnostic ? 'SQL detail' : round + 1}: refresh=${trial.sample.refreshMs.toFixed(1)} ms, store=${trial.sample.storeMs.toFixed(1)} ms, firstQuery=${trial.sample.firstQueryMs.toFixed(1)} ms, parsed=${trial.sample.parsed}, failed=${trial.sample.failed}`);
    } finally { db?.close(); await restore(); }
    await new Promise(resolve => setImmediate(resolve));
  }
  summary.resultSha256 = expectedHash;
  summary.timing = baseline.length ? Object.fromEntries(['openMs', 'refreshMs', 'firstQueryMs', 'readyMs', 'readParseMs', 'normalizeMs',
    'storeMs', 'rollupRebuildMs', 'rollupMaintenanceMs', 'beginMs', 'commitMs', 'transactionMs'].map(key => [key, stats(baseline.map(s => s[key]))]))
    : null;
  return summary;
}

async function main() {
  const output = resolve(process.argv[2] ?? 'tests/results/benchmarks/write-profile.json');
  assert.ok(!fs.existsSync(output), 'Use a new output path to preserve existing measurements');
  const smoke = process.argv.includes('--smoke'), noReal = process.argv.includes('--no-real');
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-write-profile-'));
  const sourceSha256 = fingerprint();
  const report = { startedSeoul: time(), environment: { node: process.version, sqlite: process.versions.sqlite,
    cpu: cpus()[0]?.model, platform: process.platform }, sourceSha256,
    method: { samples, timezone, cacheKiB: 4096, tempStore: 'FILE',
      timing: detailInitialOnly ? 'One initial-entry SQL diagnostic trial only, with weak statement bookkeeping; no baseline timing samples.'
        : 'Three trials with light phase/transaction timers; one separate SQL diagnostic trial excluded from medians.',
      entry: 'New DB connection + actual refreshSummary + default day/provider page and coverage. No worker startup/IPC or webview rendering. Resident worker entry excludes openMs.',
      overlap: 'readParseMs includes parser callback/TEMP writes; storeMs includes JS, reads, writes, rollup maintenance and COMMIT; these are nested timings, not additive phases.',
      sql: 'Execution includes engine work and JS SQL UDF callbacks. Compile time separate. Iterator timings include next()/return() calls, not consumer JS. UPSERT can insert/update; direct changes exclude FK cascades. Multi-statement exec is reported as BATCH without artificial per-statement timing.',
      data: 'Frozen local logs and names metadata; mutations only inside temporary copy. Synthetic inputs use actual Claude/Codex parsers. No installed DB/log mutation or account/network calls.',
      cache: 'OS cache/background load uncontrolled; no checkpoint inside measured entry.' }, datasets: [] };
  const save = async () => { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
  try {
    const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7);
    const definitions = [...(!noReal && !smoke ? [{ label: 'local-logs', real: true, requests: 0 }] : []),
      ...(smoke ? [{ label: 'synthetic-300', requests: 300, turns: 10 }]
        : [{ label: 'synthetic-10000', requests: 10000, turns: 100 }, { label: 'synthetic-100000', requests: 100000, turns: 100 }])]
      .filter(definition => !only || definition.label === only);
    assert.ok(definitions.length, 'No dataset selected');
    for (const definition of definitions) {
      const work = join(directory, definition.label); await mkdir(work);
      console.log(`${time()} Freeze ${definition.label}`);
      const snapshot = await makeSnapshot(work, { after: root, real: !!definition.real, requests: definition.requests,
        'turns-per-session': definition.turns });
      const data = { label: definition.label, input: { files: snapshot.files.length,
        bytes: snapshot.files.reduce((n, f) => n + f.bytes, 0), sha256: snapshot.sha256,
        expected: snapshot.expected ?? null, byRoot: snapshot.inventory }, scenarios: [] };
      report.datasets.push(data); await save();
      const basePath = join(work, 'ready.sqlite');
      data.scenarios.push(await runScenario(work, snapshot, 'initial', null, null, detailInitialOnly ? undefined : basePath)); await save();
      if (detailInitialOnly) continue;
      const base = new DatabaseSync(basePath, { readOnly: true });
      try {
        data.scenarios.push(await runScenario(work, snapshot, 'unchanged', base)); await save();
        // Selection reads the ready DB without importing real identifiers into the report.
        for (const provider of definition.real ? ['codex', 'claude'] : ['codex']) {
          const view = { connection: base }, target = chooseTarget(view, provider, directory);
          if (provider === 'codex') await inspectCodexTarget(target, root);
          for (const kind of provider === 'codex' ? ['append', 'existing-request'] : ['append']) {
            const mutate = async () => {
              const selected = structuredClone(target);
              let rows;
              if (provider === 'claude') {
                rows = claudeRows(selected.session_id);
                rows[0].cwd = base.prepare('SELECT project_key FROM turn_summary WHERE provider=? AND session_id=? LIMIT 1').get(provider, selected.session_id).project_key;
              } else {
                const existing = kind === 'existing-request' ? base.prepare('SELECT root_turn_id FROM turn_summary WHERE provider=? AND session_id=? ORDER BY id DESC LIMIT 1').get(provider, selected.session_id).root_turn_id : 'write-profile-new-request';
                rows = codexAppendRows(selected, existing, 'write-profile-new-response', kind === 'existing-request' ? 19 : 123);
              }
              await appendRows(selected, rows, directory, 23);
              return async () => { await truncate(selected.path, selected.originalBytes); await utimes(selected.path, selected.originalAtime, selected.originalMtime); };
            };
            const result = await runScenario(work, snapshot, `${provider}-${kind}`, base, mutate);
            const initial = data.scenarios[0].counts;
            assert.equal(result.counts.requests, initial.requests + (kind === 'append' ? 1 : 0));
            assert.equal(result.counts.tokens, initial.tokens + (kind === 'existing-request' ? 26 : 130));
            data.scenarios.push(result); await save();
          }
        }
      } finally { base.close(); }
      assert.deepEqual(fingerprint(), sourceSha256, 'Measured source changed during profiling');
    }
    report.completedSeoul = time(); await save(); console.log(`Saved ${output}`);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('agent-tracker-write-profile-'));
    await rm(directory, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
