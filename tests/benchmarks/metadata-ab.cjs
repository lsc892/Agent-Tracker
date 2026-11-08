// 전수 파싱을 유지하는 영속 metadata 후보를 고정 워크트리·원본 사본으로 비교한다.
const { summaryPath } = require('./summary-paths.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdir, mkdtemp, cp, copyFile, readFile, writeFile, truncate, utimes, rm } = require('node:fs/promises');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { join, resolve, dirname, sep } = require('node:path');
const { cpus } = require('node:os');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const helpers = require('./incremental-refresh.cjs');
const { allUsage, canonical, digest, fingerprints, independentCheck, stats } = require('./temp-batch-ab.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul';
const variants = ['A', 'B'], groups = ['day', 'month', 'session', 'project'];
const scenarios = ['rewrite-same', 'codex-append', 'claude-append', 'unchanged'];
const sha = value => createHash('sha256').update(value).digest('hex');
const seoul = () => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const bytes = path => fs.existsSync(path) ? fs.statSync(path).size : 0;
const existingTables = new Set(['manifest', 'projects', 'sessions', 'turn_summary', 'turn_model_usage', 'turn_capability_usage', 'turn_costs', 'session_billing', 'usage_rollup_meta', 'usage_request_daily', 'usage_model_daily']);

function metadataInventory(db) {
  return Object.fromEntries(db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .filter(row => !existingTables.has(row.name)).map(row => [row.name,
      db.connection.prepare(`SELECT count(*) n FROM "${row.name.replaceAll('"', '""')}"`).get().n]));
}

function instrument(db, Staging, Metadata) {
  const originalExec = db.connection.exec, originalPrepare = Staging.prototype.prepareSummaries;
  const originalReplace = db.replaceSessions;
  const originalMetadata = Metadata?.prototype.prepare;
  let counters;
  db.connection.exec = function(sql) {
    const start = performance.now();
    try { return Reflect.apply(originalExec, this, [sql]); }
    finally {
      if (/SELECT e\.\* FROM (?:component|summary_batch) c/.test(sql)) {
        counters.aggregatePasses++; counters.aggregateSqlMs += performance.now() - start;
        for (const [table, key] of [['component_events', 'aggregateInputEvents'], ['winners', 'aggregateWinnerRows'], ['prepared_turns', 'aggregatePreparedTurns']]) {
          counters[key] += this.prepare(`SELECT count(*) n FROM temp.${table}`).get().n;
        }
      }
      counters.tempCreates += (sql.match(/CREATE TEMP TABLE/gi) ?? []).length;
    }
  };
  Staging.prototype.prepareSummaries = function(...args) {
    const start = performance.now(); counters.prepareCalls++;
    try { return Reflect.apply(originalPrepare, this, args); }
    finally { counters.prepareMs += performance.now() - start; }
  };
  if (Metadata) Metadata.prototype.prepare = function(...args) {
    const start = performance.now();
    try { return Reflect.apply(originalMetadata, this, args); }
    finally {
      counters.metadataPrepareMs += performance.now() - start;
      const row = db.connection.prepare('SELECT count(*) roots,coalesce(sum(dirty),0) dirty FROM temp.metadata_turns').get();
      counters.metadataConsideredTurns += row.roots; counters.metadataDirtyTurns += row.dirty;
    }
  };
  db.replaceSessions = function(...args) {
    const start = performance.now(); counters.stores++;
    try { return Reflect.apply(originalReplace, this, args); }
    finally { counters.storeMs += performance.now() - start; }
  };
  return {
    reset: () => { counters = { aggregatePasses: 0, aggregateSqlMs: 0, prepareCalls: 0, prepareMs: 0, stores: 0, storeMs: 0, tempCreates: 0,
      aggregateInputEvents: 0, aggregateWinnerRows: 0, aggregatePreparedTurns: 0,
      metadataPrepareMs: 0, metadataConsideredTurns: 0, metadataDirtyTurns: 0 }; },
    get: () => ({ ...counters }),
    close: () => { db.connection.exec = originalExec; Staging.prototype.prepareSummaries = originalPrepare; db.replaceSessions = originalReplace;
      if (Metadata) Metadata.prototype.prepare = originalMetadata; },
  };
}

async function worker(configPath, variant, pairText, work) {
  const config = JSON.parse(await readFile(configPath, 'utf8')), pair = Number(pairText), product = config.products[variant];
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { SummaryStaging } = require(join(product, 'dist/src/summary/staging'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const { buildUsageQuery } = require(join(product, 'dist/src/summary/db/queries'));
  const Metadata = fs.existsSync(summaryPath(product, "dist/src/summary/metadata/index.js")) ? require(join(product, 'dist/src/summary/metadata')).SummaryMetadata : undefined;
  await mkdir(work, { recursive: true });
  const samples = []; let reads;
  for (const scenario of scenarios) {
    const path = join(work, scenario + '.sqlite'); await copyFile(config.seeds[variant], path);
    const db = new SummaryDatabase(path), probe = instrument(db, SummaryStaging, Metadata), touched = [];
    let target;
    try {
      if (scenario === 'rewrite-same') {
        for (const file of config.files) {
          const stat = fs.statSync(file.path); touched.push({ path: file.path, atime: stat.atime, mtime: stat.mtime });
          await utimes(file.path, stat.atime, new Date(stat.mtimeMs + 123456));
        }
      }
      if (scenario.endsWith('append')) {
        const provider = scenario.split('-')[0]; target = helpers.chooseTarget(db, provider, config.directory);
        let rows;
        if (provider === 'codex') {
          await helpers.inspectCodexTarget(target, product);
          rows = helpers.codexAppendRows(target, 'benchmark-metadata-request', 'benchmark-metadata-response');
        } else {
          rows = helpers.claudeRows(target.session_id);
          rows[0].cwd = db.connection.prepare('SELECT project_key FROM turn_summary WHERE provider=? AND session_id=? LIMIT 1').get(provider, target.session_id).project_key;
        }
        await helpers.appendRows(target, rows, config.directory, 1);
      }
      probe.reset(); const start = performance.now();
      const refreshed = await refreshSummary(db, { dbPath: path, roots: config.roots });
      const refreshMs = performance.now() - start, counters = probe.get();
      assert.equal(refreshed.interrupted, false); assert.equal(refreshed.error, undefined);
      const totals = db.connection.prepare('SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens FROM turn_summary').get();
      assert.equal(totals.requests, config.requests + Number(scenario.endsWith('append')));
      assert.equal(totals.tokens, config.tokens + (scenario.endsWith('append') ? 130 : 0));
      if (scenario === 'unchanged') { assert.equal(refreshed.bodyBytes, 0); assert.equal(counters.stores, 0); }
      if (target) assert.ok(refreshed.bodyBytes >= target.originalBytes, 'Changed source must be fully read');
      const walBytes = bytes(path + '-wal');
      const checked = helpers.verify(db, buildUsageQuery), independent = {};
      for (const group of groups) independent[group] = independentCheck(db, config.filter, group, allUsage(db, group, config.filter));
      samples.push({ scenario, variant, pair, refreshMs, ...counters, ...totals, ...checked, independent,
        parsed: refreshed.parsed, failed: refreshed.failed, bodyBytes: refreshed.bodyBytes,
        targetSourceBytesBefore: target?.originalBytes, targetRequests: target?.requests,
        databaseBytes: bytes(path), walBytes, rssBytesAfterValidation: process.memoryUsage().rss,
        processPeakRssBytes: process.resourceUsage().maxRSS * 1024 });
      process.send({ kind: 'progress', variant, pair, scenario, ms: refreshMs, passes: counters.aggregatePasses, parsed: refreshed.parsed });
      if (scenario === 'rewrite-same') {
        reads = {};
        for (const group of groups) {
          for (let n = 0; n < 3; n++) allUsage(db, group, config.filter);
          const times = [], hashes = [];
          for (let n = 0; n < 3; n++) {
            const began = performance.now(), rows = allUsage(db, group, config.filter);
            times.push(performance.now() - began); hashes.push(digest(rows.map(helpers.normalized)));
          }
          assert.equal(new Set(hashes).size, 1);
          reads[group] = { ...stats(times), ...independent[group] };
        }
      }
    } finally {
      probe.close(); db.close();
      if (target) { await truncate(target.path, target.originalBytes); await utimes(target.path, target.originalAtime, target.originalMtime); }
      for (const file of touched) await utimes(file.path, file.atime, file.mtime);
    }
  }
  process.send({ kind: 'result', samples, reads });
}

function runWorker(config, variant, pair, work) {
  return new Promise((done, fail) => {
    const child = fork(__filename, ['--worker', config, variant, String(pair), work], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    let result;
    child.on('message', message => {
      if (message.kind === 'result') result = message;
      if (message.kind === 'failure') console.log(JSON.stringify(message));
      if (message.kind === 'progress') console.log(`${pair < 0 ? 'warmup' : 'pair'} ${pair}/${variant}/${message.scenario}: ${message.ms.toFixed(2)} ms, TEMP passes=${message.passes}, parsed=${message.parsed}`);
    });
    child.on('error', fail);
    child.on('exit', code => code === 0 && result ? done(result) : fail(new Error(`Worker failed: ${variant}/${pair}/${code}`)));
  });
}

async function seedDataset(snapshot, directory, product, variant) {
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const path = join(directory, `seed-${variant}.sqlite`), began = performance.now(), db = new SummaryDatabase(path);
  const openAndMigrationMs = performance.now() - began;
  try {
    const start = performance.now(), refreshed = await refreshSummary(db, { dbPath: path, roots: snapshot.roots });
    const initialRefreshMs = performance.now() - start;
    assert.equal(refreshed.interrupted, false); assert.equal(refreshed.error, undefined);
    const totals = db.connection.prepare('SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens FROM turn_summary').get();
    if (snapshot.expected) assert.deepEqual([totals.requests, totals.tokens], [snapshot.expected.requests, snapshot.expected.tokens]);
    allUsage(db, 'month', {});
    const bounds = db.connection.prepare('SELECT min(started_at_ms) lo,max(started_at_ms) hi FROM turn_summary').get();
    const sessions = db.connection.prepare('SELECT count(*) n FROM sessions').get().n;
    db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { path, ...totals, sessions, initialRefreshMs, openAndMigrationMs, seedFailures: refreshed.failed,
      bodyBytes: refreshed.bodyBytes, range: { minMs: bounds.lo, maxMs: bounds.hi }, databaseBytes: bytes(path), metadataTables: metadataInventory(db),
      filter: { fromMs: Math.floor(bounds.lo / 86400000) * 86400000 - 86400000,
        toMs: Math.ceil(bounds.hi / 86400000) * 86400000 + 86400000, unknownTime: 'include', excludeEmptyUsage: true } };
  } finally { db.close(); }
}

async function upgradeDataset(data, product) {
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const path = join(data.dataRoot, 'upgrade-B.sqlite'); await copyFile(data.initial.A.path, path);
  const began = performance.now(), db = new SummaryDatabase(path), openAndMigrationMs = performance.now() - began;
  try {
    const start = performance.now(), result = await refreshSummary(db, { dbPath: path, roots: data.snapshot.roots });
    const firstRefreshMs = performance.now() - start;
    assert.equal(result.interrupted, false); assert.equal(result.error, undefined); assert.equal(result.failed, 0);
    const totals = db.connection.prepare('SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens FROM turn_summary').get();
    assert.deepEqual([totals.requests, totals.tokens], [data.initial.A.requests, data.initial.A.tokens]);
    db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { openAndMigrationMs, firstRefreshMs, bodyBytes: result.bodyBytes, databaseBytes: bytes(path), metadataTables: metadataInventory(db) };
  } finally { db.close(); }
}

function summary(trials) {
  return Object.fromEntries(scenarios.map(scenario => [scenario, Object.fromEntries(variants.map(variant => {
    const rows = trials.flatMap(t => t.samples).filter(row => row.scenario === scenario && row.variant === variant);
    return [variant, Object.fromEntries(['refreshMs', 'prepareMs', 'metadataPrepareMs', 'aggregateSqlMs', 'storeMs', 'walBytes', 'bodyBytes', 'processPeakRssBytes'].map(key => {
      const measured = stats(rows.map(row => row[key]));
      return [key, key.endsWith('Ms') ? measured : { medianBytes: measured.medianMs, minBytes: measured.minMs, maxBytes: measured.maxMs, samplesBytes: measured.samplesMs }];
    }))];
  }))]));
}

function markdown(report, filename) {
  const number = value => Number(value).toFixed(3);
  const comparison = (a, b) => `${number(a)} → ${number(b)} (${((a - b) / a * 100).toFixed(1)}%)`;
  const metric = (data, scenario, key = 'refreshMs') => comparison(data.summary[scenario].A[key].medianMs, data.summary[scenario].B[key].medianMs);
  const columns = report.datasets.map(data => data.name === 'current' ? `현재 ${data.requests.toLocaleString('en-US')}건` : `${data.requests.toLocaleString('en-US')}건`);
  const table = rows => `| 측정 항목 | ${columns.join(' | ')} |\n| --- | ${columns.map(() => '---:').join(' | ')} |\n${rows.map(([name, values]) => `| ${name} | ${values.join(' | ')} |`).join('\n')}`;
  const rows = [
    ['요청 1건 추가 · Codex', report.datasets.map(data => metric(data, 'codex-append'))],
    ['요청 1건 추가 · Claude', report.datasets.map(data => metric(data, 'claude-append'))],
    ...groups.map(group => [`${({ day: '일별', month: '월별', session: '세션별', project: '프로젝트별' })[group]} 평균 토큰 조회`, report.datasets.map(data => comparison(data.readSummary[group].A.medianMs, data.readSummary[group].B.medianMs))]),
  ];
  const samples = (data, variant, scenario, key) => data.trials.filter(t => t.variant === variant).flatMap(t => t.samples).filter(s => s.scenario === scenario).map(s => s[key]);
  const scalar = (data, variant, scenario, key) => stats(samples(data, variant, scenario, key)).medianMs;
  const fasterPairs = (data, scenario) => {
    let count = 0;
    for (let pair = 0; pair < report.pairs; pair++) {
      const a = data.trials.find(t => t.variant === 'A' && t.pair === pair).samples.find(s => s.scenario === scenario);
      const b = data.trials.find(t => t.variant === 'B' && t.pair === pair).samples.find(s => s.scenario === scenario);
      count += Number(b.refreshMs < a.refreshMs);
    }
    return `${count}/${report.pairs}`;
  };
  const work = [
    ['동일 내용 전수 재파싱', report.datasets.map(data => metric(data, 'rewrite-same'))],
    ['집계 준비 구간 · metadata 포함', report.datasets.map(data => metric(data, 'rewrite-same', 'prepareMs'))],
    ['winner·turn 집계 SQL', report.datasets.map(data => metric(data, 'rewrite-same', 'aggregateSqlMs'))],
    ['세션 저장 구간', report.datasets.map(data => metric(data, 'rewrite-same', 'storeMs'))],
    ['winner 입력 이벤트 수', report.datasets.map(data => `${scalar(data, 'A', 'rewrite-same', 'aggregateInputEvents')} → ${scalar(data, 'B', 'rewrite-same', 'aggregateInputEvents')}`)],
    ['Codex 추가 시 집계한 turn 수', report.datasets.map(data => `${scalar(data, 'A', 'codex-append', 'aggregatePreparedTurns')} → ${scalar(data, 'B', 'codex-append', 'aggregatePreparedTurns')}`)],
    ['Claude 추가 시 집계한 turn 수', report.datasets.map(data => `${scalar(data, 'A', 'claude-append', 'aggregatePreparedTurns')} → ${scalar(data, 'B', 'claude-append', 'aggregatePreparedTurns')}`)],
    ['변경 없는 갱신', report.datasets.map(data => metric(data, 'unchanged'))],
    ['전수 재파싱 B가 빠른 쌍', report.datasets.map(data => fasterPairs(data, 'rewrite-same'))],
    ['Codex 추가 B가 빠른 쌍', report.datasets.map(data => fasterPairs(data, 'codex-append'))],
    ['Claude 추가 B가 빠른 쌍', report.datasets.map(data => fasterPairs(data, 'claude-append'))],
  ];
  const initial = report.datasets.map(data => `| ${data.name} | ${number(data.initial.A.initialRefreshMs)} → ${number(data.initial.B.initialRefreshMs)} | ${data.initial.A.databaseBytes} → ${data.initial.B.databaseBytes} | ${number(data.upgrade.openAndMigrationMs)} / ${number(data.upgrade.firstRefreshMs)} |`).join('\n');
  const input = report.datasets.map(data => `| ${data.name} | ${data.requests} / ${data.sessions} / ${data.inventory.reduce((n, x) => n + x.files, 0)} | ${data.inventory.reduce((n, x) => n + x.bytes, 0)} | [${data.filter.fromMs}, ${data.filter.toMs}) |`).join('\n');
  const states = report.datasets.length * (report.warmups + report.pairs) * 2 * scenarios.length;
  const winners = report.datasets.map(data => `${data.name}: ${scalar(data, 'A', 'rewrite-same', 'aggregateWinnerRows')} → ${scalar(data, 'B', 'rewrite-same', 'aggregateWinnerRows')}`).join(', ');
  return `# 영속 turn metadata A/B 테스트

가정: 사용자는 대상 파일 전수검사를 유지하면서 반복 TEMP 집계·중복 제거·winner 계산을 줄이도록 지시했다. A는 미커밋 JSONL 최적화까지 포함한 기존 구현, B는 turn의 의미 서명과 확정 집계를 영속 저장하고 바뀐 turn 및 응답·누계 의존성만 재계산하는 구현이다. 원본 읽기·파싱, 기존 winner 규칙과 조회 SQL은 유지한다.

## 1. 결과

각 셀은 A → B 중앙값 ms (개선율)이다. 개선율은 (A−B)/A×100이며 양수는 개선이다.

${table(rows)}

${table(work)}

구간 시간은 전체에 포함되며 서로 중첩되므로 더하지 않는다. B의 metadata 서명 비교 시간도 집계 준비 구간에 포함한다. winner 결과 행 수는 ${winners}이다.

| 최초 구축·공간 | 최초 빈 DB 갱신 ms · A → B | checkpoint 후 DB bytes · A → B | B 기존 DB 열기·migration / 첫 갱신 ms |
| --- | ---: | ---: | ---: |
${initial}

최초 구축은 각 한 번의 준비용 관측이며 교차 반복 성능으로 판정하지 않는다. 기존 DB migration은 빈 metadata를 만들며 파일 변경 전까지 채우지 않을 수 있다. 첫 변경에서는 필요한 metadata를 새로 계산한다. WAL bytes·프로세스 최대 RSS·검증 후 RSS는 원시 JSON에 보존한다. 최대 RSS는 같은 worker의 앞선 시나리오와 검증까지 누적한 프로세스 관측값이며 SQLite 고유 메모리나 구간별 peak가 아니다.

## 2. 측정 조건·정확성

측정: ${report.startedAtSeoul}–${report.completedAtSeoul}, Asia/Seoul. ${report.environment.platform} / Node ${report.environment.node} / SQLite ${report.environment.sqlite} / ${report.environment.cpu}. main·TEMP cache 각 4 MiB, TEMP=FILE, mmap=0, WAL과 제품 optimize를 유지한다.

| 입력 | 요청 / 세션 / 파일 | 원본 bytes | 고정 기간 · epoch ms, 끝 제외 |
| --- | ---: | ---: | --- |
${input}

- A는 별도 워크트리에 미커밋 변경을 복사해 고정했다. B도 확정 빌드를 별도 실험 사본으로 복사했다. 소스·빌드·실행기·helper·입력 SHA-256은 [원시 JSON](${filename})에 기록한다. 사전 A 단독 측정은 [별도 JSON](MetadataBaseline-2026-11-05.json)이다.
- 입력별 준비 ${report.warmups}쌍 제외, AB/BA 순서 교대 ${report.pairs}쌍이며 각 variant는 새 프로세스다. 각 시나리오는 해당 variant의 warm DB를 복원하고 같은 원본 사본을 사용한다. OS 캐시는 비우지 않았다. 입력 복사·DB 열기·변경·복원·정확성 검증·해시·IPC는 시간에서 제외한다. 집계 처리량 COUNT 계측은 refresh 시간에 포함한다.
- 전수 재파싱은 모든 원본 사본의 mtime만 변경하고 본문과 parser version은 유지한다. 양쪽 bodyBytes가 정확히 같은지 확인한다. 실제 내용 교체와 파서 버전 변경의 정확성은 제품 테스트로 별도 검증한다.
- 요청 추가는 제공자별 가장 긴 허용 세션의 파일에 같은 요청 1건(+130 tokens)을 추가하고 실제 refreshSummary의 파일 확인·전체 파싱·집계·COMMIT·정리까지 측정한다. 매 표본 후 원본 사본과 DB를 복원한다. 추가 시 원본 크기 이상을 읽었는지도 확인한다.
- 합성 seed는 ordinal-v1(난수 없음), 프로젝트 10개, 세션별 제공자 교대, 제공자별 모델 2개 교대, 모두 완료 상태다. 1만 건은 세션당100요청,100건은 세션당10요청이다. 기간은2026-07-01+sessionIndex%14일에100요청당 하루를 더한다.
- 조회는 준비된 일별 rollup·고정 기간·Asia/Seoul·제공자 기준 queryUsagePage를 1,000행씩 호출해 전체 결과와 COUNT를 반환한다. 조회별 준비3회 뒤 회차당3표본, A/B 각각30표본이다. 평균 분모는 완료 요청 중 사용량이 있거나 알려진 모델이 있는 요청이며 미완료·빈 요청도 총량에는 포함한다.
- 준비 실행 포함 ${states}개 갱신 상태에서 요청 수·토큰·요청/모델/도구/비용/진단 의미해시와 그룹 결과를 A/B 비교했다. 제공자/모델×전체/프로젝트/세션/일/월 raw SQL과 공개 집계는 ${states * 10}회 대조했다. 고정 기간의 일·월·세션·프로젝트 평균은 원본 요청을 독립 JS로 집계해 합계·표본 수·평균·결과 건수를 대조했다. 합성 최초 수집은 생성기의 기대 요청 수·토큰과도 일치한다. 원본 JSONL 파서의 독립 재구현 검증은 아니다. FK·integrity·종료 시 원본 SHA-256 복원을 통과했다. 본문·credential·실제 원본 경로·세션 ID는 보고서에 저장하지 않았다.

## 3. 해석·트레이드오프

전수 읽기·파싱 O(N bytes+R rows)는 그대로다. B는 정규화 이벤트의 서명을 다시 비교하는 비용을 추가하고, 변하지 않은 turn의 winner·모델·도구 집계와 DB snapshot 재쓰기를 건너뛴다. 변경 집합은 공유 응답과 누계 의존성을 따라 넓어지며 최악에는 영향 세션 전체가 된다. 작은 입력·최초 구축에서는 추가 서명·영속 쓰기 비용을 함께 감수한다. JS에는 현재 행·해시 상태만 유지하고 전체 세션 Map을 올리지 않으며, 영속 DB에는 turn별 집계·모델·도구·의존성 저장 공간이 추가된다. 원본 TEMP 이벤트 적재와 dirty 집계용 TEMP는 남아 있다.

표본별 시간 범위와 빠른 쌍 수를 함께 보고 차이가 변동 범위 안이면 개선으로 단정하지 않는다. 최종 채택 판단과 저장소 검사 결과는 코드 의사결정 기록에 함께 남긴다.

## 재실행

두 워크트리를 빌드한 뒤 새 출력 경로를 지정한다. --workspace를 생략하면 새 frozen snapshot을 만들며 현재 데이터 건수는 달라질 수 있다. --smoke는 합성100건1쌍만 실행한다.

\`node tests/benchmarks/metadata-ab.cjs --before=<기준 워크트리> --after=<후보 워크트리> --output=<새 JSON 경로>\`
`;
}

async function main() {
  const options = { before: '', after: root, workspace: '', output: '', baselineOnly: false, smoke: false };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--before=')) options.before = resolve(arg.slice(9));
    else if (arg.startsWith('--after=')) options.after = resolve(arg.slice(8));
    else if (arg.startsWith('--workspace=')) options.workspace = resolve(arg.slice(12));
    else if (arg.startsWith('--output=')) options.output = resolve(arg.slice(9));
    else if (arg === '--baseline-only') options.baselineOnly = true;
    else if (arg === '--smoke') options.smoke = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  assert.ok(options.before && /\.json$/i.test(options.output), 'Pass --before=<baseline> --output=<new JSON>');
  assert.ok(!fs.existsSync(options.output), 'Choose a new output path');
  const cache = join(root, 'tests/.cache'); await mkdir(cache, { recursive: true });
  const directory = options.workspace || await mkdtemp(join(cache, 'metadata-ab-'));
  assert.ok(resolve(directory).startsWith(resolve(cache) + sep), 'Workspace must stay inside benchmark cache');
  await mkdir(directory, { recursive: true });
  const statePath = join(directory, 'state.json');
  let state;
  if (fs.existsSync(statePath)) state = JSON.parse(await readFile(statePath, 'utf8'));
  else {
    const product = join(directory, 'A'); await mkdir(product); await cp(join(options.before, 'dist'), join(product, 'dist'), { recursive: true });
    state = { startedAtSeoul: seoul(), products: { A: product }, sources: { A: fingerprints(options.before, 'src') },
      builds: { A: fingerprints(product, 'dist/src') }, datasets: [] };
    const specs = options.smoke ? [{ name: 'synthetic-100', requests: 100, 'turns-per-session': 10 }]
      : [{ name: 'current', real: true }, { name: 'synthetic-10000', requests: 10000, 'turns-per-session': 100 }, { name: 'synthetic-100', requests: 100, 'turns-per-session': 10 }];
    for (const spec of specs) {
      const dataRoot = join(directory, spec.name); await mkdir(dataRoot);
      const snapshot = await helpers.makeSnapshot(dataRoot, { ...spec, after: product });
      const initial = await seedDataset(snapshot, dataRoot, product, 'A');
      state.datasets.push({ name: spec.name, dataRoot, snapshot, initial: { A: initial } });
      console.log(`baseline ${spec.name}: ${initial.requests} requests, ${initial.sessions} sessions, ${initial.initialRefreshMs.toFixed(2)} ms`);
    }
    await writeFile(statePath, JSON.stringify(state, null, 2));
  }
  const runVariants = options.baselineOnly ? ['A'] : variants;
  if (!options.baselineOnly) {
    state.products.B = join(directory, 'B');
    assert.ok(!fs.existsSync(state.products.B), 'Candidate build already frozen in this workspace');
    await mkdir(state.products.B); await cp(join(options.after, 'dist'), join(state.products.B, 'dist'), { recursive: true });
    state.sources.B = fingerprints(options.after, 'src'); state.builds.B = fingerprints(state.products.B, 'dist/src');
    for (const data of state.datasets) {
      data.initial.B = await seedDataset(data.snapshot, data.dataRoot, state.products.B, 'B');
      data.upgrade = await upgradeDataset(data, state.products.B);
    }
  }
  const sql = new DatabaseSync(':memory:'), sqlite = sql.prepare('SELECT sqlite_version() version').get().version; sql.close();
  const report = { startedAtSeoul: seoul(), hypothesis: 'Keep full parsing; persist normalized metadata and recalculate only changed response/turn keys.',
    pairs: options.baselineOnly ? 1 : options.smoke ? 1 : 10, warmups: options.baselineOnly || options.smoke ? 0 : 3,
    environment: { node: process.version, sqlite, cpu: cpus()[0]?.model, platform: process.platform, timezone, tempStore: 'FILE', cacheKiB: 4096, mmapBytes: 0 },
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    sources: state.sources, builds: state.builds, runnerSha256: sha(fs.readFileSync(__filename)), helperSha256: sha(fs.readFileSync(join(__dirname, 'incremental-refresh.cjs'))),
    aggregationHelperSha256: sha(fs.readFileSync(join(__dirname, 'temp-batch-ab.cjs'))), packageLockSha256: sha(fs.readFileSync(join(root, 'package-lock.json'))), datasets: [] };
  for (const data of state.datasets) {
    const a = data.initial.A, configPath = join(data.dataRoot, options.baselineOnly ? 'baseline-config.json' : 'config.json');
    const seeds = Object.fromEntries(runVariants.map(v => [v, data.initial[v].path]));
    await writeFile(configPath, JSON.stringify({ products: state.products, seeds, directory: state.sourceDirectory ?? directory, roots: data.snapshot.roots, files: data.snapshot.files,
      filter: a.filter, requests: a.requests, tokens: a.tokens }));
    const entry = { name: data.name, requests: a.requests, tokens: a.tokens, sessions: a.sessions, inventory: data.snapshot.inventory,
      inputSha256: data.snapshot.sha256, expected: data.snapshot.expected, range: a.range, filter: a.filter,
      generator: data.snapshot.expected ? { deterministic: true, seed: 'ordinal-v1 (no RNG)', providers: 'alternating sessions',
        projects: 10, turnsPerSession: data.snapshot.expected.turnsPerSession, timestamps: '2026-07-01 plus sessionIndex%14 and floor(index/100) days',
        status: 'all completed', models: 'two per provider alternating by request' } : undefined,
      initial: Object.fromEntries(runVariants.map(v => [v, { ...data.initial[v], path: undefined, filter: undefined, range: undefined }])), trials: [] };
    entry.upgrade = data.upgrade;
    for (let pair = -report.warmups; pair < report.pairs; pair++) {
      const order = options.baselineOnly ? ['A'] : Math.abs(pair) % 2 ? ['B', 'A'] : ['A', 'B'], both = {};
      for (const variant of order) both[variant] = await runWorker(configPath, variant, pair, join(data.dataRoot, options.baselineOnly ? 'baseline' : `pair-${pair}`, variant));
      if (!options.baselineOnly) {
        for (const scenario of scenarios) {
          const left = both.A.samples.find(row => row.scenario === scenario), right = both.B.samples.find(row => row.scenario === scenario);
          for (const key of ['requests', 'tokens', 'failed', 'factsSha256', 'aggregatesSha256', 'independent']) {
            assert.equal(canonical(left[key]), canonical(right[key]), `A/B ${data.name}/${scenario}/${key}`);
          }
          if (scenario === 'rewrite-same') assert.equal(left.bodyBytes, right.bodyBytes, 'All touched files must still be fully read');
        }
        for (const group of groups) assert.equal(both.A.reads[group].sha256, both.B.reads[group].sha256, `read/${group}`);
      }
      if (pair >= 0) entry.trials.push(...order.map(variant => ({ variant, pair, ...both[variant] })));
      const trialRoot = resolve(data.dataRoot, options.baselineOnly ? 'baseline' : `pair-${pair}`);
      assert.ok(trialRoot.startsWith(resolve(directory) + sep)); await rm(trialRoot, { recursive: true, force: true });
    }
    for (const file of data.snapshot.files) assert.equal(sha(fs.readFileSync(file.path)), file.sha256, 'Frozen input was not restored');
    if (!options.baselineOnly) entry.summary = summary(entry.trials);
    entry.readSummary = Object.fromEntries(groups.map(group => [group, Object.fromEntries(runVariants.map(variant =>
      [variant, stats(entry.trials.filter(t => t.variant === variant).flatMap(t => t.reads[group].samplesMs))]))]));
    entry.correctness = { abAllSamples: options.baselineOnly ? 'not applicable' : 'passed', javascriptRequestAggregation: 'passed', rawSqlVsRollups: 'passed', foreignKeysAndIntegrity: 'passed', snapshotRestored: true };
    report.datasets.push(entry);
    await mkdir(dirname(options.output), { recursive: true }); await writeFile(options.output + '.partial', JSON.stringify(report, null, 2) + '\n');
  }
  report.completedAtSeoul = seoul();
  await writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); await rm(options.output + '.partial');
  if (!options.baselineOnly) await writeFile(options.output.replace(/\.json$/i, '.md'), markdown(report, options.output.split(/[\\/]/).at(-1)), { flag: 'wx' });
  console.log(`Saved ${options.output}`);
}

if (process.argv[2] === '--worker') worker(...process.argv.slice(3)).then(() => process.disconnect(), error => {
  process.send({ kind: 'failure', code: error.code ?? error.name, message: String(error.message).split('\n')[0].slice(0, 160) });
  process.exitCode = 1; process.disconnect();
});
else if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
