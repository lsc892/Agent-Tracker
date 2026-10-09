const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { statSync, openSync, writeSync, closeSync, createReadStream, createWriteStream } = require('node:fs');
const { mkdtemp, mkdir, readdir, lstat, open, utimes, rm, writeFile, readFile } = require('node:fs/promises');
const { tmpdir, cpus } = require('node:os');
const { basename, dirname, join, relative, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createGzip } = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const { SummaryStaging } = require('../../dist/src/summary/staging');
const { refreshSummary, PARSER_VERSION } = require('../../dist/src/summary/scanner');
const { SCHEMA_VERSION } = require('../../dist/src/summary/db/schema');
const { readConfiguration } = require('../../dist/src/configuration');
const { withoutTitleIndex, titleTempSpace } = require('../../dist/tests/fixtures/request-title-ab');

const VARIANTS = ['baseline', 'partial-index'];
const SCENARIOS = ['initial', 'rebuild', 'unchanged'];
const sha = value => createHash('sha256').update(value).digest('hex');
const seoulTime = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone:'Asia/Seoul', dateStyle:'short', timeStyle:'medium',
}).format(new Date());

async function removeWorkspace(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('agent-tracker-title-transactions-'));
  await rm(directory, { recursive:true, force:true });
}

/** Copy only the byte range observed at open; never buffer a whole transcript. */
async function freezeFile(source, target) {
  await mkdir(dirname(target), { recursive:true });
  const input = await open(source, 'r');
  let output;
  try {
    const before = await input.stat();
    assert.ok(before.isFile());
    output = await open(target, 'wx');
    const buffer = Buffer.alloc(64 * 1024);
    const digest = createHash('sha256');
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      assert.ok(bytesRead > 0, 'Source shrank during snapshot');
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, offset + written);
        assert.ok(result.bytesWritten > 0);
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    const after = await input.stat();
    assert.ok(after.size >= before.size && (after.size > before.size || after.mtimeMs === before.mtimeMs),
      'Source was rewritten during snapshot');
    await output.close(); output = undefined;
    await utimes(target, before.atime, before.mtime);
    return { bytes:offset, digest:digest.digest('hex') };
  } finally { await output?.close(); await input.close(); }
}

async function* jsonlFiles(directory) {
  const stat = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
  const entries = await readdir(directory, { withFileTypes:true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(path);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) yield path;
  }
}

/** Retain just the title columns read by the product, in one read-only source transaction. */
async function freezeNames(home, target) {
  await mkdir(target, { recursive:true });
  let indexBytes = 0;
  const index = join(home, 'session_index.jsonl');
  const stat = await lstat(index).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (stat?.isFile() && !stat.isSymbolicLink()) indexBytes = (await freezeFile(index, join(target, 'session_index.jsonl'))).bytes;
  const entries = await readdir(home).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const name = entries.filter(value => /^state_\d+\.sqlite$/.test(value))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  let threads = 0;
  if (name && !(await lstat(join(home, name))).isSymbolicLink()) {
    const source = new DatabaseSync(join(home, name), { readOnly:true });
    let output;
    try {
      source.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON; BEGIN');
      const columns = source.prepare('PRAGMA table_info(threads)').all().map(row => row.name);
      if (columns.includes('id') && columns.includes('title')) {
        output = new DatabaseSync(join(target, name));
        output.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT); BEGIN');
        const insert = output.prepare('INSERT INTO threads VALUES (?,?,?)');
        for (const row of source.prepare(`SELECT id,title,${columns.includes('name') ? 'name' : 'NULL'} AS name FROM threads`).iterate()) {
          insert.run(row.id, row.title, row.name); threads++;
        }
        output.exec('COMMIT');
      }
      source.exec('COMMIT');
    } finally { output?.close(); source.close(); }
  }
  return { indexBytes, threads };
}

