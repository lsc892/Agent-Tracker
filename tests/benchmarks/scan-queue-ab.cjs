// 고정된 두 제품과 같은 입력에서 관계 색인·작업 큐의 구간 시간과 집계 의미를 비교한다.
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const Module = require('node:module');
const { cpus, release } = require('node:os');
const { dirname, join, relative, resolve, sep } = require('node:path');
const { performance } = require('node:perf_hooks');
const helpers = require('./incremental-refresh.cjs');
const { allUsage, independentCheck, stats } = require('./temp-batch-ab.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul';
const groups = ['day', 'month', 'session', 'project'], scenarios = ['initial', 'append-one', 'unchanged'];
const sha = value => createHash('sha256').update(value).digest('hex');
const clock = () => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const profileKey = Symbol.for('agent-tracker.scan-queue-ab');
let filter = { unknownTime: 'include', excludeEmptyUsage: true };
const elapsed = value => typeof value === 'number' ? value : value?.totalMs ?? 0;

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

function loadScanner(product, variant, structure) {
  const path = require.resolve(join(product, 'dist/src/summary/scanner'));
  if (variant !== 'A' || !structure) return require(path);
  const original = Module._extensions['.js'];
  Module._extensions['.js'] = function(module, filename) {
    if (filename !== path) return original(module, filename);
    let code = fs.readFileSync(filename, 'utf8');
    const replaceOnce = (from, to) => {
      assert.equal(code.split(from).length, 2, `Instrumentation anchor changed: ${from}`);
      code = code.replace(from, to);
    };
    replaceOnce('async function expandRelatedSources() {',
      "async function expandRelatedSources() {\n        const counts = globalThis[Symbol.for('agent-tracker.scan-queue-ab')].counters;");
    replaceOnce('            resolveLineage();',
      '            counts.expansionIterations++; counts.expansionFilesExamined += files.size;\n            resolveLineage();');
    replaceOnce('            pending.sort((a, b) => a.id - b.id);',
      '            counts.expansionPendingSorted += pending.length;\n            pending.sort((a, b) => a.id - b.id);');
    module._compile(code, filename);
  };
  try { return require(path); }
  finally { Module._extensions['.js'] = original; }
}

function installCounters(product, state, structure) {
  const { StageProfiler } = require(join(product, 'dist/src/summary/profiling'));
  const reader = require(join(product, 'dist/src/summary/scanner/sourceReader'));
  const source = require(join(product, 'dist/src/summary/scanner/sourceFingerprint'));
  const asyncMeasure = StageProfiler.prototype.measureAsync, lstat = fsp.lstat;
  const read = reader.readSource, verify = source.includesSourceSnapshot;
  let restoreQueue = () => {};
  if (structure && fs.existsSync(join(product, 'dist/src/summary/scanner/worklist.js'))) {
    const { SourceQueue, OrderedGroups } = require(join(product, 'dist/src/summary/scanner/worklist'));
    const add = SourceQueue.prototype.add, take = SourceQueue.prototype.take, members = OrderedGroups.prototype.members;
    SourceQueue.prototype.add = function(value) {
      const before = this.heap.length;
      const result = add.call(this, value);
      if (state.counters) {
        state.counters.queueAddAttempts++;
        state.counters.queueEnqueued += Number(this.heap.length > before);
      }
      return result;
    };
    SourceQueue.prototype.take = function() {
      const result = take.call(this);
      if (state.counters && result) state.counters.queueDequeued++;
      return result;
    };
    OrderedGroups.prototype.members = function(keys) {
      const result = members.call(this, keys);
      if (state.counters) { state.counters.groupLookups++; state.counters.groupMembersReturned += result.length; }
      return result;
    };
    restoreQueue = () => {
      SourceQueue.prototype.add = add; SourceQueue.prototype.take = take; OrderedGroups.prototype.members = members;
    };
  }
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
  reader.readSource = async function(file, sink, options) {
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
    reader.readSource = read; source.includesSourceSnapshot = verify; restoreQueue();
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
  const checked = helpers.verify(db, buildUsageQuery), independent = {};
  for (const group of groups) independent[group] = independentCheck(db, filter, group, allUsage(db, group, filter));
  // 물리 ID와 갱신 시각만 제외하고 실제 DB 상태를 검증한다. 공개 결과에는 해시만 기록한다.
  const manifest = db.connection.prepare(`SELECT provider,path,source_root,session_id,size_bytes,mtime_ms,dev,inode,
    parser_version,capabilities_collected,source_identity,content_hash,processing_status,processing_position,last_error,source_missing
    FROM manifest ORDER BY provider,path`).all().map(helpers.normalized);
  return { ...checked, manifestSha256: sha(JSON.stringify(manifest)), independent };
}

async function worker(configPath, variant, pairText, work) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')), product = config.products[variant];
  filter = config.filter;
  const state = { stage: 'outside-refresh', counters: undefined };
  globalThis[profileKey] = state;
  const restore = installCounters(product, state, config.structure);
  const { refreshSummary, PARSER_VERSION } = loadScanner(product, variant, config.structure);
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  await fsp.mkdir(work, { recursive: true });
  const dbPath = join(work, 'summary.sqlite'), db = new SummaryDatabase(dbPath), samples = [];
  let target;
  try {
    db.queryUsagePage(filter, 'day', timezone, { limit: 100 });
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
      const refreshed = await refreshSummary(db, { dbPath, roots: config.snapshot.roots, timezone,
        collectCapabilities: true, retainDeletedSourceUsage: true });
      assert.equal(refreshed.failed, 0); assert.equal(refreshed.interrupted, false); assert.equal(refreshed.error, undefined);
      const counters = state.counters; state.counters = undefined;
      const rollupAfterRefresh = rollupState();
      if (!config.rawRange) assert.equal(rollupAfterRefresh.metadataRows, 1, 'Measured refresh must retain active rollups');
      assert.equal(refreshed.bodyBytes, Object.values(counters.reads).reduce((sum, value) => sum + value.bytes, 0) + counters.verificationBytes);
      counters.readOrderSha256 = sha(JSON.stringify(counters.readOrder));
      counters.readSetSha256 = sha(JSON.stringify([...new Set(counters.readOrder)].sort((a, b) => a - b)));
      counters.sourceReadCalls = counters.readOrder.length; delete counters.readOrder;
      const queries = {};
      for (const group of groups) {
        const started = performance.now(), page = allUsage(db, group, filter);
        queries[group] = { elapsedMs: performance.now() - started, groups: page.length,
          rowsSha256: sha(JSON.stringify(page.map(helpers.normalized))),
          queryMode: buildRollupUsageQueries(filter, group, timezone, 'provider') && rollupState().metadataRows === 1 ? 'rollup-active' : 'raw-required' };
      }
      const { scanId: _scanId, completedAt: _completedAt, ...refresh } = refreshed;
      const sample = { scenario, refresh, counters, totals: totals(db), queries, rollupBeforeRefresh, rollupAfterRefresh, checked: verify(db, product) };
      sample.relatedControlMs = elapsed(refresh.timings.scan.expandRelated) - (counters.reads.expandRelated?.elapsedMs ?? 0);
      sample.changedControlMs = elapsed(refresh.timings.scan.parseChanged) - (counters.reads.parseChanged?.elapsedMs ?? 0);
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
    process.send({ kind: 'result', result: { variant, pair: Number(pairText), samples, initialDistribution, pragmas,
      parserVersion: PARSER_VERSION, sqlite: db.connection.prepare('SELECT sqlite_version() version').get().version,
      appendTarget: { provider: 'codex', existingSessionRequests: target.requests, sessionSourceFiles: targetSessionFiles,
        sourceBytesBefore: target.originalBytes, inputTokens: 123, outputTokens: 7 } } });
  } finally {
    state.counters = undefined;
    if (target) { await fsp.truncate(target.path, target.originalBytes); await fsp.utimes(target.path, target.originalAtime, target.originalMtime); }
    db.close(); restore(); delete globalThis[profileKey];
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
    for (const group of groups) {
      assert.equal(a.queries[group].rowsSha256, b.queries[group].rowsSha256, `Query rows/${scenario}/${group}`);
      assert.equal(a.queries[group].groups, b.queries[group].groups, `Query count/${scenario}/${group}`);
      assert.equal(a.queries[group].queryMode, b.queries[group].queryMode, `Query mode/${scenario}/${group}`);
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
      queries: Object.fromEntries(groups.map(group => [group, metric(sample => sample.queries[group].elapsedMs)])),
      relatedControl: metric(sample => sample.relatedControlMs), changedControl: metric(sample => sample.changedControlMs),
      counters: Object.fromEntries(['A', 'B'].map(variant => [variant, entries[0][variant].counters])) };
  }
  return summary;
}

function markdown(report) {
  const cell = value => value ? `${value.A.medianMs.toFixed(3)} → ${value.B.medianMs.toFixed(3)} (${value.improvementPercent === null ? 'N/A' : `${value.improvementPercent.toFixed(1)}%`})` : '미실행';
  const labels = { lock: '잠금 획득', discover: '탐색·stat·manifest 비교와 색인 준비', names: '표시 이름 읽기',
    parseChanged: '변경 원본 처리', expandRelated: '관련 원본 확장(재읽기 포함)', resolveParents: '부모 요청 확정',
    reconnect: '이동 원본 연결', aggregate: 'winner·요청 집계', commitComponents: '성분별 저장 조율',
    finishScan: '마무리·관측 기록', optimize: 'optimize', readSources: 'readSource(상위 구간과 중첩)' };
  const scenariosNamed = { initial: '최초 수집', 'append-one': '1건 추가', unchanged: '무변경' };
  const current = report.datasets.find(data => data.name === 'current');
  const inventory = data => `${data.inventory.reduce((n, item) => n + item.files, 0)}파일·${data.inventory.reduce((n, item) => n + item.bytes, 0).toLocaleString('en')}byte`;
  const columns = report.datasets.map(data => data.name === 'current' ? `현재 ${data.distribution.requests.toLocaleString('en')}요청` : '합성 10,000요청');
  const summaryRows = [
    ['최초 수집·저장', data => data.summary.initial.total],
    ['요청 1건 추가·갱신·COMMIT', data => data.summary['append-one'].total],
    ['변경 없는 갱신', data => data.summary.unchanged.total],
    ...groups.map(group => [{ day: '일', month: '월', session: '세션', project: '프로젝트' }[group] + '별 평균 토큰 조회', data => data.summary['append-one'].queries[group]]),
  ];
  let text = `# 관계 역인덱스·작업 큐 A/B 테스트\n\n${report.startedAtSeoul}–${report.completedAtSeoul}, Asia/Seoul.\n\n가정: 사용자는 관계 ID별 파일 집합과 중복 제거 작업 큐를 적용하고 watcher는 보류하도록 지시했다. 에이전트의 가정은 관련 확장의 전체 목록 반복 검색·정렬과 성분별 전체 filter를 줄이면 관계 처리와 최초 저장 조율 비용이 감소하지만, 관련 원본 재읽기를 유지하므로 append 전체 개선은 제한될 수 있다는 것이다.\n\n개선 방향: A = 구현 직전 미커밋 작업 트리의 고정 소스·빌드. B = session/source identity/inode 후보 색인, ID 우선순위 작업 큐, 성분별 멤버·요청·진단 그룹 색인. watcher·metadata 동시성·append checkpoint·파서/저장 schema 변경은 포함하지 않는다.\n\n## 1. 결과\n\n각 셀은 A → B 중앙값 ms (개선율)이다. 개선율 = (A−B)/A×100이며 양수는 개선, 음수는 악화다. 준비 ${report.warmups}쌍을 제외하고 AB/BA 교대 ${report.pairs}쌍을 측정했다.\n\n| 측정 항목 | ${columns.join(' | ')} |\n| --- | ${columns.map(() => '---:').join(' | ')} |\n${summaryRows.map(([label, get]) => `| ${label} | ${report.datasets.map(data => cell(get(data))).join(' | ')} |`).join('\n')}\n\n현재 입력은 ${inventory(current)}이며 요청 ${current.distribution.requests}건·세션 ${current.distribution.sessions}개·프로젝트 ${current.distribution.projects}개다. 합성 입력은 ${inventory(report.datasets[1])}, 100세션·세션당 100요청·10프로젝트이며 Claude/Codex가 각 5,000요청이다. 합성 토큰 산식의 기대값은 6,340,000 tokens다. 난수 없는 ordinal 산식으로 2026-07-01부터 14일에 배치했으며 실제와 합성은 본문 크기·압축·관계 분포가 다르다. 10,000은 파일 수가 아닌 정규화 요청 수다.\n\n## 2. 구간별 시간\n\n각 열은 위와 같은 A → B 중앙값 ms (개선율)이다. readSource는 변경 처리·관련 확장의 하위 구간이므로 합산하지 않는다. 각 구간 중앙값의 합도 전체 중앙값과 정확히 일치하지 않을 수 있다.\n`;
  for (const data of report.datasets) {
    text += `\n### ${data.name === 'current' ? '현재 고정 사본' : '합성 10,000요청'}\n\n| 구간 | 최초 수집 | 1건 추가 | 무변경 |\n| --- | ---: | ---: | ---: |\n`;
    for (const [key, label] of Object.entries(labels)) text += `| ${label} | ${scenarios.map(scenario => cell(data.summary[scenario].scan[key])).join(' | ')} |\n`;
    text += `| 관련 확장−내부 readSource 잔여 시간 | ${scenarios.map(scenario => cell(data.summary[scenario].relatedControl)).join(' | ')} |\n`;
    text += '\n잔여 시간은 계보 판정·검색/큐·콜백·타이머 부하를 포함하며 순수 그래프 탐색 CPU 시간으로 해석하지 않는다.\n';
  }
  text += '\n## 3. 변동 범위와 저장 내부\n\n| 입력·시나리오 | A 중앙값 [최소–최대] ms | B 중앙값 [최소–최대] ms | B가 빠른 쌍 |\n| --- | ---: | ---: | ---: |\n';
  for (const data of report.datasets) for (const scenario of scenarios) {
    const value = data.summary[scenario].total;
    text += `| ${data.name}·${scenariosNamed[scenario]} | ${value.A.medianMs.toFixed(3)} [${value.A.minMs.toFixed(3)}–${value.A.maxMs.toFixed(3)}] | ${value.B.medianMs.toFixed(3)} [${value.B.minMs.toFixed(3)}–${value.B.maxMs.toFixed(3)}] | ${value.fasterPairs}/${report.pairs} |\n`;
  }
  text += '\n| SQL 저장 구간 | 현재 최초 | 현재 +1 | 10,000 최초 | 10,000 +1 |\n| --- | ---: | ---: | ---: | ---: |\n';
  for (const [key, label] of [['replace', 'replaceMemory 전체'], ['summaries', '요청 비교·쓰기'], ['summaryWrites', 'facts·모델·Skill·비용 쓰기'], ['rollups', 'rollup 유지'], ['commit', 'COMMIT']]) {
    text += `| ${label} | ${report.datasets.flatMap(data => ['initial', 'append-one'].map(scenario => cell(data.summary[scenario].storage[key]))).join(' | ')} |\n`;
  }
  text += `\n저장 항목은 서로 중첩된다. COMMIT은 WAL 동기화·가능한 checkpoint·OS 대기를 포함할 수 있다. 두 구현 모두 연결 성분별 transaction이며 무변경 갱신은 replaceMemory를 실행하지 않았다.\n\n## 4. 정확성과 측정 조건\n\n- 모든 준비·측정 A/B 쌍에서 요청·모델·Skill·비용·프로젝트·세션·manifest 진단 의미해시와 provider/model 기준 total·project·session·day·month의 10차원 조회가 일치했다. 물리 ID와 갱신 시각만 정규화 제외했다.\n- 네 평균은 정규화 요청을 별도 JS reducer로 계산한 합계·완료 분모·평균·그룹 수와 대조했다. 평균의 분모는 완료 요청 중 사용량이 기록된 요청이다. 고정 전체 기간, 미상 시각 포함, provider 기준, 비용 제외, Asia/Seoul로 전체 페이지를 반환했다.\n- 합성 초기값은 생성기 산식과 일치했다. 추가는 정확히 +1요청·+130토큰이고 기존 요청 행은 유지됐다. 현재 실제 본문의 초기 파서 결과 전체에 대한 독립 oracle은 수행하지 않았다.\n- 모든 쌍에서 읽은 원본 집합과 읽기 순서 해시·파싱 수·본문 바이트·실패 수가 일치했다. 무변경은 본문0byte·파싱0·replaceMemory0이며 FK·integrity 검사를 통과했다.\n- 환경: ${report.environment.platform} ${report.environment.release}, Node ${report.environment.node}, SQLite ${report.environment.sqlite}, ${report.environment.cpu}. OS 캐시는 비우지 않았고 입력 사본 및 선행 실행으로 warm 상태다. 강제 GC는 하지 않았다.\n- 각 variant/표본은 별도 프로세스·새 DB에서 최초 구축 후 같은 추가 전 상태를 만든다. DB 열기·migration·빈 rollup 활성화·사본 생성·append·검증·복원·조회는 refresh 타이머 밖이다. 갱신 시간은 실제 refreshSummary의 COMMIT·optimize 반환까지다.\n- 제품 StageProfiler와 동일한 stat/read wrapper를 사용했다. 큐 메서드별 계측은 본 시간 표본에 추가하지 않았다. 계측 오버헤드는 별도 보정하지 않았다. UI·IPC·quota·heap/GC peak는 미측정이다.\n- 입력 SHA-256과 A/B 전체 소스·빌드 fingerprint, runner/helper SHA-256, 모든 표본은 [원시 JSON](./ScanQueueAB-2026-11-09.json)에 있다. 원본 대화와 설치 DB는 변경하지 않았으며 고정 사본 복원 SHA-256을 확인했다. 공개 결과에는 본문·제목·세션 ID·원본 경로를 저장하지 않는다.\n\n## 5. 분석\n\n<!-- 구조 진단과 본 측정 결과를 확인한 뒤 판정·핵심 원인·선택을 기록한다. -->\n\n## 6. 재실행\n\n\`node --no-warnings tests/benchmarks/scan-queue-ab.cjs --workspace=<기존 고정 사본 폴더 또는 새 폴더> --before=<A 고정 소스·dist 루트> --after=<B 고정 소스·dist 루트> --output=<새 JSON>\`\n\n기본은 준비3쌍·교대10쌍이다. \`--prepare-only\`는 A를 기준으로 현재·합성 입력 사본만 만든다. \`--structure --pairs=1 --warmups=0\`는 별도 구조 진단용이며 그 시간은 본 중앙값에 섞지 않는다. 기존 JSON은 덮어쓰지 않고 각 실행의 DB를 새 비공개 하위 폴더에 보존한다.\n`;
  return text;
}

async function main() {
  const options = { workspace: '', before: '', after: '', output: '', pairs: 10, warmups: 3 };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--prepare-only' || arg === '--structure' || arg === '--raw-range') continue;
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
  if (process.argv.includes('--prepare-only')) { console.log('Frozen inputs prepared'); return; }
  assert.ok(options.after && options.output, '--after and --output required for measurement');
  assert.ok(options.output.endsWith('.json'), '--output must end in .json');
  assert.equal(fs.existsSync(options.output), false, 'Never overwrite measurements');
  const products = { A: options.before, B: options.after };
  const rawRange = process.argv.includes('--raw-range');
  if (rawRange) filter = { fromMs: -8640000000000000, toMs: 8640000000000000, ...filter };
  const structure = process.argv.includes('--structure');
  const trialDirectory = await fsp.mkdtemp(join(options.workspace, structure ? 'diagnostic-' : 'trials-'));
  const report = { dateSeoul: '2026-11-09', startedAtSeoul: clock(), timezone, warmups: options.warmups, pairs: options.pairs,
    environment: { node: process.version, platform: process.platform, release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    products: Object.fromEntries(['A', 'B'].map(variant => [variant,
      { source: fingerprint(join(products[variant], 'src')), build: fingerprint(join(products[variant], 'dist/src')) }])),
    runnerSha256: sha(fs.readFileSync(__filename)), helperSha256: Object.fromEntries(['incremental-refresh.cjs', 'temp-batch-ab.cjs']
      .map(name => [name, sha(fs.readFileSync(join(__dirname, name)))])),
    workspace: relative(root, options.workspace).split(sep).join('/'),
    trialWorkspace: relative(root, trialDirectory).split(sep).join('/'), structure, rawRange, filter,
    conditions: { cache: 'OS cache uncontrolled, warmed by freezing and prior trials; no forced GC; each variant uses a new process and new DB',
      trials: 'Three warmup pairs excluded, then ten alternating AB/BA pairs per dataset unless CLI overrides; each initial build supplies the identical pre-append state for that trial',
      timing: 'Product StageProfiler refresh through COMMIT/optimize; queries outside refresh; copy, process startup, DB open/migration, empty rollup activation, append, checks and source restoration excluded',
      queries: 'All pages and total group counts, provider basis, full frozen input with no date boundaries, excludeEmptyUsage=true, unknownTime=include, Asia/Seoul; first post-refresh query per grouping; metadata and eligibility recorded',
      instrumentation: structure ? 'Separate structural diagnostic: baseline expansion counters and candidate queue/group wrappers; times excluded from main A/B medians'
        : 'Existing StageProfiler plus identical lstat/read wrappers; no queue/group wrappers; overhead not separately calibrated',
      residual: 'relatedControlMs = expandRelated stage minus nested readSource elapsed; includes lineage, queue/search, callbacks and timer overhead; not pure graph search CPU time',
      exclusions: 'UI, IPC, quota calls, heap/GC peak and independent real-log parser oracle not measured' }, datasets: [] };
  for (const { name, directory, snapshot, ...spec } of snapshots) {
    for (const file of snapshot.files) assert.equal(sha(fs.readFileSync(file.path)), file.sha256, 'Frozen input must match original before trials');
    const work = join(trialDirectory, name); await fsp.mkdir(work, { recursive: true });
    const config = join(work, 'queue-config.json');
    await fsp.writeFile(config, JSON.stringify({ products, directory, snapshot, structure, filter, rawRange }));
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
      rawSqlRollup10Dimensions: true, independentJsAverages: true, exactAppendDelta: true,
      unchangedSkippedBodyAndReplaceMemory: true, frozenSourcesRestored: true, foreignKeysAndIntegrity: true,
      independentRealDataParserOracle: 'not performed; synthetic totals checked against generator' };
    report.environment.sqlite = entry.trials[0].A.sqlite; report.datasets.push(entry);
  }
  report.completedAtSeoul = clock();
  for (const variant of ['A', 'B']) assert.deepEqual(fingerprint(join(products[variant], 'dist/src')), report.products[variant].build);
  await fsp.mkdir(dirname(options.output), { recursive: true });
  await fsp.writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  if (!structure) await fsp.writeFile(options.output.replace(/\.json$/, '.md'), markdown(report), { flag: 'wx' });
  console.log(`Saved ${relative(root, options.output)}`);
}

if (process.argv[2] === '--worker') worker(...process.argv.slice(3)).then(() => process.disconnect(), error => {
  console.error(error); process.exitCode = 1; process.disconnect();
});
else main().catch(error => { console.error(error); process.exitCode = 1; });
