const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, statSync } = require('node:fs');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { cpus, homedir, tmpdir } = require('node:os');
const { basename, dirname, join, relative, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { backup, DatabaseSync } = require('node:sqlite');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const { buildUsageQuery, buildUsageCountQuery, buildQueryFilter } = require('../../dist/src/summary/db/queries');
const { SCHEMA_VERSION } = require('../../dist/src/summary/db/schema');
const { PARSER_VERSION, refreshSummary } = require('../../dist/src/summary/scanner');

const root = resolve(__dirname, '../..');
const DAY = 86400000;
const VARIANTS = ['current', 'without-summary-secondary'];
const SECONDARY = ['idx_summary_period', 'idx_summary_project_period'];
const sha = value => createHash('sha256').update(value).digest('hex');
const seoulTime = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium',
}).format(new Date());

function argumentsFor(args) {
  const options = { sizes: [280, 100000], samples: 9, warmup: 2,
    output: resolve(root, 'tests/results/benchmarks/sql-explain.json'), localLogs: false, realDb: undefined };
  for (const arg of args) {
    if (arg === '--local-logs') options.localLogs = true;
    else if (arg.startsWith('--sizes=')) options.sizes = arg.slice(8).split(',').map(Number);
    else if (arg.startsWith('--samples=')) options.samples = Number(arg.slice(10));
    else if (arg.startsWith('--warmup=')) options.warmup = Number(arg.slice(9));
    else if (arg.startsWith('--output=')) options.output = resolve(arg.slice(9));
    else if (arg.startsWith('--real-db=')) options.realDb = resolve(arg.slice(10));
    else throw new Error(`Unknown option: ${arg}`);
  }
  assert.ok(options.sizes.length && options.sizes.every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000000), 'sizes must be 1..1000000 request facts');
  assert.ok(Number.isInteger(options.samples) && options.samples >= 3 && options.samples <= 31, 'samples must be 3..31');
  assert.ok(Number.isInteger(options.warmup) && options.warmup >= 1 && options.warmup <= 20, 'warmup must be 1..20');
  assert.ok(!(options.realDb && options.localLogs), 'Choose --real-db or --local-logs');
  return options;
}

