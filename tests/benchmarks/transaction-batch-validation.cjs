// 이번 트랜잭션 A/B의 배치 경계·실패 격리·집계 의미를 별도 합성 입력으로 검증한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul';
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => typeof item === 'number' && !Number.isInteger(item)
  ? Number(item.toPrecision(12)) : item);
const normalized = row => Object.fromEntries(Object.keys(row).sort()
  .filter(key => !['id', 'turn_id', 'updated_at', 'last_successful_update', 'recorded_at', 'last_seen_scan_id'].includes(key))
  .map(key => [key, row[key]]));

function load(directory) {
  return { directory,
    Database: require(join(directory, 'dist/src/summary/db')).SummaryDatabase,
    Profiler: require(join(directory, 'dist/src/summary/profiling')).StageProfiler,
    ScanState: require(join(directory, 'dist/src/summary/scanner/refresh/state')).ScanState,
    SummaryError: require(join(directory, 'dist/src/summary/jsonl')).SummaryError,
    commitComponents: require(join(directory, 'dist/src/summary/scanner/refresh/persistence')).commitComponents,
    refresh: require(join(directory, 'dist/src/summary/scanner')).refreshSummary,
    raw: require(join(directory, 'dist/src/summary/db/queries')).buildUsageQuery,
  };
}

function row(session, id = 'request', overrides = {}) {
  return { provider: 'claude', session_id: session, root_turn_id: id,
    project_key: '/fixture/project', project_name: 'Fixture', session_name: 'Fixture session',
    started_at_ms: Date.UTC(2026, 10, 1, 16), completed_at_ms: Date.UTC(2026, 10, 1, 16) + 1000,
    input_tokens: 10, output_tokens: 2, total_tokens: 12,
    cache_read_input_tokens: 0, cache_write_input_tokens: 0,
    duration_ms: 1000, duration_quality: 'exact', status: 'completed',
    updated_at: '2026-11-10T00:00:00.000Z', hasMain: true,
    model_usage: [{ model: 'claude-sonnet-4-6', input_tokens: 10, output_tokens: 2,
      cache_read_input_tokens: 0, cache_write_input_tokens: 0 }], capability_usage: [], ...overrides };
}

function replacement(rows, extra = {}) {
  return { scanId: 'fixture', sessions: [...new Map(rows.map(item => [canonical([item.provider, item.session_id]),
    { provider: item.provider, session_id: item.session_id }])).values()], files: [], summaries: rows, ...extra };
}

function snapshot(db) {
  return canonical(db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => [name, db.connection.prepare(`SELECT * FROM ${name}`).all()
      .map(normalized).sort((a, b) => canonical(a).localeCompare(canonical(b)))]));
}

function integrity(db) {
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
}

function activate(db) { db.queryUsagePage({}, 'day', timezone, { limit: 100 }); }

function allRows(db, group, by, filter = {}, zone = timezone) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = db.queryUsagePage(filter, group, zone, { limit: 1000, offset }, by);
    rows.push(...page.rows);
    if (rows.length >= page.total) { assert.equal(rows.length, page.total); return rows; }
  }
}

