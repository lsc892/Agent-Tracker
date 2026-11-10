// 묶음 말미의 세션 집합 rollup이 최종 facts·원자성·실패 격리를 보존하는지 직접 검증한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { verifyAggregates } = require('./transaction-batch-validation.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul';
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => typeof item === 'number' && !Number.isInteger(item)
  ? Number(item.toPrecision(12)) : item);
const normalize = row => Object.fromEntries(Object.keys(row).sort().filter(key => !['id', 'turn_id', 'updated_at',
  'last_successful_update', 'recorded_at', 'last_seen_scan_id'].includes(key)).map(key => [key, row[key]]));
const sorted = rows => rows.map(normalize).sort((a, b) => canonical(a).localeCompare(canonical(b)));

function load(directory) {
  return { directory, Database: require(join(directory, 'dist/src/summary/db')).SummaryDatabase,
    Profiler: require(join(directory, 'dist/src/summary/profiling')).StageProfiler,
    refresh: require(join(directory, 'dist/src/summary/scanner')).refreshSummary,
    raw: require(join(directory, 'dist/src/summary/db/queries')).buildUsageQuery };
}

function row(session, id = 'request', extra = {}) {
  return { provider: 'claude', session_id: session, root_turn_id: id, project_key: '/fixture/project', project_name: 'Fixture',
    session_name: 'Fixture', started_at_ms: Date.UTC(2026, 10, 1, 16), duration_ms: 1000, duration_quality: 'exact',
    input_tokens: 10, output_tokens: 2, total_tokens: 12, cache_write_input_tokens: 0, cache_read_input_tokens: 0,
    status: 'completed', updated_at: '2026-11-10T00:00:00.000Z', hasMain: true,
    model_usage: [{ model: 'claude-sonnet-4-6', input_tokens: 10, output_tokens: 2,
      cache_write_input_tokens: 0, cache_read_input_tokens: 0 }], capability_usage: [], ...extra };
}

function replacement(rows, extra = {}) {
  return { scanId: 'fixture', sessions: [...new Map(rows.map(item => [canonical([item.provider, item.session_id]),
    { provider: item.provider, session_id: item.session_id }])).values()], summaries: rows, files: [], ...extra };
}

function tableSnapshot(db) {
  return canonical(db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => [name, sorted(db.connection.prepare(`SELECT * FROM ${name}`).all())]));
}

function fullExactSnapshot(db) {
  return canonical(db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => [name, db.connection.prepare(`SELECT * FROM ${name}`).all().sort((a, b) => canonical(a).localeCompare(canonical(b)))]));
}

function activate(db, zone = timezone) { db.queryUsagePage({}, 'day', zone, { limit: 100 }); }
function integrity(db) {
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
}

function observeRollups(db) {
  const prepare = db.connection.prepare, traces = [];
  db.connection.prepare = function(sql) {
    const statement = Reflect.apply(prepare, this, [sql]);
    if (/^\s*(?:INSERT\s+INTO|DELETE\s+FROM)\s+usage_(?:request|model)_daily\b/i.test(sql)) {
      const run = statement.run;
      statement.run = function(...args) { traces.push({ sql, args }); return Reflect.apply(run, this, args); };
    }
    return statement;
  };
  return { traces, reset: () => { traces.length = 0; } };
}