function seedSynthetic(db, count) {
  const projects = new Set(), sessions = new Set();
  const project = db.connection.prepare('INSERT INTO projects VALUES (?,?)');
  const session = db.connection.prepare('INSERT INTO sessions VALUES (?,?,?)');
  const turn = db.connection.prepare(`INSERT INTO turn_summary
    (id,provider,project_key,session_id,root_turn_id,started_at_ms,completed_at_ms,duration_ms,duration_quality,
      input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens,total_tokens,status,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const model = db.connection.prepare('INSERT INTO turn_model_usage VALUES (?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const sid = Math.floor(i / 10), provider = sid % 2 ? 'codex' : 'claude';
      const projectKey = `/fixture/project-${Math.floor(sid / 2) % 20}`, sessionId = `session-${sid}`;
      if (!projects.has(projectKey)) { project.run(projectKey, basename(projectKey)); projects.add(projectKey); }
      if (!sessions.has(sessionId)) { session.run(provider, sessionId, sessionId); sessions.add(sessionId); }
      const started = i % 101 === 0 ? null : Date.UTC(2026, 6, 1) + (sid * 17 % 90) * DAY + (i % 10) * 60000;
      const status = i % 17 === 0 ? 'failed' : i % 11 === 0 ? 'in_progress' : 'completed';
      const empty = i % 41 === 0, input = empty ? 0 : 1000 + i % 19000, output = empty ? 0 : 100 + i % 1900;
      const write = empty ? 0 : 100, read = empty ? 0 : 200;
      turn.run(i + 1, provider, projectKey, sessionId, `request-${i}`, started,
        status === 'completed' && started !== null ? started + 1000 : null,
        status === 'completed' ? 1000 : null, status === 'completed' ? 'exact' : 'missing',
        input, output, write, read, input + output, status, '2026-10-15T00:00:00.000Z');
      if (empty && i % 2 === 0) continue; // Unrecorded usage and known-model zero usage both occur.
      const name = `${provider}-model-${sid % 3}`;
      if (!empty && i % 5 === 0) {
        model.run(i + 1, name, input - 200, output - 50, write, read, null, 'fixture');
        model.run(i + 1, `${provider}-helper`, 200, 50, 0, 0, null, 'fixture');
      } else model.run(i + 1, name, input, output, write, read, null, 'fixture');
    }
  });
  assert.equal(db.connection.prepare('SELECT count(*) n FROM turn_summary').get().n, count);
  const totals = db.connection.prepare(`SELECT
    (SELECT sum(total_tokens) FROM turn_summary) AS turns,
    (SELECT sum(input_tokens+output_tokens) FROM turn_model_usage) AS models`).get();
  assert.equal(totals.turns, totals.models);
}

function describe(db) {
  const scalar = sql => db.connection.prepare(sql).get().n;
  return {
    requestFacts: scalar('SELECT count(*) n FROM turn_summary'),
    modelFacts: scalar('SELECT count(*) n FROM turn_model_usage'),
    sessions: scalar('SELECT count(*) n FROM sessions'), projects: scalar('SELECT count(*) n FROM projects'),
    sourceFiles: scalar('SELECT count(*) n FROM manifest'),
    unknownTimeFacts: scalar('SELECT count(*) n FROM turn_summary WHERE started_at_ms IS NULL'),
    byProvider: db.connection.prepare('SELECT provider,count(*) AS requests,sum(total_tokens) AS totalTokens FROM turn_summary GROUP BY provider').all(),
    schemaVersion: db.connection.prepare('PRAGMA user_version').get().user_version,
  };
}

function workloads(db) {
  const latest = db.connection.prepare('SELECT max(started_at_ms) latest FROM turn_summary').get().latest;
  assert.ok(latest !== null, 'Need at least one dated request');
  const end = latest + 1, week = { fromMs: end - 7 * DAY, toMs: end }, month = { fromMs: end - 30 * DAY, toMs: end };
  const project = db.connection.prepare(`SELECT provider,project_key FROM turn_summary
    WHERE started_at_ms>=? AND started_at_ms<? GROUP BY provider,project_key ORDER BY count(*) DESC,provider,project_key LIMIT 1`).get(month.fromMs, month.toMs);
  const session = db.connection.prepare(`SELECT provider,session_id FROM turn_summary
    GROUP BY provider,session_id ORDER BY count(*) DESC,provider,session_id LIMIT 1`).get();
  const specs = [
    ['total-provider', 'total', 'provider', {}], ['total-model', 'total', 'model', {}],
    ['month-provider', 'month', 'provider', {}], ['month-model', 'month', 'model', {}],
    ['day-7-provider', 'day', 'provider', week], ['day-7-model', 'day', 'model', week],
    ['day-7-known-provider', 'day', 'provider', { ...week, unknownTime: 'exclude' }],
    ['project-30-provider', 'total', 'provider', { ...month, provider: project.provider, projectKey: project.project_key }],
    ['project-30-model', 'total', 'model', { ...month, provider: project.provider, projectKey: project.project_key }],
    ['sessions-provider', 'session', 'provider', {}], ['sessions-model', 'session', 'model', {}],
    ['one-session-provider', 'session', 'provider', { provider: session.provider, sessionId: session.session_id }],
    ['project-average-provider', 'project', 'provider', {}, 'averageTokens'],
  ];
  return specs.map(([name, groupBy, by, conditions, sortBy]) => {
    const filter = { providers: ['claude', 'codex'], excludeEmptyUsage: true, ...conditions };
    const effective = (groupBy === 'day' || groupBy === 'month') && filter.unknownTime === undefined
      ? { ...filter, unknownTime: 'include' } : filter;
    const where = buildQueryFilter(effective);
    const matchedRequestFacts = db.connection.prepare(`SELECT count(*) n FROM turn_summary WHERE ${where.sql}`).get(...where.values).n;
    const matchedModelFacts = db.connection.prepare(`SELECT count(*) n FROM turn_summary
      LEFT JOIN turn_model_usage m ON m.turn_id=turn_summary.id WHERE ${where.sql}`).get(...where.values).n;
    return { name, groupBy, by, filter,
      matchedRequestFacts, matchedModelFacts,
      rows: buildUsageQuery(filter, groupBy, 'Asia/Seoul', by, sortBy),
      count: buildUsageCountQuery(filter, groupBy, 'Asia/Seoul', by) };
  });
}

function plan(db, query, values) {
  const rows = db.connection.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...values);
  const instructions = db.connection.prepare(`EXPLAIN ${query.sql}`).all(...values);
  const opcodes = {};
  for (const row of instructions) opcodes[row.opcode] = (opcodes[row.opcode] ?? 0) + 1;
  return {
    steps: rows.map(({ id, parent, detail }) => ({ id, parent, detail })),
    scans: rows.filter(row => /\bSCAN\b/.test(row.detail)).map(row => row.detail),
    searches: rows.filter(row => /\bSEARCH\b/.test(row.detail)).map(row => row.detail),
    tempBtrees: rows.filter(row => /USE TEMP B-TREE/.test(row.detail)).map(row => row.detail),
    bytecodeInstructions: instructions.length, opcodes,
  };
}

function prepared(db, spec) {
  const rowValues = [...spec.rows.values, 100, 0], countValues = spec.count.values;
  return { rows: db.connection.prepare(spec.rows.sql), count: db.connection.prepare(spec.count.sql), rowValues, countValues,
    plans: { rows: plan(db, spec.rows, rowValues), count: plan(db, spec.count, countValues) } };
}

function execute(query) {
  const start = performance.now();
  const rows = query.rows.all(...query.rowValues);
  const middle = performance.now();
  const total = query.count.get(...query.countValues).count;
  const end = performance.now();
  return { rows, total, rowsMs: middle - start, countMs: end - middle, bundleMs: end - start };
}

function stats(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const percentile = fraction => {
    const position = (ordered.length - 1) * fraction, lower = Math.floor(position), weight = position - lower;
    return ordered[lower] * (1 - weight) + ordered[Math.ceil(position)] * weight;
  };
  return { medianMs: percentile(0.5), p10Ms: percentile(0.1), p90Ms: percentile(0.9), minMs: ordered[0], maxMs: ordered.at(-1), samplesMs: values };
}

function measure(queries, options) {
  const initial = queries.map(execute);
  const signatures = initial.map(value => sha(JSON.stringify({ rows: value.rows, total: value.total })));
  assert.equal(signatures[0], signatures[1], 'Removing secondary indexes changed query results');
  for (const value of initial) assert.ok(value.rows.length <= 100 && value.rows.length <= value.total);
  const iterations = Math.min(100, Math.max(1, Math.ceil(12 / Math.max(...initial.map(value => value.bundleMs), 0.01))));
  for (const query of queries) for (let i = 0; i < options.warmup; i++) execute(query);
  const samples = queries.map(() => ({ rows: [], count: [], bundle: [] }));
  for (let i = 0; i < options.samples; i++) {
    for (const variant of i % 2 ? [1, 0] : [0, 1]) {
      let rows = 0, count = 0, bundle = 0;
      for (let j = 0; j < iterations; j++) {
        const result = execute(queries[variant]);
        rows += result.rowsMs; count += result.countMs; bundle += result.bundleMs;
      }
      samples[variant].rows.push(rows / iterations); samples[variant].count.push(count / iterations);
      samples[variant].bundle.push(bundle / iterations);
    }
  }
  // Check observable output again after the timed runs, outside the measured interval.
  queries.forEach((query, i) => {
    const result = execute(query);
    assert.equal(sha(JSON.stringify({ rows: result.rows, total: result.total })), signatures[i]);
  });
  return { returnedGroups: initial[0].rows.length, totalGroups: initial[0].total, resultSha256: signatures[0], iterationsPerSample: iterations,
    variants: Object.fromEntries(VARIANTS.map((name, i) => [name, {
      rows: stats(samples[i].rows), count: stats(samples[i].count), bundle: stats(samples[i].bundle), plans: queries[i].plans,
    }])) };
}

function indexSpace(db) {
  return db.connection.prepare(`SELECT name,sum(pgsize) bytes FROM dbstat
    WHERE name IN ('idx_summary_period','idx_summary_project_period') GROUP BY name ORDER BY name`).all();
}

async function runDataset(directory, label, base, options, setup = {}) {
  const descriptions = describe(base), specs = workloads(base), paths = VARIANTS.map(name => join(directory, `${label}-${name}.sqlite`));
  for (const path of paths) await backup(base.connection, path);
  const variants = paths.map(path => new SummaryDatabase(path));
  try {
    for (const index of SECONDARY) variants[1].connection.exec(`DROP INDEX IF EXISTS ${index}`);
    // Controlled snapshot statistics; no ANALYZE is issued against an installed database.
    for (const db of variants) db.connection.exec('ANALYZE');
    const indexes = variants[0].connection.prepare(`SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('turn_summary','turn_model_usage') ORDER BY name`).all();
    const result = { label, ...descriptions, setup, indexes, summarySecondaryIndexBytes: indexSpace(variants[0]),
      snapshotBytes: statSync(paths[0]).size, workloads: [] };
    for (const spec of specs) {
      const queries = variants.map(db => prepared(db, spec));
      const measurement = measure(queries, options);
      const current = measurement.variants.current.bundle.medianMs, without = measurement.variants['without-summary-secondary'].bundle.medianMs;
      result.workloads.push({ name: spec.name, groupBy: spec.groupBy, by: spec.by,
        matchedRequestFacts: spec.matchedRequestFacts, matchedModelFacts: spec.matchedModelFacts,
        // Actual project/session keys and query output never enter reports.
        filter: { ...spec.filter, ...(spec.filter.projectKey ? { projectKey: '[selected project]' } : {}),
          ...(spec.filter.sessionId ? { sessionId: '[selected session]' } : {}) },
        sql: { rows: spec.rows.sql, count: spec.count.sql }, ...measurement,
        secondaryIndexSpeedup: without / current });
      console.log(`${label} ${spec.name}: ${current.toFixed(3)} ms current / ${without.toFixed(3)} ms secondary-off; ${measurement.totalGroups} groups`);
      // Keep progress visible between CPU-bound benchmark cases.
      await new Promise(resolve => setImmediate(resolve));
    }
    return result;
  } finally { variants.forEach(db => db.close()); }
}

async function localDataset(directory, options) {
  const path = join(directory, 'local-base.sqlite');
  let db, setup;
  if (options.realDb) {
    assert.ok(existsSync(options.realDb), 'The source DB must already exist');
    const source = new DatabaseSync(options.realDb, { readOnly: true });
    try { source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000'); await backup(source, path); }
    finally { source.close(); }
    db = new SummaryDatabase(path);
    setup = { input: 'read-only SQLite backup; migration/ANALYZE only on copies' };
  } else {
    const home = homedir(), codexHome = process.env.CODEX_HOME || join(home, '.codex');
    const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
    const roots = [
      { provider: 'claude', path: join(claudeHome, 'projects'), dataHome: claudeHome },
      { provider: 'codex', path: join(codexHome, 'sessions'), dataHome: codexHome },
      { provider: 'codex', path: join(codexHome, 'archived_sessions'), dataHome: codexHome },
    ].filter(item => existsSync(item.path));
    assert.ok(roots.length, 'No local transcript roots found');
    db = new SummaryDatabase(path);
    try {
      let phase;
      const start = performance.now();
      const refresh = await refreshSummary(db, { dbPath: path, roots, timezone: 'Asia/Seoul', collectCapabilities: false }, undefined, progress => {
        if (phase !== progress.phase) { phase = progress.phase; console.log(`local setup ${phase}: ${progress.discovered} files`); }
      });
      assert.equal(refresh.interrupted, false, 'Local collection interrupted');
      setup = { input: 'local logs read once into isolated summary DB; not a globally atomic log snapshot', elapsedMs: performance.now() - start,
        discoveredFiles: refresh.discovered, parsedFiles: refresh.parsed, failedFiles: refresh.failed, bodyBytes: refresh.bodyBytes,
        capabilitiesCollected: false };
      if (refresh.failed) console.log(`Local coverage is partial: ${refresh.failed} source files failed; benchmark uses successfully stored summaries.`);
    } catch (error) { db.close(); throw error; }
  }
  try { return await runDataset(directory, 'local', db, options, setup); }
  finally { db.close(); }
}

function markdown(report, jsonPath) {
  const lines = ['# Agent Tracker SQL EXPLAIN 벤치마크', '', `${report.createdAtSeoul} (Asia/Seoul)`, '',
    '현재 제품의 `buildUsageQuery`와 `buildUsageCountQuery`를 직접 호출했다. 각 측정은 표 100행 조회와 전체 그룹 수 COUNT를 합친 시간이며 평균 토큰·입출력·시간 등의 실제 집계식을 포함한다. SQL 준비·EXPLAIN·데이터 생성·원본 로그 파싱·결과 검증·worker IPC·UI는 측정에서 제외했다.', '',
    `Node ${report.environment.node}, SQLite ${report.environment.sqlite}, ${report.environment.cpu}, schema ${report.environment.schema}.`, '',
    `준비 실행 ${report.method.warmup}회, 표본 ${report.method.samples}개. 짧은 조회는 표본당 여러 번 실행한 평균을 사용하고 current/secondary-off 순서를 교대했다. 아래는 표본 중앙값(ms)이다.`, '',
    '`current`는 제품 인덱스, `secondary-off`는 임시 사본에서 날짜·프로젝트용 인덱스 두 개만 제거한 경우다. 요청 UNIQUE와 모델 PK는 유지한다. 두 사본 모두 ANALYZE를 실행했으며 실제 운영 DB의 통계 상태와 다를 수 있다.', '',
    '| 데이터 | 요청 facts | 모델 facts | 세션 | 원본 파일 |', '| --- | ---: | ---: | ---: | ---: |'];
  for (const data of report.datasets) lines.push(`| ${data.label} | ${data.requestFacts} | ${data.modelFacts} | ${data.sessions} | ${data.sourceFiles} |`);
  for (const data of report.datasets) {
    lines.push('', `## ${data.label}`, '', '| 조회 | current ms | secondary-off ms | 배율(off/current) | 전체 그룹 |', '| --- | ---: | ---: | ---: | ---: |');
    for (const item of data.workloads) lines.push(`| ${item.name} | ${item.variants.current.bundle.medianMs.toFixed(3)} | ${item.variants['without-summary-secondary'].bundle.medianMs.toFixed(3)} | ${item.secondaryIndexSpeedup.toFixed(2)} | ${item.totalGroups} |`);
    if (data.setup.failedFiles) lines.push('', `실제 로그 수집 중 ${data.setup.failedFiles}개 파일 실패. 성공한 요약에 대한 측정이며 전체 로그 수집 성공으로 해석하지 않는다.`);
    lines.push('', '현재 인덱스의 행 조회 실행 계획:', '');
    for (const item of data.workloads) {
      lines.push(`### ${item.name}`, '', '```text', ...item.variants.current.plans.rows.steps.map(row => row.detail), '```', '');
    }
  }
  lines.push('## 해석 범위', '',
    '- EXPLAIN QUERY PLAN은 선택한 계획이다. 실행한 행 수·디스크 I/O·실측 시간을 직접 제공하지 않는다. bytecode 명령 수도 실행 횟수가 아니다.',
    '- SEARCH는 키 조건 탐색, SCAN은 테이블 또는 인덱스 순회다. SCAN USING INDEX도 전체 인덱스 순회일 수 있다. 이름·모델 등의 보조 테이블 SEARCH와 요청 facts의 탐색을 구분한다.',
    '- USE TEMP B-TREE는 GROUP BY/ORDER BY용 임시 구조다. 디스크 유출이나 실제 TEMP 최대 공간을 입증하지 않는다.',
    '- 전 기간 SUM/AVG는 대상 facts를 읽어야 한다. LIMIT 100은 반환 그룹 수를 제한하며 집계 입력을 100행으로 제한하지 않는다.',
    '- 반복 조회로 캐시가 따뜻해진 상태다. OS 캐시를 비우지 않았으므로 cold 디스크 벤치마크가 아니다. 두 인덱스를 동시에 제거한 비교이므로 각 인덱스 단독 기여나 최적 인덱스 설계를 입증하지 않는다.',
    '- 작은 수치 차이와 배율만으로 개선을 확정하지 않는다. JSON의 P10/P90과 raw samples, 선택된 행 비율, 계획을 함께 본다. 실행 순서·세션 수·모델 수·데이터 분포에 따라 결과가 달라진다.',
    '- 실제 데이터의 제목·프로젝트 경로·세션 ID·대화 본문은 보고하지 않는다. 로컬 로그 수집에는 제공자 서버 호출이 없다.', '',
    `[전체 계획·SQL·표본 JSON](${relative(dirname(jsonPath).replace(/\\/g, '/'), jsonPath.replace(/\\/g, '/')).replace(/\\/g, '/')})`, '');
  return lines.join('\n');
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-sql-benchmark-'));
  const report = { createdAtSeoul: seoulTime(), environment: { node: process.version,
    sqlite: undefined, cpu: cpus()[0]?.model, logicalCpus: cpus().length, platform: process.platform,
    schema: SCHEMA_VERSION, parser: PARSER_VERSION,
    sourceSha256: Object.fromEntries(['src/summary/db/queries.ts', 'src/summary/db/schema.ts', 'src/summary/db/timezone.ts'].map(path => [path, sha(readFileSync(join(root, path)))])) },
    method: { samples: options.samples, warmup: options.warmup, pageLimit: 100, offset: 0,
      timings: 'prepared statement execution/materialization: rows + count; warm cache; alternating variants',
      secondaryIndexesRemoved: SECONDARY, statistics: 'ANALYZE on both isolated variants', cacheKiB: 4096, tempStore: 'FILE' }, datasets: [] };
  try {
    for (const size of options.sizes) {
      const db = new SummaryDatabase(join(directory, `synthetic-${size}-base.sqlite`));
      try {
        report.environment.sqlite = db.connection.prepare('SELECT sqlite_version() version').get().version;
        seedSynthetic(db, size);
        report.datasets.push(await runDataset(directory, `synthetic-${size}`, db, options));
      } finally { db.close(); }
    }
    if (options.localLogs || options.realDb) report.datasets.push(await localDataset(directory, options));
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
    const markdownPath = options.output.replace(/\.json$/i, '') + '.md';
    await writeFile(markdownPath, markdown(report, options.output));
    console.log(`Saved ${options.output} and ${markdownPath}`);
  } finally {
    // Verify the resolved mkdtemp target before any recursive Windows deletion.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('agent-tracker-sql-benchmark-'));
    await rm(directory, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { argumentsFor, seedSynthetic, describe, workloads, prepared, execute, measure, stats };