// DTO에서 직접 펼친 모델 기여행을 JS로 합산한다. 제품 집계 SQL/UDF를 기대값 계산에 사용하지 않는다.
function expectedRows(rows, group, by, excludeEmptyUsage, zone) {
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const groups = new Map();
  for (const request of rows) {
    const modelRows = by === 'model' ? [...request.model_usage ?? []] : [];
    const contributions = by === 'model' ? modelRows.length ? modelRows.map(model => ({ ...request, ...model,
      total_tokens: model.input_tokens + model.output_tokens, has_model: model.model !== '',
      model: model.model === '' && model.input_tokens + model.output_tokens === 0 ? null : model.model }))
      : [{ ...request, has_model: false, model: request.total_tokens ? '' : null }]
      : [{ ...request, has_model: [...request.model_usage ?? []].some(model => model.model !== '') }];
    for (const item of contributions) {
      const period = item.started_at_ms == null ? null : date.format(item.started_at_ms).slice(0, group === 'month' ? 7 : 10);
      const key = canonical([item.provider, by === 'model' ? item.model : null,
        ['project', 'session'].includes(group) ? item.project_key : null,
        group === 'session' ? item.session_id : null, ['day', 'month'].includes(group) ? period : null]);
      const bucket = groups.get(key) ?? { turn_count: 0, total_tokens: 0, input_tokens: 0, output_tokens: 0,
        completed_turns: 0, recorded_turns: 0, recorded_completed_turns: 0, n: 0, tokens: 0, input: 0, output: 0,
        duration: 0, turns_with_duration: 0, exact_duration_turns: 0, derived_duration_turns: 0,
        approximate_duration_turns: 0, missing_duration_turns: 0,
        cache_write_input_tokens: 0, cache_read_input_tokens: 0, cacheWriteKnown: true, cacheReadKnown: true,
        avgCacheWrite: 0, avgCacheRead: 0, avgCacheWriteKnown: true, avgCacheReadKnown: true };
      const complete = item.status === 'completed', recorded = item.total_tokens > 0 || item.has_model;
      bucket.turn_count++; bucket.total_tokens += item.total_tokens; bucket.input_tokens += item.input_tokens;
      bucket.output_tokens += item.output_tokens; bucket.completed_turns += Number(complete);
      bucket.recorded_turns += Number(recorded); bucket.recorded_completed_turns += Number(recorded && complete);
      for (const [field, sum, known] of [['cache_write_input_tokens', 'cache_write_input_tokens', 'cacheWriteKnown'],
        ['cache_read_input_tokens', 'cache_read_input_tokens', 'cacheReadKnown']]) {
        bucket[sum] += item[field] ?? 0; bucket[known] &&= item[field] != null;
      }
      if (complete && (!excludeEmptyUsage || recorded)) {
        bucket.n++; bucket.tokens += item.total_tokens; bucket.input += item.input_tokens; bucket.output += item.output_tokens;
        for (const quality of ['exact', 'derived', 'approximate']) bucket[`${quality}_duration_turns`] += Number(item.duration_quality === quality);
        if (item.duration_ms == null) bucket.missing_duration_turns++;
        else { bucket.duration += item.duration_ms; bucket.turns_with_duration++; }
        bucket.avgCacheWrite += item.cache_write_input_tokens ?? 0; bucket.avgCacheRead += item.cache_read_input_tokens ?? 0;
        bucket.avgCacheWriteKnown &&= item.cache_write_input_tokens != null; bucket.avgCacheReadKnown &&= item.cache_read_input_tokens != null;
      }
      groups.set(key, bucket);
    }
  }
  return groups;
}

function verifyAggregates(db, api, rows, zone = timezone) {
  let checks = 0;
  for (const by of ['provider', 'model']) for (const group of ['total', 'day', 'month', 'session', 'project']) {
    for (const excludeEmptyUsage of [false, true]) {
      const filter = { excludeEmptyUsage, unknownTime: 'include' }, actual = allRows(db, group, by, filter, zone);
      const expected = expectedRows(rows, group, by, excludeEmptyUsage, zone);
      assert.equal(actual.length, expected.size, `${by}/${group}/group count`);
      for (const item of actual) {
        const key = canonical([item.provider, by === 'model' ? item.model : null,
          ['project', 'session'].includes(group) ? item.project_key : null,
          group === 'session' ? item.session_id : null, ['day', 'month'].includes(group) ? item.period : null]);
        const sample = expected.get(key); assert.ok(sample, `${by}/${group}/key`);
        const result = { ...sample,
          cache_write_input_tokens: sample.cacheWriteKnown ? sample.cache_write_input_tokens : null,
          cache_read_input_tokens: sample.cacheReadKnown ? sample.cache_read_input_tokens : null,
          avg_tokens_per_turn: sample.n ? sample.tokens / sample.n : null,
          avg_input_tokens: sample.n ? sample.input / sample.n : null, avg_output_tokens: sample.n ? sample.output / sample.n : null,
          avg_duration_ms: sample.turns_with_duration ? sample.duration / sample.turns_with_duration : null,
          avg_cache_write_input_tokens: sample.n && sample.avgCacheWriteKnown ? sample.avgCacheWrite / sample.n : null,
          avg_cache_read_input_tokens: sample.n && sample.avgCacheReadKnown ? sample.avgCacheRead / sample.n : null };
        const fields = ['turn_count', 'total_tokens', 'input_tokens', 'output_tokens', 'completed_turns', 'recorded_turns',
          'recorded_completed_turns', 'avg_tokens_per_turn', 'avg_input_tokens', 'avg_output_tokens', 'avg_duration_ms',
          'cache_write_input_tokens', 'cache_read_input_tokens', 'avg_cache_write_input_tokens', 'avg_cache_read_input_tokens',
          'turns_with_duration', 'exact_duration_turns', 'derived_duration_turns', 'approximate_duration_turns', 'missing_duration_turns'];
        assert.equal(canonical(fields.map(field => item[field])), canonical(fields.map(field => result[field])), `${by}/${group}/independent metrics`);
      }
      const raw = api.raw(filter, group, zone, by);
      const rawRows = db.connection.prepare(raw.sql).all(...raw.values, 10000000, 0);
      assert.equal(canonical(actual.map(normalized)), canonical(rawRows.map(normalized)), `${by}/${group}/raw-rollup`);
      checks++;
    }
  }
  return checks;
}

