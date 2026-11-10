// 실제 연결 성분별 트랜잭션 구간과 제공자·모델 평균을 고정 입력의 교대 A/B로 비교한다.
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { cpus, release } = require('node:os');
const { dirname, join, relative, resolve, sep } = require('node:path');
const { performance } = require('node:perf_hooks');
const helpers = require('./incremental-refresh.cjs');
const { independentCheck, stats } = require('./temp-batch-ab.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul';
const groups = ['day', 'month', 'session', 'project'], scenarios = ['initial', 'append-one', 'unchanged'];
const peerStages = ['begin', 'prepare', 'manifest', 'indexSummaries', 'metadata', 'deleteMissing', 'summaries',
  'reconnectDiagnostics', 'removeSources', 'rollups', 'pruneNames', 'commit'];
const sha = value => createHash('sha256').update(value).digest('hex');
const clock = () => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const profileKey = Symbol.for('agent-tracker.source-pool-ab');
let filter = { fromMs: Date.UTC(2025, 11, 31, 15), toMs: Date.UTC(2026, 11, 31, 15),
  unknownTime: 'include', excludeEmptyUsage: true };
const elapsed = value => typeof value === 'number' ? value : value?.totalMs ?? 0;
let omittedUsageFields = [];

function retainedUsage(row) {
  const result = { ...row };
  for (const field of omittedUsageFields) delete result[field];
  return result;
}

function normalizedUsage(row) {
  return helpers.normalized(retainedUsage(row));
}

function metadataSqlKind(sql) {
  const text = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  if (/^insert (?:or \w+ )?into projects\b/.test(text)) return 'projectUpserts';
  if (/^insert (?:or \w+ )?into sessions\b/.test(text)) return 'sessionUpserts';
  if (/^update sessions set session_name\b/.test(text)) return 'sessionNameUpdates';
  if (/^select\b/.test(text) && /\bfrom session_billing\b/.test(text)) return 'billingReads';
  if (/^delete from projects\b/.test(text)) return 'projectPrunes';
  if (/^delete from sessions\b/.test(text)) return 'sessionPrunes';
  return undefined;
}

function allUsageBy(db, group, usageFilter, by = 'provider') {
  const rows = []; let total;
  for (let offset = 0; ; offset += 1000) {
    const page = db.queryUsagePage(usageFilter, group, timezone, { limit: 1000, offset }, by);
    total ??= page.total; assert.equal(page.total, total); rows.push(...page.rows);
    if (rows.length >= total) break;
  }
  assert.equal(rows.length, total);
  return rows;
}

// Persisted request/model facts are reduced in JavaScript without SQL GROUP BY or product metric builders.
function independentModelCheck(db, usageFilter, group, actual) {
  const requests = db.connection.prepare('SELECT * FROM turn_summary ORDER BY id').all();
  const models = new Map();
  for (const row of db.connection.prepare('SELECT * FROM turn_model_usage ORDER BY turn_id,model').all()) {
    if (!models.has(row.turn_id)) models.set(row.turn_id, []);
    models.get(row.turn_id).push(row);
  }
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const key = row => JSON.stringify([row.provider, row.model,
    ['project', 'session'].includes(group) ? row.project_key : null,
    group === 'session' ? row.session_id : null, ['day', 'month'].includes(group) ? row.period : null]);
  const expected = new Map();
  for (const request of requests) {
    if (request.started_at_ms !== null && (request.started_at_ms < usageFilter.fromMs || request.started_at_ms >= usageFilter.toMs)) continue;
    if (request.started_at_ms === null && usageFilter.unknownTime !== 'include') continue;
    const period = request.started_at_ms === null ? null : date.format(request.started_at_ms).slice(0, group === 'month' ? 7 : 10);
    for (const contribution of models.get(request.id) ?? [undefined]) {
      const input = contribution?.input_tokens ?? request.input_tokens;
      const output = contribution?.output_tokens ?? request.output_tokens;
      const total = input + output, modelName = contribution?.model ?? '';
      const row = { ...request, model: modelName === '' && total === 0 ? null : modelName, period };
      const groupKey = key(row);
      const sum = expected.get(groupKey) ?? { turns: 0, tokens: 0, input: 0, output: 0,
        completed: 0, recorded: 0, recordedCompleted: 0, samples: 0, sampleTokens: 0, sampleInput: 0, sampleOutput: 0,
        durations: 0, durationSum: 0, exact: 0, derived: 0, approximate: 0, missing: 0,
        cacheWrite: 0, cacheRead: 0, cacheWriteKnown: 0, cacheReadKnown: 0,
        sampleCacheWrite: 0, sampleCacheRead: 0, sampleCacheWriteKnown: 0, sampleCacheReadKnown: 0 };
      const complete = request.status === 'completed', recorded = total > 0 || modelName !== '';
      sum.turns++; sum.tokens += total; sum.input += input; sum.output += output;
      sum.completed += Number(complete); sum.recorded += Number(recorded); sum.recordedCompleted += Number(complete && recorded);
      const cacheWrite = contribution ? contribution.cache_write_input_tokens : request.cache_write_input_tokens;
      const cacheRead = contribution ? contribution.cache_read_input_tokens : request.cache_read_input_tokens;
      if (cacheWrite !== null) { sum.cacheWrite += cacheWrite; sum.cacheWriteKnown++; }
      if (cacheRead !== null) { sum.cacheRead += cacheRead; sum.cacheReadKnown++; }
      if (complete && (!usageFilter.excludeEmptyUsage || recorded)) {
        sum.samples++; sum.sampleTokens += total; sum.sampleInput += input; sum.sampleOutput += output;
        if (request.duration_ms !== null) { sum.durationSum += request.duration_ms; sum.durations++; } else sum.missing++;
        if (request.duration_quality !== 'missing') sum[request.duration_quality]++;
        if (cacheWrite !== null) { sum.sampleCacheWrite += cacheWrite; sum.sampleCacheWriteKnown++; }
        if (cacheRead !== null) { sum.sampleCacheRead += cacheRead; sum.sampleCacheReadKnown++; }
      }
      expected.set(groupKey, sum);
    }
  }
  assert.equal(actual.length, expected.size, `JS model group count/${group}`);
  const fields = ['turn_count', 'total_tokens', 'input_tokens', 'output_tokens', 'completed_turns', 'recorded_turns', 'recorded_completed_turns'];
  const numberEqual = (left, right, label) => {
    if (left === null || right === null) assert.equal(left, right, label);
    else assert.ok(Math.abs(left - right) <= Math.max(1, Math.abs(right)) * 1e-10, label);
  };
  for (const row of actual) {
    const sum = expected.get(key(row)); assert.ok(sum, `JS model key/${group}`);
    assert.deepEqual(fields.map(field => row[field]), [sum.turns, sum.tokens, sum.input, sum.output, sum.completed, sum.recorded, sum.recordedCompleted]);
    const average = field => sum.samples ? sum[field] / sum.samples : null;
    numberEqual(row.avg_tokens_per_turn, average('sampleTokens'), `JS model token mean/${group}`);
    numberEqual(row.avg_input_tokens, average('sampleInput'), `JS model input mean/${group}`);
    numberEqual(row.avg_output_tokens, average('sampleOutput'), `JS model output mean/${group}`);
    numberEqual(row.avg_duration_ms, sum.durations ? sum.durationSum / sum.durations : null, `JS model duration mean/${group}`);
    for (const [field, sumField, knownField, sampleField, sampleKnown] of [
      ['cache_write_input_tokens', 'cacheWrite', 'cacheWriteKnown', 'sampleCacheWrite', 'sampleCacheWriteKnown'],
      ['cache_read_input_tokens', 'cacheRead', 'cacheReadKnown', 'sampleCacheRead', 'sampleCacheReadKnown'],
    ]) {
      numberEqual(row[field], sum[knownField] === sum.turns ? sum[sumField] : null, `JS model cache total/${group}`);
      numberEqual(row[`avg_${field}`], sum[sampleKnown] === sum.samples ? average(sampleField) : null, `JS model cache average/${group}`);
    }
    assert.deepEqual([row.turns_with_duration, row.exact_duration_turns, row.derived_duration_turns, row.approximate_duration_turns, row.missing_duration_turns],
      [sum.durations, sum.exact, sum.derived, sum.approximate, sum.missing]);
  }
  return { groups: expected.size, contributionRows: [...expected.values()].reduce((n, value) => n + value.turns, 0),
    tokens: [...expected.values()].reduce((n, value) => n + value.tokens, 0),
    sha256: sha(JSON.stringify(actual.map(helpers.normalized))) };
}

function fingerprint(directory) {
  const files = [];
  function walk(path) {
    for (const entry of fs.readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push([relative(directory, child).split(sep).join('/'), sha(fs.readFileSync(child))]);
    }
  }
  walk(directory);
  return { files: files.length, sha256: sha(JSON.stringify(files)) };
}

function loadScanner(product) {
  return require(join(product, 'dist/src/summary/scanner'));
}

function installCounters(product, state, structure) {
  const { StageProfiler } = require(join(product, 'dist/src/summary/profiling'));
  const reader = require(join(product, 'dist/src/summary/scanner/sourceReader'));
  const source = require(join(product, 'dist/src/summary/scanner/sourceFingerprint'));
  const asyncMeasure = StageProfiler.prototype.measureAsync, lstat = fsp.lstat;
  const read = reader.readSource, verify = source.includesSourceSnapshot;
  const poolPath = join(product, 'dist/src/summary/scanner/sourcePool.js');
  const pool = fs.existsSync(poolPath) ? require(poolPath).SourceReaderPool : undefined;
  const poolRead = pool?.prototype.read, poolEnqueue = pool?.prototype.enqueue;
  StageProfiler.prototype.measureAsync = async function(stage, action) {
    const previous = state.stage;
    if (stage !== 'readSources') state.stage = stage;
    try { return await asyncMeasure.call(this, stage, action); }
    finally { state.stage = previous; }
  };
  fsp.lstat = async function(...args) {
    if (state.counters) state.counters.statCalls[state.stage] = (state.counters.statCalls[state.stage] ?? 0) + 1;
    return Reflect.apply(lstat, this, args);
  };
  if (pool) {
    pool.prototype.enqueue = function(file, ...args) {
      state.counters.workerSubmitted++;
      const result = poolEnqueue.call(this, file, ...args);
      state.counters.workerMaxPending = Math.max(state.counters.workerMaxPending, this.jobs.size);
      state.counters.workerMaxThreads = Math.max(state.counters.workerMaxThreads, this.slots.size);
      return result;
    };
    pool.prototype.read = async function(file) {
      const bucket = state.counters.reads[state.stage] ??= { calls: 0, bytes: 0, elapsedMs: 0, serviceMs: 0 };
      bucket.calls++; state.counters.readOrder.push(file.id);
      const started = performance.now();
      if (this.jobs.has(file.id) || this.slots.size) state.counters.workerConsumed++;
      try {
        const result = await poolRead.call(this, file);
        bucket.bytes += result.bytes; bucket.serviceMs += result.elapsedMs;
        return result;
      } finally { bucket.elapsedMs += performance.now() - started; }
    };
  } else reader.readSource = async function(file, sink, options) {
    const bucket = state.counters.reads[state.stage] ??= { calls: 0, bytes: 0, elapsedMs: 0 };
    bucket.calls++; state.counters.readOrder.push(file.id);
    const started = performance.now();
    try {
      return await read(file, sink, { ...options, onBytes: bytes => { bucket.bytes += bytes; options.onBytes?.(bytes); } });
    } finally { bucket.elapsedMs += performance.now() - started; }
  };
  source.includesSourceSnapshot = async function(current, previous, options) {
    state.counters.verificationCalls++;
    return verify(current, previous, { ...options, onBytes: bytes => {
      state.counters.verificationBytes += bytes; options.onBytes(bytes);
    } });
  };
  return () => {
    StageProfiler.prototype.measureAsync = asyncMeasure; fsp.lstat = lstat;
    reader.readSource = read; source.includesSourceSnapshot = verify;
    if (pool) { pool.prototype.read = poolRead; pool.prototype.enqueue = poolEnqueue; }
  };
}

function totals(db) {
  return { ...db.connection.prepare('SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens FROM turn_summary').get() };
}

function distribution(db) {
  return { ...totals(db), ...db.connection.prepare(`SELECT count(DISTINCT provider||':'||session_id) sessions,
    count(DISTINCT project_key) projects,min(started_at_ms) firstRequestAtMs,max(started_at_ms) lastRequestAtMs FROM turn_summary`).get(),
    providers: db.connection.prepare('SELECT provider,count(*) requests FROM turn_summary GROUP BY provider ORDER BY provider').all().map(row => ({ ...row })) };
}

function verify(db, product) {
  const { buildUsageQuery } = require(join(product, 'dist/src/summary/db/queries'));
  const checked = helpers.verify(db, buildUsageQuery, normalizedUsage), independent = {};
  for (const excludeEmptyUsage of [false, true]) for (const group of groups) {
    const usageFilter = { ...filter, excludeEmptyUsage };
    independent[`${group}/provider/excludeEmpty=${excludeEmptyUsage}`] = independentCheck(db, usageFilter, group, allUsageBy(db, group, usageFilter).map(retainedUsage));
    independent[`${group}/model/excludeEmpty=${excludeEmptyUsage}`] = independentModelCheck(db, usageFilter, group, allUsageBy(db, group, usageFilter, 'model').map(retainedUsage));
  }
  // 물리 ID와 갱신 시각만 제외하고 실제 DB 상태를 검증한다. 공개 결과에는 해시만 기록한다.
  const manifest = db.connection.prepare(`SELECT provider,path,source_root,session_id,size_bytes,mtime_ms,dev,inode,
    parser_version,capabilities_collected,source_identity,content_hash,processing_status,processing_position,last_error,source_missing
    FROM manifest ORDER BY provider,path`).all().map(helpers.normalized);
  return { ...checked, manifestSha256: sha(JSON.stringify(manifest)), independent };
}

async function worker(configPath, variant, pairText, work) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')), product = config.products[variant];
  filter = config.filter;
  omittedUsageFields = config.omittedUsageFields ?? [];
  const state = { stage: 'outside-refresh', counters: undefined };
  globalThis[profileKey] = state;
  const restore = installCounters(product, state, config.structure);
  const { refreshSummary, PARSER_VERSION } = loadScanner(product, variant, config.structure);
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  await fsp.mkdir(work, { recursive: true });
  const dbPath = join(work, 'summary.sqlite'), openStarted = performance.now();
  const db = new SummaryDatabase(dbPath), databaseOpenMs = performance.now() - openStarted, samples = [];
  const originalExec = db.connection.exec;
  const originalPrepare = db.connection.prepare;
  let metadataCounts;
  if (config.metadataCounters) db.connection.prepare = function(sql, ...args) {
    const statement = Reflect.apply(originalPrepare, this, [sql, ...args]), kind = metadataSqlKind(sql);
    if (!kind) return statement;
    for (const method of ['run', 'get', 'all', 'iterate']) {
      const execute = statement[method];
      statement[method] = function(...values) {
        if (metadataCounts) metadataCounts[kind]++;
        return Reflect.apply(execute, this, values);
      };
    }
    return statement;
  };
  let transactions, transactionStarted, beginReturned;
  db.connection.exec = function(sql) {
    const begin = /^\s*BEGIN IMMEDIATE\s*;?\s*$/i.test(sql), commit = /^\s*COMMIT\s*;?\s*$/i.test(sql);
    const started = transactions && begin ? performance.now() : undefined;
    const result = Reflect.apply(originalExec, this, [sql]);
    if (started !== undefined) { transactionStarted = started; beginReturned = performance.now(); }
    if (transactions && commit && transactionStarted !== undefined) {
      const ended = performance.now();
      transactions.push({ elapsedMs: ended - transactionStarted, beginMs: beginReturned - transactionStarted,
        heldMs: ended - beginReturned });
      transactionStarted = undefined;
    }
    return result;
  };
  let target;
  try {
    const activateStarted = performance.now();
    db.queryUsagePage(filter, 'day', timezone, { limit: 100 });
    const emptyRollupActivationMs = performance.now() - activateStarted;
    const rollupState = () => ({
      metadataRows: db.connection.prepare('SELECT count(*) n FROM usage_rollup_meta').get().n,
      requestDailyRows: db.connection.prepare('SELECT count(*) n FROM usage_request_daily').get().n,
      modelDailyRows: db.connection.prepare('SELECT count(*) n FROM usage_model_daily').get().n,
    });
    if (!config.rawRange) assert.equal(rollupState().metadataRows, 1, 'Empty day query must activate rollups');
    const { buildRollupUsageQueries } = require(join(product, 'dist/src/summary/db/rollup-queries'));
    const pragmas = Object.fromEntries(['journal_mode', 'synchronous', 'wal_autocheckpoint', 'cache_size', 'temp_store', 'mmap_size']
      .map(key => [key, Object.values(db.connection.prepare(`PRAGMA ${key}`).get())[0]]));
    async function measure(scenario) {
      const rollupBeforeRefresh = rollupState();
      state.counters = { statCalls: {}, reads: {}, readOrder: [], expansionIterations: 0, expansionFilesExamined: 0,
        expansionPendingSorted: 0, verificationCalls: 0, verificationBytes: 0, structureInstrumented: config.structure,
        queueAddAttempts: 0, queueEnqueued: 0, queueDequeued: 0, groupLookups: 0, groupMembersReturned: 0 };
      Object.assign(state.counters, { workerSubmitted: 0, workerConsumed: 0, workerMaxPending: 0, workerMaxThreads: 0 });
      transactions = [];
      if (config.metadataCounters) metadataCounts = { projectUpserts: 0, sessionUpserts: 0,
        sessionNameUpdates: 0, billingReads: 0, projectPrunes: 0, sessionPrunes: 0 };
      const refreshed = await refreshSummary(db, { dbPath, roots: config.snapshot.roots, timezone,
        collectCapabilities: true, retainDeletedSourceUsage: true });
      const metadataSql = metadataCounts; metadataCounts = undefined;
      const transactionSamples = transactions; transactions = undefined;
      assert.equal(refreshed.failed, 0); assert.equal(refreshed.interrupted, false); assert.equal(refreshed.error, undefined);
      const counters = state.counters; state.counters = undefined;
      const rollupAfterRefresh = rollupState();
      if (!config.rawRange) assert.equal(rollupAfterRefresh.metadataRows, 1, 'Measured refresh must retain active rollups');
      assert.equal(refreshed.bodyBytes, Object.values(counters.reads).reduce((sum, value) => sum + value.bytes, 0) + counters.verificationBytes);
      counters.readOrderSha256 = sha(JSON.stringify(counters.readOrder));
      counters.readSetSha256 = sha(JSON.stringify([...new Set(counters.readOrder)].sort((a, b) => a - b)));
      counters.sourceReadCalls = counters.readOrder.length; delete counters.readOrder;
      assert.equal(counters.workerSubmitted, counters.workerConsumed, 'No unused speculative source reads');
      assert.ok(counters.workerMaxThreads <= 4);
      assert.ok(counters.workerMaxPending <= 9);
      const queries = {};
      for (const by of ['provider', 'model']) for (const group of groups) {
        const started = performance.now(), page = allUsageBy(db, group, filter, by);
        queries[`${group}/${by}`] = { elapsedMs: performance.now() - started, groups: page.length,
          rowsSha256: sha(JSON.stringify(page.map(normalizedUsage))),
          queryMode: buildRollupUsageQueries(filter, group, timezone, by) && rollupState().metadataRows === 1 ? 'rollup-active' : 'raw-required' };
      }
      const { scanId: _scanId, completedAt: _completedAt, ...refresh } = refreshed;
      const sample = { scenario, refresh, counters, totals: totals(db), queries, rollupBeforeRefresh, rollupAfterRefresh,
        ...(metadataSql ? { metadataSql } : {}),
        transactions: { calls: transactionSamples.length,
          totalMs: transactionSamples.reduce((sum, value) => sum + value.elapsedMs, 0),
          beginMs: transactionSamples.reduce((sum, value) => sum + value.beginMs, 0),
          heldMs: transactionSamples.reduce((sum, value) => sum + value.heldMs, 0), samples: transactionSamples },
        topTwoPeerStages: peerStages.map(stage => ({ stage, ...refresh.timings.storage[stage] }))
          .filter(value => value.totalMs > 0).sort((a, b) => b.totalMs - a.totalMs).slice(0, 2),
        checked: verify(db, product) };
      sample.relatedControlMs = elapsed(refresh.timings.scan.expandRelated) - (counters.reads.expandRelated?.elapsedMs ?? 0);
      sample.changedControlMs = elapsed(refresh.timings.scan.parseChanged) - (counters.reads.parseChanged?.elapsedMs ?? 0);
      if (config.omittedUsageFields?.length) {
        const pragma = name => Object.values(db.connection.prepare(`PRAGMA ${name}`).get())[0];
        sample.space = { pageSize: pragma('page_size'), pageCount: pragma('page_count'), freelistCount: pragma('freelist_count'),
          requestColumns: db.connection.prepare('PRAGMA table_info(usage_request_daily)').all().length,
          modelColumns: db.connection.prepare('PRAGMA table_info(usage_model_daily)').all().length };
        try {
          sample.space.dailyTables = db.connection.prepare(`SELECT name,count(*) pages,sum(pgsize) bytes,sum(payload) payloadBytes
            FROM dbstat WHERE name IN ('usage_request_daily','usage_model_daily') GROUP BY name`).all().map(row => ({ ...row }));
        } catch { sample.space.dailyTables = null; }
      }
      samples.push(sample);
      process.send({ kind: 'sample', scenario, ms: refresh.timings.totalMs, parsed: refresh.parsed });
      return sample;
    }
    const initial = await measure('initial'), initialDistribution = distribution(db);
    if (config.snapshot.expected) assert.deepEqual(initial.totals,
      { requests: config.snapshot.expected.requests, tokens: config.snapshot.expected.tokens });
    const beforeRows = db.connection.prepare('SELECT * FROM turn_summary ORDER BY id').all().map(helpers.normalized);
    target = helpers.chooseTarget(db, 'codex', config.directory);
    await helpers.inspectCodexTarget(target, product);
    const targetSessionFiles = db.connection.prepare('SELECT count(*) n FROM manifest WHERE provider=? AND session_id=?')
      .get('codex', target.session_id).n;
    await helpers.appendRows(target, helpers.codexAppendRows(target, 'scan-queue-added-request', 'scan-queue-added-response'), config.directory, 1);
    const appended = await measure('append-one');
    assert.deepEqual(appended.totals, { requests: initial.totals.requests + 1, tokens: initial.totals.tokens + 130 });
    const added = db.connection.prepare('SELECT id FROM turn_summary WHERE root_turn_id=?').all('scan-queue-added-request');
    assert.equal(added.length, 1);
    const afterRows = db.connection.prepare('SELECT * FROM turn_summary WHERE id<>? ORDER BY id').all(added[0].id).map(helpers.normalized);
    assert.deepEqual(afterRows, beforeRows);
    const unchanged = await measure('unchanged');
    assert.deepEqual(unchanged.totals, appended.totals); assert.equal(unchanged.refresh.bodyBytes, 0);
    assert.equal(unchanged.refresh.parsed, 0); assert.deepEqual(unchanged.refresh.timings.storage, {});
    assert.equal(unchanged.checked.factsSha256, appended.checked.factsSha256);
    assert.equal(unchanged.checked.aggregatesSha256, appended.checked.aggregatesSha256);
    process.send({ kind: 'result', result: { variant, pair: Number(pairText), samples, initialDistribution, pragmas, databaseOpenMs, emptyRollupActivationMs,
      parserVersion: PARSER_VERSION, sqlite: db.connection.prepare('SELECT sqlite_version() version').get().version,
      appendTarget: { provider: 'codex', existingSessionRequests: target.requests, sessionSourceFiles: targetSessionFiles,
        sourceBytesBefore: target.originalBytes, inputTokens: 123, outputTokens: 7 } } });
  } finally {
    state.counters = undefined;
    if (target) { await fsp.truncate(target.path, target.originalBytes); await fsp.utimes(target.path, target.originalAtime, target.originalMtime); }
    transactions = undefined; metadataCounts = undefined;
    db.connection.exec = originalExec; db.connection.prepare = originalPrepare; db.close(); restore(); delete globalThis[profileKey];
  }
}