function statementCounts(traces) {
  const counts = {};
  for (const trace of traces) {
    const operation = /^\s*(INSERT|DELETE)/i.exec(trace.sql)[1].toUpperCase();
    const table = /usage_(?:request|model)_daily/.exec(trace.sql)[0], key = `${operation} ${table}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function pairedDatabases(apis, action) {
  const dbs = Object.fromEntries(Object.entries(apis).map(([key, api]) => [key, new api.Database(':memory:')]));
  const probes = Object.fromEntries(Object.entries(dbs).map(([key, db]) => [key, observeRollups(db)]));
  try { return action(dbs, probes); } finally { for (const db of Object.values(dbs)) db.close(); }
}

function repeatedSessions(apis) {
  return pairedDatabases(apis, (dbs, probes) => {
    const tricky = 'same:|\"[]?session', other = row(tricky, 'other-provider', { provider: 'codex' });
    const seed = [row(tricky), row('to-delete'), row('unchanged'), other,
      row('quote\'[,]?', 'separator'), row('nested:[\"claude\",\"x\"]', 'nested')];
    for (const db of Object.values(dbs)) { db.replaceMemory(replacement(seed)); activate(db); }
    const moved = row(tricky, 'final', { project_key: '/fixture/moved', project_name: 'Moved', started_at_ms: null,
      duration_ms: null, duration_quality: 'derived', input_tokens: 30, output_tokens: 3, total_tokens: 33,
      cache_write_input_tokens: null, cache_read_input_tokens: null,
      model_usage: [{ model: 'A', input_tokens: 10, output_tokens: 1, cache_write_input_tokens: null, cache_read_input_tokens: null },
        { model: 'B', input_tokens: 20, output_tokens: 2, cache_write_input_tokens: 0, cache_read_input_tokens: 0 }] });
    const replacements = [replacement([row(tricky, 'middle', { started_at_ms: Date.UTC(2026, 10, 3, 16) })]),
      replacement([], { sessions: [{ provider: 'claude', session_id: 'to-delete' }] }), replacement([moved])];
    for (const probe of Object.values(probes)) probe.reset();
    const profiles = Object.fromEntries(Object.entries(apis).map(([key, api]) => [key, new api.Profiler()]));
    for (const variant of ['A', 'B']) dbs[variant].replaceMemoryBatch(replacements, profiles[variant]);
    const counts = Object.fromEntries(Object.entries(probes).map(([key, probe]) => [key, statementCounts(probe.traces)]));
    for (const table of ['usage_request_daily', 'usage_model_daily']) {
      assert.equal(counts.A[`DELETE ${table}`], 3); assert.equal(counts.A[`INSERT ${table}`], 3);
      assert.equal(counts.B[`DELETE ${table}`], 1); assert.equal(counts.B[`INSERT ${table}`], 1);
    }
    const final = [...seed.filter(item => item.session_id !== tricky && item.session_id !== 'to-delete'), other, moved];
    let checks = 0;
    for (const [variant, db] of Object.entries(dbs)) { checks += verifyAggregates(db, apis[variant], final); integrity(db); }
    assert.equal(tableSnapshot(dbs.A), tableSnapshot(dbs.B));
    assert.equal(dbs.B.queryTurns({ provider: 'codex', sessionId: tricky })[0].total_tokens, 12);
    const plans = probes.B.traces.map(trace => ({ operation: /^\s*(\w+)/.exec(trace.sql)[1],
      table: /usage_(?:request|model)_daily/.exec(trace.sql)[0],
      plan: dbs.B.connection.prepare(`EXPLAIN QUERY PLAN ${trace.sql}`).all(...trace.args).map(item => item.detail) }));
    assert.ok(plans.every(item => item.plan.some(detail => /SEARCH .*USING (?:PRIMARY KEY|(?:COVERING )?INDEX)/.test(detail))),
      'Session-set statements must expose bounded index/primary-key searches');
    for (const probe of Object.values(probes)) probe.reset();
    for (const variant of ['A', 'B']) dbs[variant].replaceMemoryBatch([replacement([moved]), replacement([moved])]);
    assert.equal(probes.A.traces.length, 0); assert.equal(probes.B.traces.length, 0);
    for (const probe of Object.values(probes)) probe.reset();
    const single = replacement([row('single')]);
    for (const variant of ['A', 'B']) dbs[variant].replaceMemory(single);
    assert.deepEqual(statementCounts(probes.A.traces), statementCounts(probes.B.traces));
    assert.equal(tableSnapshot(dbs.A), tableSnapshot(dbs.B));
    return { repeatedSessionChanges: 3, uniqueChangedSessions: 2, counts, independentAggregateChecks: checks,
      separatorAndQuotedSessionIds: true, sameSessionIdOtherProviderPreserved: true, noChangeRollupStatements: 0,
      singleReplacementUnchanged: true, plans };
  });
}

function metadataAndCalendar(apis) {
  const results = [];
  for (const mode of ['inactive', 'format-mismatch', 'different-timezone', 'final-unsupported', 'transient-unsupported']) {
    results.push(pairedDatabases(apis, (dbs, probes) => {
      const seed = row('meta'), good = row('meta', 'final', { started_at_ms: Date.UTC(2026, 10, 9, 16) });
      const unsupported = row('meta', 'outside-calendar', { started_at_ms: Date.UTC(12000, 1, 1) });
      for (const db of Object.values(dbs)) {
        db.replaceMemory(replacement([seed]));
        if (mode !== 'inactive') activate(db, mode === 'different-timezone' ? 'America/New_York' : timezone);
        if (mode === 'format-mismatch') db.connection.exec('UPDATE usage_rollup_meta SET format_version=999');
      }
      for (const probe of Object.values(probes)) probe.reset();
      const changes = mode === 'transient-unsupported' ? [replacement([unsupported]), replacement([good])]
        : [replacement([mode === 'final-unsupported' ? unsupported : good]), replacement([row('extra')])];
      for (const variant of ['A', 'B']) dbs[variant].replaceMemoryBatch(changes);
      const beforeRead = Object.fromEntries(Object.entries(dbs).map(([key, db]) => [key,
        { meta: db.connection.prepare('SELECT * FROM usage_rollup_meta').all(),
          daily: db.connection.prepare('SELECT count(*) n FROM usage_request_daily').get().n,
          rollupStatements: probes[key].traces.length }]));
      if (['inactive', 'format-mismatch'].includes(mode)) for (const probe of Object.values(probes)) assert.equal(probe.traces.length, 0);
      if (mode === 'final-unsupported') for (const db of Object.values(dbs)) {
        assert.equal(db.connection.prepare('SELECT count(*) n FROM usage_rollup_meta').get().n, 0);
        assert.equal(db.connection.prepare('SELECT count(*) n FROM usage_request_daily').get().n, 0);
      }
      if (mode === 'transient-unsupported') {
        assert.equal(beforeRead.A.meta.length, 0); assert.equal(beforeRead.B.meta.length, 1);
      }
      const finalRows = mode === 'transient-unsupported' ? [good] : [mode === 'final-unsupported' ? unsupported : good, row('extra')];
      if (mode === 'final-unsupported') {
        for (const variant of ['A', 'B']) for (const by of ['provider', 'model']) for (const group of ['total', 'day', 'month', 'session', 'project']) {
          const actual = dbs[variant].queryUsage({}, group, timezone, { limit: 1000 }, by);
          const query = apis[variant].raw({}, group, timezone, by);
          assert.equal(canonical(sorted(actual)), canonical(sorted(dbs[variant].connection.prepare(query.sql).all(...query.values, 1000, 0))));
        }
      } else for (const variant of ['A', 'B']) verifyAggregates(dbs[variant], apis[variant], finalRows,
        mode === 'different-timezone' ? 'America/New_York' : timezone);
      if (mode === 'different-timezone') for (const variant of ['A', 'B']) verifyAggregates(dbs[variant], apis[variant], finalRows, timezone);
      assert.equal(tableSnapshot(dbs.A), tableSnapshot(dbs.B), `Final public-read state/${mode}`);
      for (const db of Object.values(dbs)) integrity(db);
      return { mode, beforeRead, afterPublicReadEquivalent: true,
        transientCacheDifference: mode === 'transient-unsupported' ? 'A clears on intermediate unsupported facts; B materializes supported final facts. A lazy rebuild converges.' : null };
    }));
  }
  return results;
}

function retainedAndRemoved(apis) {
  return pairedDatabases(apis, dbs => {
    const file = (id, session) => ({ id, provider: 'claude', session_id: session, source_root: '/fixture/logs',
      path: `/fixture/logs/${id}.jsonl`, size_bytes: 100, mtime_ms: 1, dev: null, inode: null, parser_version: 17 });
    const retained = row('retained', 'kept', { diagnostic_file_id: 101 }), deleted = row('deleted', 'old', { diagnostic_file_id: 102 });
    for (const db of Object.values(dbs)) {
      db.replaceMemory(replacement([retained, deleted], { files: [file(101, 'retained'), file(102, 'deleted')] })); activate(db);
    }
    const changes = [replacement([row('deleted', 'middle', { diagnostic_file_id: 102, project_key: '/fixture/middle' })]),
      replacement([], { sessions: [{ provider: 'claude', session_id: 'retained' }], removedFileIds: [101], retainDeletedSourceUsage: true }),
      replacement([], { sessions: [{ provider: 'claude', session_id: 'deleted' }], removedFileIds: [102] })];
    for (const variant of ['A', 'B']) dbs[variant].replaceMemoryBatch(changes);
    assert.equal(tableSnapshot(dbs.A), tableSnapshot(dbs.B));
    for (const [variant, db] of Object.entries(dbs)) {
      assert.equal(db.queryTurnsCount(), 1); assert.equal(db.findManifest('claude', '/fixture/logs/101.jsonl').source_missing, 1);
      verifyAggregates(db, apis[variant], [retained]); integrity(db);
    }
    return { intermediateProjectContributionRemoved: true, positiveKnownUsageRetained: true, finalDeletedSessionHasNoDailyRows: true };
  });
}

async function rollupFailureAtomicity(api, directory) {
  const path = join(directory, 'atomic.sqlite'), db = new api.Database(path); let reader;
  try {
    db.replaceMemory(replacement([row('existing')])); activate(db); reader = new DatabaseSync(path, { readOnly: true });
    const observed = [];
    db.connection.function('rollup_reader_probe', () => {
      observed.push([reader.prepare('SELECT count(*) n FROM turn_summary').get().n,
        reader.prepare('SELECT sum(turn_count) n FROM usage_request_daily').get().n,
        reader.prepare('SELECT sum(turn_count) n FROM usage_model_daily').get().n]); return 0;
    });
    db.connection.exec(`CREATE TEMP TRIGGER reader_probe AFTER INSERT ON main.usage_request_daily BEGIN SELECT rollup_reader_probe(); END;
      CREATE TEMP TRIGGER fail_rollup BEFORE INSERT ON main.usage_model_daily
      WHEN NEW.session_id='reject' BEGIN SELECT RAISE(ABORT,'fixture model rollup failure'); END;`);
    const before = fullExactSnapshot(db);
    assert.throws(() => db.replaceMemoryBatch([replacement([row('accepted')]), replacement([row('reject')])]), /fixture model rollup failure/);
    assert.equal(fullExactSnapshot(db), before); assert.ok(observed.length > 0);
    assert.ok(observed.every(item => canonical(item) === '[1,1,1]'));
    assert.equal(reader.prepare('SELECT count(*) n FROM turn_summary').get().n, 1);
    db.connection.exec('DROP TRIGGER fail_rollup');
    db.replaceMemoryBatch([replacement([row('accepted')]), replacement([row('reject')])]);
    assert.ok(observed.every(item => canonical(item) === '[1,1,1]'));
    assert.deepEqual([reader.prepare('SELECT count(*) n FROM turn_summary').get().n,
      reader.prepare('SELECT sum(turn_count) n FROM usage_request_daily').get().n,
      reader.prepare('SELECT sum(turn_count) n FROM usage_model_daily').get().n], [3, 3, 3]);
    integrity(db);
    return { failedModelInsertRollsBackFactsAndBothDailies: true, exactAllPersistentTableRollback: true,
      readerSeesOnlyPreviousCommitUntilBothDailiesComplete: true, retryWithoutLeakedDirtySessions: true, probeCalls: observed.length };
  } finally { reader?.close(); db.close(); }
}

async function scannerFallback(api, directory) {
  const logs = join(directory, 'scanner-logs'); await fsp.mkdir(logs);
  const dbPath = join(directory, 'scanner.sqlite'), db = new api.Database(dbPath);
  try {
    for (const id of ['a', 'b', 'c']) {
      const events = [{ type: 'user', sessionId: `session-${id}`, promptId: `request-${id}`, cwd: '/fixture/project',
        timestamp: '2026-11-01T00:00:00Z', message: { content: 'Synthetic rollup validation' } },
      { type: 'assistant', promptId: `request-${id}`, requestId: `response-${id}`, timestamp: '2026-11-01T00:00:02Z',
        message: { id: `response-${id}`, model: 'claude-sonnet-4-6', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } } }];
      await fsp.writeFile(join(logs, `${id}.jsonl`), events.map(item => JSON.stringify(item)).join('\n') + '\n');
    }
    activate(db); db.connection.exec(`CREATE TEMP TRIGGER fail_scanner_rollup BEFORE INSERT ON main.usage_model_daily
      WHEN NEW.session_id='session-b' BEGIN SELECT RAISE(ABORT,'fixture scanner rollup'); END;`);
    const calls = [], batch = db.replaceMemoryBatch.bind(db), single = db.replaceMemory.bind(db);
    db.replaceMemoryBatch = (...args) => { calls.push('batch'); return batch(...args); };
    db.replaceMemory = (...args) => { calls.push('single'); return single(...args); };
    const result = await api.refresh(db, { dbPath, roots: [{ provider: 'claude', path: logs }], timezone, sourceWorkers: 1 });
    assert.equal(result.failed, 1); assert.equal(result.interrupted, false); assert.deepEqual(calls, ['batch', 'single', 'single', 'single']);
    assert.equal(db.queryTurnsCount(), 2); assert.equal(db.findManifest('claude', join(logs, 'b.jsonl')).last_error, 'session-commit-error');
    assert.equal(db.connection.prepare('SELECT sum(turn_count) n FROM usage_request_daily').get().n, 2);
    assert.equal(db.connection.prepare('SELECT sum(turn_count) n FROM usage_model_daily').get().n, 2); integrity(db);
    return { rollupFailureTriggersWholeBatchRollbackAndScannerIndividualFallback: true, failedComponents: 1, successfulComponents: 2, calls };
  } finally { db.close(); }
}

async function main(args) {
  const options = { before: resolve(root, 'tests/results/benchmarks/rollup-batch-ab-20261110/A'), after: root, output: '' };
  for (const arg of args) { const match = /^--(before|after|output)=(.+)$/.exec(arg); assert.ok(match, 'Unknown option'); options[match[1]] = resolve(match[2]); }
  if (options.output) assert.ok(!fs.existsSync(options.output), 'Existing report must not be overwritten');
  const apis = { A: load(options.before), B: load(options.after) };
  const directory = await fsp.mkdtemp(join(tmpdir(), 'agent-tracker-rollup-validation-'));
  try {
    const report = { dateSeoul: '2026-11-10', runnerSha256: sha(fs.readFileSync(__filename)),
      helperSha256: sha(fs.readFileSync(join(__dirname, 'transaction-batch-validation.cjs'))),
      products: Object.fromEntries(Object.entries(apis).map(([variant, api]) => [variant,
        Object.fromEntries(['src/summary/db/memoryStore.ts', 'src/summary/db/rollups.ts',
          'dist/src/summary/db/memoryStore.js', 'dist/src/summary/db/rollups.js']
          .map(file => [file, sha(fs.readFileSync(join(api.directory, file)))]))])),
      scope: 'Explicit rollup A/B correctness validation with synthetic DTOs and actual scanner; no general suite',
      repeatedSessions: repeatedSessions(apis), metadataAndCalendar: metadataAndCalendar(apis), retainedAndRemoved: retainedAndRemoved(apis),
      atomicity: await rollupFailureAtomicity(apis.B, directory), scannerFallback: await scannerFallback(apis.B, directory),
      limitations: ['No OS kill, power-loss durability, competing writer, UI or live quota checks',
        'Intermediate unsupported calendar cache state can differ; final public reads and rebuilt daily states are compared'] };
    if (options.output) { await fsp.mkdir(dirname(options.output), { recursive: true }); await fsp.writeFile(options.output, JSON.stringify(report, null, 2) + '\n'); }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n'); return report;
  } finally {
    const target = resolve(directory); assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('agent-tracker-rollup-validation-')); await fsp.rm(target, { recursive: true, force: true });
  }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write(String(error.stack) + '\n'); process.exitCode = 1; });
module.exports = { main };