function sampleRows() {
  const a = row('s-a', 'multi', { input_tokens: 30, output_tokens: 3, total_tokens: 33,
    cache_write_input_tokens: null, cache_read_input_tokens: null, duration_ms: null, duration_quality: 'derived',
    model_usage: [{ model: 'A', input_tokens: 10, output_tokens: 1, cache_write_input_tokens: null, cache_read_input_tokens: null },
      { model: 'B', input_tokens: 20, output_tokens: 2, cache_write_input_tokens: 0, cache_read_input_tokens: 0 }] });
  return [a, row('s-a', 'empty', { input_tokens: 0, output_tokens: 0, total_tokens: 0, model_usage: undefined,
    started_at_ms: null, duration_ms: null, duration_quality: 'missing' }),
  row('s-b', 'recorded-zero', { input_tokens: 0, output_tokens: 0, total_tokens: 0,
    model_usage: [{ model: 'A', input_tokens: 0, output_tokens: 0, cache_write_input_tokens: 0, cache_read_input_tokens: 0 }] }),
  row('s-b', 'failed', { status: 'failed', duration_ms: null, duration_quality: 'missing' }),
  row('s-c', 'unknown-model', { model_usage: [{ model: '', input_tokens: 10, output_tokens: 2,
    cache_write_input_tokens: 0, cache_read_input_tokens: 0 }], duration_quality: 'approximate' }),
  row('s-c', 'running', { status: 'in_progress' })];
}

function apiSemantics(apis) {
  const dbs = Object.fromEntries(Object.entries(apis).map(([key, api]) => [key, new api.Database(':memory:')]));
  let checks = 0;
  const rows = sampleRows(), rounds = [rows,
    rows.map((item, index) => index === 0 ? { ...item, project_key: '/fixture/moved', project_name: 'Moved',
      started_at_ms: Date.UTC(2026, 10, 4, 16), duration_ms: 500, duration_quality: 'exact' } : item),
    rows.filter(item => item.root_turn_id !== 'unknown-model')];
  try {
    for (const db of Object.values(dbs)) activate(db);
    for (const round of rounds) {
      const replacements = [...new Set(rows.map(item => item.session_id))].map(session => replacement(round.filter(item => item.session_id === session),
        { sessions: [{ provider: 'claude', session_id: session }] }));
      const original = canonical(replacements);
      for (const item of replacements) dbs.A.replaceMemory(item);
      dbs.B.replaceMemoryBatch(replacements);
      assert.equal(canonical(replacements), original, 'Batch must not mutate reusable DTO arrays');
      dbs.B.replaceMemoryBatch(replacements);
      for (const [key, db] of Object.entries(dbs)) { checks += verifyAggregates(db, apis[key], round); integrity(db); }
      assert.equal(snapshot(dbs.A), snapshot(dbs.B), 'Sequential A and batch B persisted values');
    }
    for (const [key, db] of Object.entries(dbs)) checks += verifyAggregates(db, apis[key], rounds.at(-1), 'America/New_York');
    assert.equal(snapshot(dbs.A), snapshot(dbs.B), 'Timezone rebuild must preserve A/B equivalence');
    return { rounds: rounds.length, independentAggregateChecks: checks, reusableDtos: true, projectDateMoveAndDeletion: true, timezoneRebuild: true };
  } finally { for (const db of Object.values(dbs)) db.close(); }
}