function runWorker(config, variant, pair, work) {
  return new Promise((done, fail) => {
    const child = fork(__filename, ['--worker', config, variant, String(pair), work], {
      execArgv: ['--no-warnings'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    let result, error = '';
    child.stderr.on('data', value => { error += value; });
    child.on('message', message => {
      if (message.kind === 'result') result = message.result;
      if (message.kind === 'sample') console.log(`${pair < 0 ? 'warmup' : 'pair'} ${pair + 1}/${variant}/${message.scenario}: ${message.ms.toFixed(3)} ms (${message.parsed} files)`);
    });
    child.on('error', fail);
    child.on('exit', code => code === 0 && result ? done(result) : fail(new Error(error.slice(-5000) || `Worker failed: ${code}`)));
  });
}

function assertPair(pair) {
  assert.deepEqual(pair.A.initialDistribution, pair.B.initialDistribution, 'Initial distribution');
  assert.deepEqual(pair.A.appendTarget, pair.B.appendTarget, 'Append target');
  for (const scenario of scenarios) {
    const a = pair.A.samples.find(sample => sample.scenario === scenario), b = pair.B.samples.find(sample => sample.scenario === scenario);
    assert.deepEqual(a.totals, b.totals, `Totals/${scenario}`);
    assert.deepEqual(a.checked, b.checked, `Semantic database and independent aggregates/${scenario}`);
    assert.deepEqual(a.rollupBeforeRefresh, b.rollupBeforeRefresh, `Rollup before refresh/${scenario}`);
    assert.deepEqual(a.rollupAfterRefresh, b.rollupAfterRefresh, `Rollup after refresh/${scenario}`);
    for (const key of ['parsed', 'failed', 'bodyBytes', 'reused', 'discovered']) assert.equal(a.refresh[key], b.refresh[key], `${scenario}/${key}`);
    for (const key of ['readOrderSha256', 'readSetSha256', 'sourceReadCalls']) assert.equal(a.counters[key], b.counters[key], `${scenario}/${key}`);
    for (const query of Object.keys(a.queries)) {
      assert.equal(a.queries[query].rowsSha256, b.queries[query].rowsSha256, `Query rows/${scenario}/${query}`);
      assert.equal(a.queries[query].groups, b.queries[query].groups, `Query count/${scenario}/${query}`);
      assert.equal(a.queries[query].queryMode, b.queries[query].queryMode, `Query mode/${scenario}/${query}`);
    }
  }
}

function summarize(trials) {
  const summary = {};
  for (const scenario of scenarios) {
    const entries = trials.map(pair => Object.fromEntries(['A', 'B'].map(variant =>
      [variant, pair[variant].samples.find(sample => sample.scenario === scenario)])));
    const metric = get => {
      const result = Object.fromEntries(['A', 'B'].map(variant => [variant, stats(entries.map(pair => get(pair[variant])))]));
      result.improvementPercent = result.A.medianMs ? (result.A.medianMs - result.B.medianMs) / result.A.medianMs * 100 : null;
      result.fasterPairs = entries.filter(pair => get(pair.B) < get(pair.A)).length;
      return result;
    };
    const stageKeys = [...new Set(entries.flatMap(pair => ['A', 'B'].flatMap(variant => Object.keys(pair[variant].refresh.timings.scan))))];
    const storageKeys = [...new Set(entries.flatMap(pair => ['A', 'B'].flatMap(variant => Object.keys(pair[variant].refresh.timings.storage))))];
    summary[scenario] = { total: metric(sample => sample.refresh.timings.totalMs),
      scan: Object.fromEntries(stageKeys.map(stage => [stage, metric(sample => elapsed(sample.refresh.timings.scan[stage]))])),
      storage: Object.fromEntries(storageKeys.map(stage => [stage, metric(sample => elapsed(sample.refresh.timings.storage[stage]))])),
      storageCalls: Object.fromEntries(storageKeys.map(stage => [stage, metric(sample => sample.refresh.timings.storage[stage]?.calls ?? 0)])),
      transactions: Object.fromEntries(['calls', 'totalMs', 'beginMs', 'heldMs'].map(key => [key, metric(sample => sample.transactions[key])])),
      peerRankA: peerStages.filter(stage => entries.some(pair => elapsed(pair.A.refresh.timings.storage[stage]) > 0))
        .map(stage => ({ stage, ...stats(entries.map(pair => elapsed(pair.A.refresh.timings.storage[stage]))) }))
        .sort((a, b) => b.medianMs - a.medianMs),
      queries: Object.fromEntries(Object.keys(entries[0].A.queries).map(query => [query, metric(sample => sample.queries[query].elapsedMs)])),
      relatedControl: metric(sample => sample.relatedControlMs), changedControl: metric(sample => sample.changedControlMs),
      counters: Object.fromEntries(['A', 'B'].map(variant => [variant, entries[0][variant].counters])) };
  }
  return summary;
}

async function main(args = process.argv.slice(2), experiment = {}) {
  const options = { workspace: '', before: '', after: '', output: '', pairs: 10, warmups: 3 };
  for (const arg of args) {
    if (arg === '--prepare-only' || arg === '--structure' || arg === '--raw-range' || arg === '--omit-obsolete-rollup-fields') continue;
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    assert.ok(match && Object.hasOwn(options, match[1]), 'Unknown or incomplete option');
    options[match[1]] = ['pairs', 'warmups'].includes(match[1]) ? Number(match[2]) : resolve(match[2]);
  }
  assert.ok(options.workspace && options.before, '--workspace and --before required');
  assert.ok(Number.isSafeInteger(options.pairs) && options.pairs > 0 && Number.isSafeInteger(options.warmups) && options.warmups >= 0);
  await fsp.mkdir(options.workspace, { recursive: true });
  const specs = [{ name: 'current', real: true }, { name: 'synthetic-10000', requests: 10000, 'turns-per-session': 100 }];
  const snapshots = [];
  for (const spec of specs) {
    const directory = join(options.workspace, spec.name), path = join(directory, 'snapshot.json');
    if (!fs.existsSync(path)) {
      await fsp.mkdir(directory, { recursive: true });
      const snapshot = await helpers.makeSnapshot(directory, { ...spec, after: options.before });
      await fsp.writeFile(path, JSON.stringify(snapshot));
    }
    snapshots.push({ ...spec, directory, snapshot: JSON.parse(fs.readFileSync(path, 'utf8')) });
  }
  if (args.includes('--prepare-only')) { console.log('Frozen inputs prepared'); return; }
  assert.ok(options.after && options.output, '--after and --output required for measurement');
  assert.ok(options.output.endsWith('.json'), '--output must end in .json');
  assert.equal(fs.existsSync(options.output), false, 'Never overwrite measurements');
  const products = { A: options.before, B: options.after };
  const rawRange = args.includes('--raw-range');
  if (rawRange) filter = { fromMs: -8640000000000000, toMs: 8640000000000000, ...filter };
  const structure = args.includes('--structure');
  const metadataCounters = Boolean(experiment.metadataCounters);
  const omittedUsageFields = args.includes('--omit-obsolete-rollup-fields')
    ? ['unknown_time_turns', 'stale_turns', 'last_successful_update'] : [];
  const trialDirectory = await fsp.mkdtemp(join(options.workspace, structure ? 'diagnostic-' : 'trials-'));
  const report = { dateSeoul: '2026-11-10', outputName: options.output.split(sep).pop(), startedAtSeoul: clock(), timezone, warmups: options.warmups, pairs: options.pairs,
    experiment: experiment.name ?? 'transaction-batch',
    entrypoint: relative(root, experiment.entrypoint ?? __filename).split(sep).join('/'),
    entrypointSha256: sha(fs.readFileSync(experiment.entrypoint ?? __filename)),
    environment: { node: process.version, platform: process.platform, release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    products: Object.fromEntries(['A', 'B'].map(variant => [variant,
      { source: fingerprint(join(products[variant], 'src')), build: fingerprint(join(products[variant], 'dist/src')) }])),
    runnerSha256: sha(fs.readFileSync(__filename)), helperSha256: Object.fromEntries(['incremental-refresh.cjs', 'temp-batch-ab.cjs']
      .map(name => [name, sha(fs.readFileSync(join(__dirname, name)))])),
    workspace: relative(root, options.workspace).split(sep).join('/'),
    trialWorkspace: relative(root, trialDirectory).split(sep).join('/'), structure, rawRange, filter, omittedUsageFields, metadataCounters,
    conditions: { cache: 'OS cache uncontrolled; no forced cache flush or GC; input freezing and product builds precede measurement; each variant uses a new process and new DB',
      trials: `${options.warmups} warmup pairs excluded, then ${options.pairs} AB/BA pairs per dataset; with zero warmups the first order is AB. Each initial build supplies the identical pre-append state for that trial`,
      timing: 'Product StageProfiler refresh through COMMIT/optimize; queries outside refresh; copy, process startup, DB open/migration, empty rollup activation, append, checks and source restoration excluded. Explicit BEGIN IMMEDIATE entry through COMMIT return is additionally measured by a lightweight exec wrapper; BEGIN elapsed includes uncontended lock acquisition and is reported separately. Storage peer stages are ranked without nested summaries/rollups child timers.',
      queries: 'All pages and total group counts for provider and model bases, fixed 2026-01-01 inclusive to 2027-01-01 exclusive Asia/Seoul calendar bounds, excludeEmptyUsage=true, unknownTime=include, costs excluded; first post-refresh query per grouping/basis. Independent JS facts reducers also validate excludeEmptyUsage=false outside query timers.',
      instrumentation: structure ? 'Optional structural-diagnostic label; the same StageProfiler, source read and transaction exec wrappers are installed for both variants'
        : 'Existing StageProfiler, logical source read wrappers and lightweight explicit BEGIN/COMMIT exec timestamps are identical in A and B; both variants use the same Worker pool and report its submission counts. Worker file stats are not intercepted; wrapper overhead is not separately calibrated',
      residual: 'Stage minus nested logical preparation wait; both A and B use the same Worker pool executing ahead in parallel, so this residual is coordinator overhead rather than Worker CPU time',
      metadataSqlCounters: metadataCounters ? 'Counts name INSERT/UPDATE, session billing SELECT and name pruning statement executions during refresh only; same prepare/run/get/all/iterate wrappers in both variants, overhead not calibrated' : 'disabled',
      exclusions: 'UI, extension-host IPC, quota, heap/GC peak, adversarial error/cancellation/rewrite scenarios and independent real-log parser oracle not measured; source-worker IPC is included' }, datasets: [] };
  for (const { name, directory, snapshot, ...spec } of snapshots) {
    for (const file of snapshot.files) assert.equal(sha(fs.readFileSync(file.path)), file.sha256, 'Frozen input must match original before trials');
    const work = join(trialDirectory, name); await fsp.mkdir(work, { recursive: true });
    const config = join(work, 'queue-config.json');
    await fsp.writeFile(config, JSON.stringify({ products, directory, snapshot, structure, filter, rawRange, omittedUsageFields, metadataCounters }));
    const entry = { name, inputSha256: snapshot.sha256, inventory: snapshot.inventory, expected: snapshot.expected ?? null,
      syntheticGeneration: spec.requests ? { seed: 'deterministic ordinal; no random generator', turnsPerSession: spec['turns-per-session'],
        providers: 'alternating sessions; equal requests', projects: 10, timestampRule: '2026-07-01 + sessionIndex % 14 days + turnIndex * 3 seconds' } : null,
      warmupChecks: [], trials: [] };
    for (let pair = -options.warmups; pair < options.pairs; pair++) {
      const both = {};
      for (const variant of ((pair + options.warmups) % 2 ? ['B', 'A'] : ['A', 'B'])) {
        both[variant] = await runWorker(config, variant, pair, join(work, `pair-${pair}/${variant}`));
      }
      assertPair(both);
      if (pair < 0) entry.warmupChecks.push({ pair, equal: true }); else entry.trials.push(both);
      await fsp.writeFile(join(options.workspace, 'partial-report.json'), JSON.stringify({ ...report, currentDataset: entry }, null, 2));
    }
    for (const file of snapshot.files) assert.equal(sha(fs.readFileSync(file.path)), file.sha256, 'Frozen sources restored');
    entry.distribution = entry.trials[0].A.initialDistribution; entry.appendTarget = entry.trials[0].A.appendTarget;
    entry.summary = summarize(entry.trials);
    entry.correctness = { allAbPairs: true, sameSourceReadSetAndOrder: true, semanticFactsAndManifest: true,
      rawSqlRollup10Dimensions: true, independentJsProviderAndModelAverages: true, exactAppendDelta: true,
      unchangedSkippedBodyAndReplaceMemory: true, frozenSourcesRestored: true, foreignKeysAndIntegrity: true,
      independentRealDataParserOracle: 'not performed; synthetic totals checked against generator' };
    report.environment.sqlite = entry.trials[0].A.sqlite; report.datasets.push(entry);
  }
  report.completedAtSeoul = clock();
  for (const variant of ['A', 'B']) assert.deepEqual(fingerprint(join(products[variant], 'dist/src')), report.products[variant].build);
  await fsp.mkdir(dirname(options.output), { recursive: true });
  await fsp.writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Saved ${relative(root, options.output)}`);
}

module.exports = { main };

if (require.main === module && process.argv[2] === '--worker') worker(...process.argv.slice(3)).then(() => process.disconnect(), error => {
  console.error(error); process.exitCode = 1; process.disconnect();
});
else if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