async function makeSnapshot(directory, real) {
  const frozenRoots = [];
  const inventory = [];
  const fingerprint = createHash('sha256');
  const homeMap = new Map();
  const config = readConfiguration({ get:(_key, fallback) => fallback });
  const roots = real ? config.roots : [{ provider:'codex', path:join(directory, 'fixture'), dataHome:join(directory, 'fixture-home') }];
  if (!real) {
    await mkdir(roots[0].path);
    const rows = [{ type:'session_meta', payload:{ id:'fixture', cwd:'/fixture/project' } }];
    for (let index = 0; index < 30; index++) rows.push(
      { type:'event_msg', timestamp:new Date(Date.UTC(2026, 9, 8) + index * 2000).toISOString(), payload:{ type:'task_started', turn_id:`r${index}` } },
      { type:'event_msg', payload:{ type:'user_message', message:`Title ${index}` } },
      { type:'turn_context', payload:{ turn_id:`r${index}`, model:'gpt-5.6-sol' } },
      { type:'token_usage_record', payload:{ turn_id:`r${index}`, response_id:`response${index}`, usage:{ input_tokens:10, output_tokens:5 } } },
      { type:'event_msg', payload:{ type:'task_complete', turn_id:`r${index}` } },
    );
    await writeFile(join(roots[0].path, 'fixture.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  for (const [index, root] of roots.entries()) {
    const path = join(directory, 'snapshot', `root-${index}`);
    await mkdir(path, { recursive:true });
    let dataHome = join(directory, 'snapshot', `home-${index}`);
    let metadata = { indexBytes:0, threads:0 };
    if (root.provider === 'codex') {
      const originalHome = resolve(root.dataHome ?? dirname(root.path));
      if (homeMap.has(originalHome)) ({ dataHome, metadata } = homeMap.get(originalHome));
      else {
        metadata = await freezeNames(originalHome, dataHome);
        homeMap.set(originalHome, { dataHome, metadata });
      }
    }
    let files = 0, bytes = 0;
    for await (const source of jsonlFiles(root.path)) {
      const name = relative(root.path, source);
      const copy = await freezeFile(source, join(path, name));
      fingerprint.update(JSON.stringify([root.provider, index, name, copy.bytes, copy.digest]));
      files++; bytes += copy.bytes;
    }
    frozenRoots.push({ provider:root.provider, path, dataHome });
    inventory.push({ provider:root.provider, rootOrdinal:index, files, bytes, titleMetadata:metadata });
  }
  assert.ok(inventory.some(root => root.files > 0), 'No conversation JSONL files found');
  return { roots:frozenRoots, inventory, fingerprint:fingerprint.digest('hex') };
}

function resources(database) {
  const connection = database.connection;
  const page = schema => {
    const size = connection.prepare(`PRAGMA ${schema}.page_size`).get().page_size;
    const count = connection.prepare(`PRAGMA ${schema}.page_count`).get().page_count;
    const free = connection.prepare(`PRAGMA ${schema}.freelist_count`).get().freelist_count;
    return { allocatedBytes:size * count, liveBytes:size * (count - free), freeBytes:size * free };
  };
  return { rssBytes:process.memoryUsage().rss, heapUsedBytes:process.memoryUsage().heapUsed,
    main:page('main'), temp:page('temp') };
}

function outputDigest(connection) {
  const digest = createHash('sha256');
  const tables = [
    ['turn_summary', 'SELECT * FROM turn_summary ORDER BY provider,session_id,root_turn_id'],
    ['turn_model_usage', 'SELECT t.provider,t.session_id,t.root_turn_id,u.* FROM turn_summary t JOIN turn_model_usage u ON u.turn_id=t.id ORDER BY t.provider,t.session_id,t.root_turn_id,u.model'],
    ['turn_capability_usage', 'SELECT t.provider,t.session_id,t.root_turn_id,u.* FROM turn_summary t JOIN turn_capability_usage u ON u.turn_id=t.id ORDER BY t.provider,t.session_id,t.root_turn_id,u.category,u.name'],
    ['turn_costs', 'SELECT t.provider,t.session_id,t.root_turn_id,u.* FROM turn_summary t JOIN turn_costs u ON u.turn_id=t.id ORDER BY t.provider,t.session_id,t.root_turn_id'],
    ['projects', 'SELECT * FROM projects ORDER BY project_key'],
    ['sessions', 'SELECT * FROM sessions ORDER BY provider,session_id'],
    ['manifest', 'SELECT provider,session_id,size_bytes,parser_version,capabilities_collected,processing_status,processing_position,last_error FROM manifest ORDER BY id'],
  ];
  for (const [name, sql] of tables) {
    digest.update(name);
    for (const raw of connection.prepare(sql).iterate()) {
      const row = { ...raw };
      // Refresh timestamps and physical row references are not semantic output.
      for (const key of ['id', 'turn_id', 'updated_at', 'diagnostic_file_id']) delete row[key];
      digest.update(JSON.stringify(row));
    }
  }
  return digest.digest('hex');
}

async function worker() {
  const [, configPath, variant, pairText, directory] = process.argv.slice(2);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const database = new SummaryDatabase(join(directory, 'summary.sqlite'));
  const connection = database.connection;
  const records = [];
  const logPath = join(directory, 'transactions.jsonl');
  const logFile = openSync(logPath, 'wx');
  let logBuffer = [], logBytes = 0, baselineSqlSha256;
  let scenario, component = 0, phase, purpose = 'persistent-other', transaction, sqlText;
  let observerMs = 0;
  let counters;
  const observe = action => { const start = performance.now(); try { return action(); } finally { observerMs += performance.now() - start; } };
  const flushLog = () => {
    const buffer = Buffer.from(logBuffer.join(''));
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(logFile, buffer, offset, buffer.length - offset);
    logBuffer = []; logBytes = 0;
  };
  const emit = record => {
    for (const value of [record.before, record.after].filter(Boolean)) {
      counters.maxTempAllocatedBytes = Math.max(counters.maxTempAllocatedBytes, value.temp.allocatedBytes);
      counters.maxObservedRssBytes = Math.max(counters.maxObservedRssBytes, value.rssBytes);
    }
    if (record.kind === 'prepare') {
      counters.prepareMs += record.elapsedMs;
      for (const [key, value] of [['maxIndexBytes', record.indexBytes], ['maxEvents', record.events],
        ['maxTitleCandidates', record.titleCandidates], ['maxRequests', record.requests]]) {
        counters[key] = Math.max(counters[key], value);
      }
    } else if (record.kind === 'transaction') {
      counters.transactions++;
      if (record.purpose === 'replace-sessions') counters.replacementMs += record.elapsedMs;
    }
    if (record.kind === 'refresh') Object.assign(record, counters);
    const line = JSON.stringify({ variant, pair:Number(pairText), ...record }) + '\n';
    if (logBytes + Buffer.byteLength(line) > 64 * 1024) flushLog();
    logBuffer.push(line); logBytes += Buffer.byteLength(line);
  };
  const originalExec = connection.exec;
  const originalPrepare = SummaryStaging.prototype.prepareSummaries;
  const originalBatch = SummaryStaging.prototype.batchEvents;
  const originalReplace = database.replaceSessions;
  connection.exec = function(sql) {
    const trimmed = sql.trim();
    if (trimmed.includes('CREATE TEMP TABLE component_events AS')) {
      assert.ok(sql.includes('component_request_title'), 'Compile the production title-index implementation first');
      sql = variant === 'baseline' ? withoutTitleIndex(sql) : sql;
      sqlText = sql;
    }
    if (/^BEGIN (IMMEDIATE|DEFERRED)$/.test(trimmed)) {
      assert.equal(transaction, undefined, 'Nested transaction in benchmark');
      const before = observe(() => resources(database));
      transaction = { kind:'transaction', scenario, component, purpose, mode:trimmed, before, start:performance.now() };
    }
    const result = originalExec.call(connection, sql);
    if (trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
      assert.ok(transaction, 'Transaction end without recorded BEGIN');
      const elapsedMs = performance.now() - transaction.start;
      const after = observe(() => resources(database));
      const { start, ...record } = transaction;
      observe(() => emit({ ...record, elapsedMs, outcome:trimmed, after }));
      transaction = undefined;
    }
    return result;
  };
  SummaryStaging.prototype.batchEvents = function(action) {
    const previous = purpose; purpose = 'temp-parse-batch';
    try { return originalBatch.call(this, action); } finally { purpose = previous; }
  };
  SummaryStaging.prototype.prepareSummaries = function() {
    component++;
    assert.equal(transaction, undefined, 'Aggregation preparation must precede persistent replacement');
    const before = observe(() => resources(database));
    const start = performance.now();
    originalPrepare.call(this);
    const elapsedMs = performance.now() - start;
    const after = observe(() => resources(database));
    observe(() => {
      const space = titleTempSpace({ database });
      const dimensions = connection.prepare(`SELECT count(*) events,
        sum(CASE WHEN is_main=1 AND request_title IS NOT NULL THEN 1 ELSE 0 END) titleCandidates FROM component_events`).get();
      const requests = connection.prepare('SELECT count(*) requests FROM prepared_turns').get().requests;
      const sessions = connection.prepare('SELECT count(*) sessions FROM component').get().sessions;
      const plan = connection.prepare(`EXPLAIN QUERY PLAN ${sqlText.split('CREATE TEMP TABLE prepared_turns AS')[1]}`).all()
        .map(row => String(row.detail));
      const indexBytes = space.objects.find(row => row.name === 'component_request_title')?.bytes ?? 0;
      assert.equal(plan.some(detail => detail.includes('component_request_title')), variant === 'partial-index');
      const baselineHash = sha(withoutTitleIndex(sqlText));
      if (baselineSqlSha256) assert.equal(baselineSqlSha256, baselineHash); else baselineSqlSha256 = baselineHash;
      emit({ kind:'prepare', scenario, component, insideExplicitTransaction:false, elapsedMs, before, after,
        ...dimensions, requests, sessions, indexBytes, tempLiveBytes:space.liveBytes,
        usesTitleIndex:variant === 'partial-index', baselineSqlSha256:baselineHash, sqlSha256:sha(sqlText) });
    });
  };
  database.replaceSessions = function(replacement) {
    const previous = purpose; purpose = 'replace-sessions';
    try { return originalReplace.call(database, replacement); } finally { purpose = previous; }
  };
  try {
    for (scenario of SCENARIOS) {
      component = 0; phase = undefined; observerMs = 0;
      counters = { prepareMs:0, replacementMs:0, transactions:0, maxTempAllocatedBytes:0, maxObservedRssBytes:0,
        maxIndexBytes:0, maxEvents:0, maxTitleCandidates:0, maxRequests:0 };
      // Force the same complete rebuild over accepted summaries; source content stays frozen.
      if (scenario === 'rebuild') originalExec.call(connection, 'UPDATE manifest SET parser_version=0');
      const start = performance.now();
      const cpuStart = process.cpuUsage();
      const result = await refreshSummary(database, { dbPath:join(directory, 'summary.sqlite'), roots:config.roots }, undefined, value => {
        if (value.phase !== phase) {
          phase = value.phase;
          process.send({ kind:'progress', variant, pair:Number(pairText), scenario, phase });
        }
      });
      const elapsedMs = performance.now() - start;
      const cpu = process.cpuUsage(cpuStart);
      assert.ok(!result.interrupted && !result.error, 'Refresh interrupted; no successful report generated');
      assert.equal(transaction, undefined, 'Refresh left a transaction open');
      if (scenario === 'unchanged') { assert.equal(result.bodyBytes, 0); assert.equal(component, 0); }
      const rows = connection.prepare('SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens FROM turn_summary').get();
      if (config.input === 'fixture') { assert.equal(result.failed, 0); assert.equal(rows.requests, 30); assert.equal(rows.tokens, 450); }
      const digest = outputDigest(connection);
      const fileBytes = suffix => { try { return statSync(join(directory, `summary.sqlite${suffix}`)).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } };
      const refresh = { kind:'refresh', scenario, elapsedMs, observerMs, measuredWorkMs:elapsedMs - observerMs,
        cpuUserMs:cpu.user / 1000, cpuSystemMs:cpu.system / 1000,
        discovered:result.discovered, parsed:result.parsed, reused:result.reused, failed:result.failed, bodyBytes:result.bodyBytes,
        ...rows, outputDigest:digest, components:component,
        ...counters,
        after:resources(database), mainFileBytes:fileBytes(''), walFileBytes:fileBytes('-wal'), shmFileBytes:fileBytes('-shm'),
        processPeakRssBytes:process.resourceUsage().maxRSS > 0 ? process.resourceUsage().maxRSS * 1024 : null };
      emit(refresh);
      records.push(refresh); // Only three small refresh summaries; raw transaction rows stay on disk.
    }
    const sqlite = connection.prepare('SELECT sqlite_version() version').get().version;
    flushLog();
    process.send({ kind:'complete', variant, pair:Number(pairText), sqlite, logPath, baselineSqlSha256,
      records:records.map(record => ({ variant, pair:Number(pairText), ...record })) });
  } finally {
    connection.exec = originalExec; SummaryStaging.prototype.prepareSummaries = originalPrepare;
    SummaryStaging.prototype.batchEvents = originalBatch; database.replaceSessions = originalReplace;
    closeSync(logFile); database.close();
  }
}

function runWorker(configPath, variant, pair, directory) {
  return new Promise((resolveRun, reject) => {
    const child = fork(__filename, ['--worker', configPath, variant, String(pair), directory], {
      stdio:['ignore', 'ignore', 'inherit', 'ipc'], windowsHide:true,
    });
    let completion;
    child.on('message', message => {
      if (message.kind === 'complete') completion = message;
      else if (message.kind === 'progress') console.log(`pair ${pair + 1} ${variant} ${message.scenario}: ${message.phase}`);
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 && completion ? resolveRun(completion)
      : reject(new Error(`Transaction benchmark worker failed (${code ?? signal})`)));
  });
}

function median(values) { const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; }

function markdown(report, documentPath, jsonPath, logPath) {
  const link = path => relative(dirname(documentPath), path).replaceAll('\\', '/');
  const ms = value => value.toFixed(3);
  const mib = value => (value / 1048576).toFixed(2);
  const rows = report.results.map(row => `| ${row.scenario} | ${row.variant} | ${ms(row.elapsedMs)} | ${ms(row.workMs)} | ${ms(row.prepareMs)} | ${ms(row.replacementMs)} | ${mib(row.maxTempAllocatedBytes)} | ${mib(row.maxObservedRssBytes)} | ${row.processPeakRssBytes === null ? '미지원' : mib(row.processPeakRssBytes)} |`);
  const comparisons = SCENARIOS.map(scenario => {
    const pairs = Array.from({ length:report.pairs }, (_, pair) => {
      const samples = report.samples.filter(row => row.pair === pair && row.scenario === scenario);
      return samples.find(row => row.variant === 'partial-index').elapsedMs - samples.find(row => row.variant === 'baseline').elapsedMs;
    });
    return `- ${scenario}: 같은 쌍의 A−이전 전체 시간 차이 중앙값 ${ms(median(pairs))}ms, 범위 ${ms(Math.min(...pairs))}~${ms(Math.max(...pairs))}ms. 양수는 A가 더 오래 걸린 실행이다.`;
  });
  return `# 요청 제목 TEMP 인덱스: 실제 갱신·트랜잭션 측정

측정 시각: ${report.recordedAtSeoul} (Asia/Seoul). 입력: ${report.input === 'real' ? '실제 로컬 Claude·Codex JSONL의 고정 사본' : '합성 JSONL'}. ${report.pairs}쌍을 순차 실행했고 모든 쌍의 요청·토큰·제목·상태·모델·비용·Skill·이름·진단 결과 digest가 일치했다.

## 선택과 근거

사용자는 개인용·간헐적 통계 갱신에서 상시 인덱스 유지보다 갱신 중 메모리를 우선하여 **A: TEMP partial index**를 선택했다. 제목이 있는 메인 이벤트만 \`component_events(root_id,id) WHERE is_main=1 AND request_title IS NOT NULL\`로 인덱싱하며, 기존 최초 제목 선택 SQL을 유지한다. 제목 Map을 추가하지 않고 SQLite의 FILE TEMP와 기존 100행 단위 결과 읽기를 사용한다. component 재생성·staging 종료 시 인덱스가 제거되며 영속 schema·parser version은 변경하지 않는다.

검토한 B는 기존 roots 집계에 최초 제목 이벤트 ID를 포함한 뒤 events의 기본 키로 제목을 JOIN한다. B도 JS HashSet/Map을 사용하지 않는다. [앞선 2,000개 A/B 실험](${link(resolve(__dirname, '../../docs/RequestTitleAB.md'))})에서 B는 집계 시간과 TEMP live 공간이 적었고 A는 관측 RSS가 작았다. 그 RSS 차이는 fixture·결과 검증까지 포함한 process 값이므로 알고리즘 고유 메모리 차이로 확정하지 않는다. 이번에는 **최적화 전 무인덱스 SQL과 실제 구현 A**를 동일한 원본으로 비교했다. B와 A 비교 수치에 이번 결과를 섞지 않는다.

이번 최적화의 대상은 한 prepared_turns SQL 안에서 요청마다 실행되는 제목 상관 서브쿼리의 반복 탐색 비용이다. 프로젝트·세션 이름의 기존 정규화와 요청별 제목 탐색은 별도 경로다.

## 시간·공간 복잡도 모델

component별 E=이벤트 수, T=제목이 있는 메인 이벤트 수, R=출력 요청 수다. 전체 parser와 집계의 비용은 공통이며 아래는 제목 찾기의 추가 비용이다.

| 방식 | 시간 모델 | 추가 공간 모델 |
|---|---|---|
| 기존 무인덱스 | 제목 탐색의 최악 경우 O(R×E), 정렬 비용은 별도 | 별도 영속 인덱스 없음; 공통 TEMP와 임시 정렬 사용 |
| A TEMP partial index | 구축 O(E + T log T), 요청별 탐색 O(R log T + ΣKᵣ) | O(T×키 폭)의 TEMP B-tree |
| B 기존 집계 통합 | 이미 읽는 행에 O(E) 집계 연산, R번 기본 키 탐색 | 집계 상태·결과에 O(R)의 ID 추가 |

Kᵣ는 root_id를 공유한 후보 중 provider/session 필터를 확인하는 수다. A의 키에 provider/session은 없으므로 해당 검사를 생략하지 않는다. T가 0인 경우 인덱스는 빈 루트 페이지만 사용한다. 공통 events/component_events/winners 등의 TEMP는 행 폭을 W라 할 때 대략 O(E×W)이며 열이 많으면 이 공통 비용이 증가한다. 이 모델은 구현에서 추론한 증가 방식이고, 단일 입력의 실측만으로 Big-O를 입증한 것은 아니다.

FILE TEMP에도 RAM page cache가 있다. main/TEMP cache 각 4 MiB는 전체 process 메모리의 상한이 아니다. 이번 변경은 넓은 이벤트 행의 TEMP 복사 구조를 줄이지 않는다.

영속 교체 transaction은 이미 준비한 요청과 모델·Skill 행을 저장하고 같은 session의 이전 참조 행을 삭제한다. 그 비용은 새 행 수·이전 행 수·관련 DB 인덱스에 따라 달라진다. 제목 인덱스 구축·탐색은 교체 전에 끝나므로 위의 제목 탐색 모델과 교체 transaction 실측을 구분한다.

## 측정 조건과 구간

- Node ${report.environment.node}, SQLite ${report.environment.sqlite}, schema ${report.environment.schema}, parser ${report.environment.parser}, ${report.environment.platform}/${report.environment.arch}, ${report.environment.cpu}.
- JSONL ${report.inventory.reduce((sum, root) => sum + root.files, 0)}개, ${report.inventory.reduce((sum, root) => sum + root.bytes, 0)} bytes. 파일별 크기를 고정하여 64 KiB씩 복사하고 동일 사본을 모든 실행에서 재사용했다. 활성 대화가 추가되어도 비교 입력은 달라지지 않는다.
- 기본 제공자 데이터 홈/환경 변수의 roots를 사용했다. Codex session_index와 threads의 id/title/name만 사본에 포함하고 credential·네트워크·실계정 quota는 사용하지 않는다. 원본과 설치된 확장 DB는 수정하지 않는다. 입력 사본과 실험 DB는 완료 후 삭제한다.
- 쌍마다 독립 process·새 DB를 사용하고 baseline→A, A→baseline 순서를 교차한다. initial은 빈 DB, rebuild는 manifest parser version만 0으로 만들어 기존 정상 통계를 전체 교체, unchanged는 바로 이어 변경 없이 갱신한다. source body를 바꾸는 증분 append 실험은 이번 범위에 포함하지 않았다.
- baseline은 실제 제품 prepareSummaries SQL에서 새 인덱스 생성문만 제거한 대조군이다. 나머지 SQL hash를 모든 실행에서 대조한다. 이전 schema/parser의 과거 측정과 직접 비교하지 않는다. 명시적 워밍업·OS cache 비우기는 수행하지 않았다.
- prepareSummaries는 명시적 교체 transaction **밖**의 집계 준비다. 로그의 transaction은 실제 BEGIN IMMEDIATE/DEFERRED부터 COMMIT/ROLLBACK까지의 시간이며, replace-sessions와 TEMP parse batch를 구분한다. 전체 refresh는 파싱·공통 집계·교체·측정 관찰 비용을 포함한다.
- work는 전체 시간에서 관찰 함수의 직접 실행 시간을 뺀 참고값이다. 관찰 쿼리가 cache·계획·메모리에 주는 간접 영향은 제거할 수 없다. 주요 비교는 같은 관찰을 수행한 전체 시간과 prepare/교체 구간이다.
- TEMP allocated는 page_count×page_size, live는 dbstat 및 할당 페이지에서 빈 페이지를 뺀 값이다. 논리적 SQLite 페이지 공간이며 실제 TEMP 파일의 디스크 쓰기량·물리 파일 크기와 같다고 보장하지 않는다. SQL 정렬 내부 scratch 공간은 이 값에 모두 포함되지 않는다.
- 관측 RSS는 구간 경계의 process 값이다. process peak RSS는 OS가 제공한 해당 process 수명 전체의 최고값이며 초기화·이전 시나리오·측정·digest 검증을 포함한다. 준비 SQL 구간만의 peak가 아니다. JS heap·SQLite 메모리와 OS cache를 같은 의미로 해석하지 않는다.
- 원시 transaction 로그는 64 KiB 이내 버퍼로 파일에 순차 기록하고 process에는 세 시나리오의 작은 요약만 보관한다. 전체 로그를 메모리에 쌓지 않는다. 실제 로그는 gzip으로 보관하며 UTF-8 JSONL로 풀어 읽을 수 있다.
- TEMP allocated는 같은 DB 연결에서 재사용 가능한 빈 페이지도 포함한다. unchanged에 이전과 같은 allocated 값이 남더라도 제목 인덱스가 다시 생성된 것은 아니다. 종료 시점 live/free와 indexBytes를 로그에서 함께 확인한다.

## 실측 결과

각 값은 ${report.pairs}회 중앙값이다. 시간은 ms, 공간은 MiB. TEMP/RSS 관측 최대는 각 실행의 경계 표본 중 최대를 먼저 구하고 그 값의 중앙값을 적었다.

| 시나리오 | 방식 | 전체 갱신 | 관찰 제외 참고 | 집계 준비 합계 | 교체 transaction 합계 | TEMP allocated 관측 최대 | RSS 관측 최대 | process lifetime peak RSS |
|---|---|---:|---:|---:|---:|---:|---:|---:|
${rows.join('\n')}

${report.results.map(row => `- ${row.scenario}/${row.variant}: 읽은 본문 ${row.bodyBytes} bytes, 파싱 ${row.parsed}개, 재사용 ${row.reused}개, 오류 ${row.failed}개, 저장 요청 ${row.requests}개. component별 관측 최대 E=${row.maxEvents}, T=${row.maxTitleCandidates}, R=${row.maxRequests}; 제목 인덱스 관측 최대 ${row.maxIndexBytes} bytes.`).join('\n')}

${comparisons.join('\n')}

E/T/R의 최대값은 각각 구한 값이며 같은 component에서 모두 최대라는 뜻은 아니다. 긴 세션에 2,000개 요청을 넣었던 후보 비교와 실제 component 크기가 다르므로 같은 속도 개선률이나 고정 메모리 절감량을 기대하지 않는다. ${report.pairs}회씩의 실행과 구간 경계 RSS만으로 A의 일반적인 메모리 우위를 확정하지 않는다. 선택 근거는 사용자의 메모리 우선순위이며, 이 실측은 그 선택의 실제 비용을 확인하는 기록이다.

오류가 있는 실제 파일은 제품 진단 규칙을 따르며 이전/A에서 오류 수와 진단 digest가 같은지 확인했다. 오류가 있었다면 위 숫자에 그대로 보고한다. unchanged에서는 본문 읽기·집계 준비·제목 인덱스 생성이 모두 0인지 검증했다. 성능 합격 임계값은 두지 않았다.

원시 로그에는 component별 E/T/R, 준비 시간, 실제 transaction 시간, TEMP/main 페이지 사용량, RSS/heap, SQL hash와 전체 결과 digest가 있다. 요청 제목·본문·세션 ID·개인 경로·credential은 기록하지 않는다.

## 재실행

\`npm run benchmark:transactions -- --real --pairs 3 --report docs/RequestTitleTransactions.md\`

\`--real\` 없이 실행하면 개인 파일을 읽지 않는 30개 요청의 합성 검증이다. CI는 이 합성 실행만 검사한다. 기본 보고서는 tests/results/benchmarks에 저장한다.

[원시 JSON](${link(jsonPath)}), [transaction JSONL](${link(logPath)}), [측정 실행기](${link(__filename)}).
`;
}

async function main() {
  const args = process.argv.slice(2);
  const options = { real:false, pairs:3, report:resolve(__dirname, '../results/benchmarks/summary-transactions.md') };
  for (let index = 0; index < args.length; index++) {
    const key = args[index].replace(/^--/, '');
    assert.ok(Object.hasOwn(options, key), `Unknown option: ${args[index]}`);
    if (key === 'real') options.real = true;
    else { assert.ok(args[index + 1], `Missing option: ${args[index]}`); options[key] = key === 'pairs' ? Number(args[++index]) : resolve(args[++index]); }
  }
  assert.ok(Number.isSafeInteger(options.pairs) && options.pairs >= 1 && options.pairs <= 20);
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-title-transactions-'));
  const trials = [];
  let snapshot;
  try {
    snapshot = await makeSnapshot(directory, options.real);
    const configPath = join(directory, 'snapshot.json');
    await writeFile(configPath, JSON.stringify({ input:options.real ? 'real' : 'fixture', roots:snapshot.roots }));
    console.log(`Frozen input: ${snapshot.inventory.reduce((sum, root) => sum + root.files, 0)} files, ${snapshot.inventory.reduce((sum, root) => sum + root.bytes, 0)} bytes`);
    for (let pair = 0; pair < options.pairs; pair++) {
      const order = pair % 2 ? [...VARIANTS].reverse() : VARIANTS;
      const samples = [];
      for (const variant of order) samples.push(await runWorker(configPath, variant, pair, join(directory, `pair-${pair}`, variant)));
      for (const scenario of SCENARIOS) {
        const results = samples.map(sample => sample.records.find(row => row.kind === 'refresh' && row.scenario === scenario));
        assert.equal(results[0].outputDigest, results[1].outputDigest, `Before/after output differs: ${scenario}`);
        for (const key of ['discovered', 'parsed', 'reused', 'failed', 'bodyBytes', 'requests', 'tokens']) assert.equal(results[0][key], results[1][key]);
      }
      trials.push(...samples);
    }
    const hashes = new Set(trials.map(sample => sample.baselineSqlSha256));
    assert.equal(hashes.size, 1, 'The common production SQL changed across trials');
    for (const scenario of SCENARIOS) assert.equal(new Set(trials.map(sample => sample.records.find(row => row.kind === 'refresh' && row.scenario === scenario).outputDigest)).size, 1);
    const records = trials.flatMap(sample => sample.records);
    const results = SCENARIOS.flatMap(scenario => VARIANTS.map(variant => {
      const samples = trials.filter(sample => sample.variant === variant).map(sample => {
        const rows = sample.records.filter(row => row.scenario === scenario);
        const refresh = rows.find(row => row.kind === 'refresh');
        return { ...refresh, workMs:refresh.measuredWorkMs };
      });
      const result = { scenario, variant };
      for (const key of ['elapsedMs', 'workMs', 'prepareMs', 'replacementMs', 'maxTempAllocatedBytes', 'maxObservedRssBytes', 'bodyBytes', 'parsed', 'reused', 'failed', 'requests', 'maxIndexBytes', 'maxEvents', 'maxTitleCandidates', 'maxRequests']) result[key] = median(samples.map(sample => sample[key]));
      result.processPeakRssBytes = samples.every(sample => sample.processPeakRssBytes !== null) ? median(samples.map(sample => sample.processPeakRssBytes)) : null;
      return result;
    }));
    const report = { recordedAtSeoul:seoulTime(), input:options.real ? 'real' : 'fixture', pairs:options.pairs,
      environment:{ node:process.version, sqlite:trials[0].sqlite, schema:SCHEMA_VERSION, parser:PARSER_VERSION,
        platform:process.platform, arch:process.arch, cpu:cpus()[0]?.model, logicalCpus:cpus().length },
      inventory:snapshot.inventory, inputSha256:snapshot.fingerprint, inputSha256Scope:'conversation JSONL only; frozen title metadata excluded',
      baselineSqlSha256:trials[0].baselineSqlSha256,
      complexityModel:{ scope:'additional title lookup per component; analytical, not empirically proven Big-O',
        dimensions:{ E:'component events', T:'main events with non-null title', R:'prepared requests', K:'same-root candidates checked for provider/session' },
        baselineTime:'worst-case O(R*E), sorting excluded', indexTime:'O(E + T log T + R log T + sum(K_r))',
        indexSpace:'O(T * key width) TEMP B-tree', commonTempSpace:'approximately O(E * row width)', logBufferMaxBytes:65536 },
      results, samples:records };
    const documentPath = options.report;
    const output = join(dirname(documentPath), 'benchmarks');
    await mkdir(output, { recursive:true });
    const jsonPath = join(output, `${basename(documentPath, '.md')}.json`);
    const logPath = join(output, `${basename(documentPath, '.md')}.jsonl${options.real ? '.gz' : ''}`);
    await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n');
    async function* chunks() {
      yield JSON.stringify({ kind:'measurement', ...report }) + '\n';
      for (const trial of trials) for await (const chunk of createReadStream(trial.logPath)) yield chunk;
    }
    const input = Readable.from(chunks());
    if (options.real) await pipeline(input, createGzip(), createWriteStream(logPath));
    else await pipeline(input, createWriteStream(logPath));
    await writeFile(documentPath, markdown(report, documentPath, jsonPath, logPath));
    console.log(`Report: ${documentPath}; before/after digests matched`);
  } finally { await removeWorkspace(directory); }
}

if (process.argv[2] === '--worker') worker().then(() => process.disconnect(), () => {
  console.error('Transaction benchmark worker failed; no transcript data printed'); process.exitCode = 1; process.disconnect();
});
else main().catch(error => { console.error(error.message); process.exitCode = 1; });