async function atomicVisibility(api, directory) {
  const path = join(directory, 'visibility.sqlite'), db = new api.Database(path);
  let reader;
  try {
    activate(db); reader = new DatabaseSync(path, { readOnly: true });
    const observed = [];
    db.connection.function('batch_reader_probe', () => {
      observed.push({ facts: reader.prepare('SELECT count(*) n FROM turn_summary').get().n,
        rollups: reader.prepare('SELECT count(*) n FROM usage_request_daily').get().n });
      return 0;
    });
    db.connection.exec(`CREATE TEMP TRIGGER visibility_probe AFTER INSERT ON main.turn_summary
      BEGIN SELECT batch_reader_probe(); END;`);
    db.replaceMemoryBatch([replacement([row('visible-a')]), replacement([row('visible-b')])]);
    assert.equal(observed.length, 2); assert.ok(observed.every(item => item.facts === 0 && item.rollups === 0));
    assert.equal(reader.prepare('SELECT count(*) n FROM turn_summary').get().n, 2);
    assert.equal(reader.prepare('SELECT count(*) n FROM usage_request_daily').get().n, 2);
    const before = snapshot(db);
    db.connection.exec(`CREATE TEMP TRIGGER reject_batch BEFORE INSERT ON main.turn_summary
      WHEN NEW.session_id='reject' BEGIN SELECT RAISE(ABORT,'fixture rejection'); END;`);
    const attempt = [replacement([row('rollback-first')]), replacement([row('reject')])], original = canonical(attempt);
    assert.throws(() => db.replaceMemoryBatch(attempt), /fixture rejection/);
    assert.equal(snapshot(db), before); assert.equal(canonical(attempt), original);
    assert.equal(reader.prepare('SELECT count(*) n FROM turn_summary').get().n, 2);
    db.connection.exec('DROP TRIGGER reject_batch'); db.replaceMemoryBatch(attempt);
    assert.equal(reader.prepare('SELECT count(*) n FROM turn_summary').get().n, 4);
    const profiler = new api.Profiler(); db.replaceMemoryBatch([], profiler); assert.deepEqual(profiler.timings, {});
    integrity(db);
    return { separateReaderSeesOnlyCommittedBatch: true, rollbackRestoresAllPersistentTables: true,
      sameDtosRetryAfterRollback: true, emptyBatchNoTransaction: true, probeCalls: observed.length };
  } finally { reader?.close(); db.close(); }
}

function componentContext(api, db, counts, options = {}) {
  const result = { scanId: 'fixture', discovered: counts.length, parsed: counts.length, reused: 0, failed: 0,
    bodyBytes: 0, interrupted: false, completedAt: '' }, state = new api.ScanState(result), summaries = [], orphans = [];
  for (let index = 0; index < counts.length; index++) {
    const session = `s-${String(index).padStart(3, '0')}`, id = index + 1;
    const file = { id, provider: 'claude', source_root: '/fixture/logs', path: `/fixture/logs/${id}.jsonl`, session_id: session,
      session, size_bytes: 100, mtime_ms: 1, dev: null, inode: null, parser_version: 17,
      changed: true, removed: false, selected: true, attempted: true };
    if (index === options.specialIndex) {
      if (options.special === 'deferred') file.deferred = true;
      if (options.special === 'error') file.error = new api.SummaryError('parse-error');
      if (options.special === 'removed') file.removed = true;
      if (options.special === 'reconnection') state.reconnections.push({ old_id: id, new_id: id + 10000 });
      if (options.special === 'orphan') orphans.push({ provider: 'claude', session_id: session, fileId: id, offset: 0 });
    }
    state.trackFile(file); state.affect('claude', session);
    if (!file.removed) for (let n = 0; n < counts[index]; n++) summaries.push(row(session, `r-${n}`));
  }
  let checks = 0;
  return { context: { database: db, result, storage: new api.Profiler(), state, collect: true, retain: true,
    check: () => { checks++; if (options.cancel?.()) throw new api.SummaryError('interrupted'); }, report: () => {} },
  aggregate: { summaries, orphans }, checks: () => checks };
}

function captureWrites(db, options = {}) {
  const calls = [], batch = db.replaceMemoryBatch.bind(db), single = db.replaceMemory.bind(db);
  db.replaceMemoryBatch = (items, profile) => {
    calls.push({ kind: 'batch', components: items.length, requests: items.reduce((n, item) => n + [...item.summaries].length, 0) });
    const value = batch(items, profile); options.onCommit?.(); return value;
  };
  db.replaceMemory = (item, profile) => {
    calls.push({ kind: 'single', components: 1, requests: [...item.summaries].length });
    const value = single(item, profile); options.onCommit?.(); return value;
  };
  return calls;
}

async function componentBoundaries(api) {
  const results = [];
  for (const [label, counts, expected] of [
    ['empty', [], []], ['single-append', [1], [['single', 1, 1]]],
    ['sixteen-limit', Array(17).fill(1), [['batch', 16, 16], ['single', 1, 1]]],
    ['thousand-limit', [600, 400, 1], [['batch', 2, 1000], ['single', 1, 1]]],
    ['over-thousand-single', [1001, 1, 1], [['single', 1, 1001], ['batch', 2, 2]]],
  ]) {
    const db = new api.Database(':memory:');
    try {
      activate(db); const calls = captureWrites(db), fixture = componentContext(api, db, counts);
      await api.commitComponents(fixture.context, fixture.aggregate);
      assert.deepEqual(calls.map(item => [item.kind, item.components, item.requests]), expected, label);
      assert.equal(db.queryTurnsCount(), counts.reduce((n, value) => n + value, 0));
      assert.equal(fixture.context.state.affected.size, 0); assert.ok([...fixture.context.state.files.values()].every(file => file.settled));
      integrity(db); results.push({ label, calls });
    } finally { db.close(); }
  }
  for (const special of ['deferred', 'error', 'orphan', 'removed']) {
    const db = new api.Database(':memory:');
    try {
      activate(db); const calls = captureWrites(db), fixture = componentContext(api, db, [1, 1, 1, 1, 1], { special, specialIndex: 2 });
      await api.commitComponents(fixture.context, fixture.aggregate);
      const batches = calls.filter(item => item.kind === 'batch');
      assert.deepEqual(batches.map(item => item.components), [2, 2], `Special boundary/${special}`);
      assert.equal(db.queryTurnsCount(), 4); integrity(db); results.push({ label: `special-${special}`, calls });
    } finally { db.close(); }
  }
  return results;
}

async function failedComponentFallback(api) {
  const db = new api.Database(':memory:');
  try {
    activate(db);
    db.connection.exec(`CREATE TEMP TRIGGER fail_middle BEFORE INSERT ON main.turn_summary
      WHEN NEW.session_id='s-001' BEGIN SELECT RAISE(ABORT,'fixture middle rejection'); END;`);
    const calls = captureWrites(db), fixture = componentContext(api, db, [1, 1, 1]);
    await api.commitComponents(fixture.context, fixture.aggregate);
    assert.deepEqual(calls.map(item => item.kind), ['batch', 'single', 'single', 'single']);
    assert.equal(db.queryTurnsCount(), 2); assert.equal(fixture.context.result.failed, 1);
    const files = [...fixture.context.state.files.values()];
    assert.equal(files[0].settled, true); assert.equal(files[1].settled, undefined); assert.equal(files[2].settled, true);
    assert.equal(files[1].error.code, 'session-commit-error');
    assert.equal(fixture.context.storage.timings.rollback.calls, 2);
    assert.equal(fixture.context.state.affected.size, 0); integrity(db);
    return { failedBatchRolledBackThenRetriedIndividually: true, isolatedFailures: 1, successfulComponents: 2, calls };
  } finally { db.close(); }
}

async function cancellationBoundary(api) {
  const db = new api.Database(':memory:'); let cancelled = false;
  try {
    activate(db); const calls = captureWrites(db, { onCommit: () => { cancelled = true; } });
    const fixture = componentContext(api, db, Array(18).fill(1), { cancel: () => cancelled });
    await assert.rejects(api.commitComponents(fixture.context, fixture.aggregate), error => error.code === 'interrupted');
    assert.equal(db.queryTurnsCount(), 16); assert.equal(calls.length, 1);
    const files = [...fixture.context.state.files.values()];
    assert.ok(files.slice(0, 16).every(file => file.settled)); assert.ok(files.slice(16).every(file => !file.settled));
    assert.equal(fixture.context.state.affected.size, 2); integrity(db);
    return { successfulBatchRemainsCommitted: true, pendingBatchUncommitted: true, committedComponents: 16, pendingComponents: 2 };
  } finally { db.close(); }
}

function sourceLifecycle(apis) {
  const dbs = Object.fromEntries(Object.entries(apis).map(([key, api]) => [key, new api.Database(':memory:')]));
  const metadata = (id, session) => ({ id, provider: 'claude', source_root: '/fixture/logs', path: `/fixture/logs/${id}.jsonl`,
    session_id: session, size_bytes: 100, mtime_ms: 1, dev: null, inode: null, parser_version: 17 });
  const seed = ['retained', 'moved', 'deleted'].map((session, index) => replacement([row(session, 'one',
    { diagnostic_file_id: index + 101, capability_usage: [{ category: 'skill', name: 'fixture', usage_count: 2 }] })],
  { files: [metadata(index + 101, session)] }));
  try {
    for (const db of Object.values(dbs)) { activate(db); for (const item of seed) db.replaceMemory(item); }
    const retained = normalized(dbs.B.queryTurns({ sessionId: 'retained' })[0]);
    const changes = [
      replacement([], { sessions: [{ provider: 'claude', session_id: 'retained' }], removedFileIds: [101], retainDeletedSourceUsage: true }),
      replacement([row('moved', 'one', { diagnostic_file_id: 202,
        capability_usage: [{ category: 'skill', name: 'fixture', usage_count: 2 }] })],
      { files: [metadata(202, 'moved')], removedFileIds: [102], reconnectedFiles: [{ old_id: 102, new_id: 202 }] }),
      replacement([], { sessions: [{ provider: 'claude', session_id: 'deleted' }], removedFileIds: [103], retainDeletedSourceUsage: false }),
    ];
    for (const item of changes) dbs.A.replaceMemory(item);
    dbs.B.replaceMemoryBatch(changes);
    assert.equal(snapshot(dbs.A), snapshot(dbs.B));
    assert.deepEqual(normalized(dbs.B.queryTurns({ sessionId: 'retained' })[0]), retained);
    assert.equal(dbs.B.findManifest('claude', '/fixture/logs/101.jsonl').source_missing, 1);
    assert.equal(dbs.B.findManifest('claude', '/fixture/logs/102.jsonl'), undefined);
    assert.equal(dbs.B.findManifest('claude', '/fixture/logs/202.jsonl').source_missing, 0);
    assert.equal(dbs.B.queryTurns({ sessionId: 'moved' })[0].diagnostic_file_id, 202);
    assert.equal(dbs.B.queryTurns({ sessionId: 'deleted' }).length, 0);
    assert.equal(dbs.B.findManifest('claude', '/fixture/logs/103.jsonl'), undefined);
    for (const db of Object.values(dbs)) integrity(db);
    return { retainedUsageAndCapabilitiesPreserved: true, explicitDeletion: true, movedSourceAndDiagnosticRelinked: true, sequentialAndBatchMatch: true };
  } finally { for (const db of Object.values(dbs)) db.close(); }
}

async function fallbackCancellation(api) {
  const db = new api.Database(':memory:'); let cancelled = false;
  try {
    activate(db); db.connection.exec(`CREATE TEMP TRIGGER reject_later BEFORE INSERT ON main.turn_summary
      WHEN NEW.session_id='s-001' BEGIN SELECT RAISE(ABORT,'fixture later rejection'); END;`);
    const calls = captureWrites(db, { onCommit: () => { cancelled = true; } });
    const fixture = componentContext(api, db, [1, 1, 1], { cancel: () => cancelled });
    await assert.rejects(api.commitComponents(fixture.context, fixture.aggregate), error => error.code === 'interrupted');
    assert.deepEqual(calls.map(item => item.kind), ['batch', 'single']); assert.equal(db.queryTurnsCount(), 1);
    const files = [...fixture.context.state.files.values()];
    assert.equal(files[0].settled, true); assert.ok(files.slice(1).every(file => !file.settled && !file.error));
    assert.equal(fixture.context.state.affected.size, 2); integrity(db);
    return { successfulFallbackComponentCommitted: true, unattemptedComponentsRemainPending: true, committed: 1, pending: 2 };
  } finally { db.close(); }
}

async function fullScannerFallback(api, directory) {
  const logs = join(directory, 'scanner-logs'); await fsp.mkdir(logs);
  const dbPath = join(directory, 'scanner.sqlite'), db = new api.Database(dbPath);
  try {
    for (const id of ['a', 'b', 'c']) {
      const rows = [{ type: 'user', sessionId: `session-${id}`, promptId: `request-${id}`, cwd: '/fixture/project',
        timestamp: '2026-11-01T00:00:00Z', message: { content: 'Synthetic validation fixture' } },
      { type: 'assistant', promptId: `request-${id}`, requestId: `response-${id}`, timestamp: '2026-11-01T00:00:02Z',
        message: { id: `response-${id}`, model: 'claude-sonnet-4-6', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } } }];
      await fsp.writeFile(join(logs, `${id}.jsonl`), rows.map(item => JSON.stringify(item)).join('\n') + '\n');
    }
    activate(db); db.connection.exec(`CREATE TEMP TRIGGER reject_scanner_middle BEFORE INSERT ON main.turn_summary
      WHEN NEW.session_id='session-b' BEGIN SELECT RAISE(ABORT,'fixture scanner middle'); END;`);
    const calls = captureWrites(db), result = await api.refresh(db, { dbPath, roots: [{ provider: 'claude', path: logs }],
      timezone, sourceWorkers: 1 });
    assert.equal(result.failed, 1); assert.equal(result.interrupted, false); assert.equal(db.queryTurnsCount(), 2);
    assert.equal(db.findManifest('claude', join(logs, 'b.jsonl')).last_error, 'session-commit-error');
    assert.ok(['a', 'c'].every(id => db.findManifest('claude', join(logs, `${id}.jsonl`)).processing_status === 'done'));
    assert.deepEqual(calls.map(item => item.kind), ['batch', 'single', 'single', 'single']); integrity(db);
    return { actualScannerRefresh: true, persistedFailureDiagnostic: true, healthyBeforeAndAfterFailureCommitted: true, calls };
  } finally { db.close(); }
}

async function main(args) {
  const options = { before: resolve(root, 'tests/results/benchmarks/transaction-ab-20261110/A'), after: root, output: '' };
  for (const arg of args) {
    const match = /^--(before|after|output)=(.+)$/.exec(arg); assert.ok(match, 'Expected --before/--after/--output');
    options[match[1]] = resolve(match[2]);
  }
  if (options.output) assert.ok(!fs.existsSync(options.output), 'Existing report must not be overwritten');
  const apis = { A: load(options.before), B: load(options.after) };
  assert.equal(typeof apis.B.Database.prototype.replaceMemoryBatch, 'function', 'Compile candidate B first');
  const directory = await fsp.mkdtemp(join(tmpdir(), 'agent-tracker-transaction-validation-'));
  try {
    const report = { dateSeoul: new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(new Date()), runnerSha256: sha(fs.readFileSync(__filename)),
      products: Object.fromEntries(Object.entries(apis).map(([variant, api]) => [variant,
        Object.fromEntries(['src/summary/db/index.ts', 'src/summary/db/memoryStore.ts', 'src/summary/scanner/refresh/persistence.ts',
          'dist/src/summary/db/index.js', 'dist/src/summary/db/memoryStore.js', 'dist/src/summary/scanner/refresh/persistence.js']
          .map(file => [file, sha(fs.readFileSync(join(api.directory, file)))]))])),
      scope: 'Directly requested transaction A/B validation; no general automated suite. Synthetic DTOs and scanner persistence entry point.',
      limitations: ['OS process kill and power-loss durability not exercised', 'No UI, live quota or independent real-log parser oracle'],
      apiSemantics: apiSemantics(apis), atomicVisibility: await atomicVisibility(apis.B, directory),
      componentBoundaries: await componentBoundaries(apis.B), fallback: await failedComponentFallback(apis.B),
      cancellation: await cancellationBoundary(apis.B), sourceLifecycle: sourceLifecycle(apis),
      fallbackCancellation: await fallbackCancellation(apis.B), actualScannerFallback: await fullScannerFallback(apis.B, directory) };
    if (options.output) { await fsp.mkdir(dirname(options.output), { recursive: true }); await fsp.writeFile(options.output, JSON.stringify(report, null, 2) + '\n'); }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n'); return report;
  } finally {
    const target = resolve(directory); assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('agent-tracker-transaction-validation-'));
    await fsp.rm(target, { recursive: true, force: true });
  }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write(String(error.stack) + '\n'); process.exitCode = 1; });
module.exports = { main, expectedRows, verifyAggregates };
