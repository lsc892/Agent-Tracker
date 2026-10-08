const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir, cpus } = require('node:os');
const { basename, dirname, join, relative, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const {
  TITLE_CASES, createTitleFixture, closeTitleFixture, titleRows, titleVariantSql, verifyTitleRows, titleTempSpace,
} = require('../../dist/tests/fixtures/request-title-ab');

function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

function summary(samples, field) {
  const values = samples.map(sample => sample[field]);
  return { median:quantile(values, 0.5), p10:quantile(values, 0.1), p90:quantile(values, 0.9),
    min:Math.min(...values), max:Math.max(...values) };
}

async function worker() {
  const [, variant, scenario, countText, directory] = process.argv.slice(2);
  const count = Number(countText);
  let sequence = 0;
  process.on('message', async message => {
    if (message.method !== 'run') return;
    const trialDirectory = join(directory, `trial-${sequence++}`);
    let fixture;
    try {
      global.gc();
      fixture = createTitleFixture(trialDirectory, scenario, count);
      const sql = titleVariantSql(fixture.originalSql, variant);
      const before = titleTempSpace(fixture);
      global.gc();
      const rssBeforeBytes = process.memoryUsage().rss;
      const start = performance.now();
      // Includes TEMP table/index construction and the complete production prepareSummaries SQL.
      fixture.database.connection.exec(sql);
      const elapsedMs = performance.now() - start;
      const rssAfterSqlBytes = process.memoryUsage().rss;
      const after = titleTempSpace(fixture);
      const rows = titleRows(fixture);
      verifyTitleRows(fixture, rows);
      const outputDigest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      const marker = 'CREATE TEMP TABLE prepared_turns AS';
      assert.equal(sql.split(marker).length, 2);
      const plan = fixture.database.connection.prepare(`EXPLAIN QUERY PLAN ${sql.split(marker)[1]}`).all().map(row => row.detail);
      const peak = process.resourceUsage().maxRSS;
      const sample = { elapsedMs, cases:rows.length, events:fixture.eventCount, outputDigest,
        additionalLiveTempBytes:after.liveBytes - before.liveBytes, liveTempBytes:after.liveBytes,
        allocatedTempBytes:after.allocatedBytes, freeTempBytes:after.freeBytes,
        titleIndexBytes:after.objects.find(row => row.name === 'component_request_title')?.bytes ?? 0,
        preparedTurnsBytes:after.objects.find(row => row.name === 'prepared_turns')?.bytes ?? 0,
        rssBeforeBytes, rssAfterSqlBytes, processPeakRssBytes:peak > 0 ? peak * 1024 : null,
        sqlite:fixture.database.connection.prepare('SELECT sqlite_version() version').get().version,
        originalSqlSha256:createHash('sha256').update(fixture.originalSql).digest('hex'),
        variantSqlSha256:createHash('sha256').update(sql).digest('hex'), plan, tempObjects:after.objects };
      closeTitleFixture(fixture);
      fixture = undefined;
      // Only the newly created trial directory under this worker's assigned temporary root.
      assert.equal(dirname(resolve(trialDirectory)), resolve(directory));
      assert.ok(basename(trialDirectory).startsWith('trial-'));
      await rm(trialDirectory, { recursive:true, force:true });
      process.send({ id:message.id, sample });
    } catch (error) {
      if (fixture) closeTitleFixture(fixture);
      process.send({ id:message.id, error:error.stack ?? String(error) });
    }
  });
}

function startWorker(variant, scenario, count, directory) {
  const child = fork(__filename, ['--worker', variant, scenario, String(count), directory], {
    execArgv:['--expose-gc'], stdio:['ignore', 'ignore', 'inherit', 'ipc'], windowsHide:true,
  });
  let sequence = 0;
  const pending = new Map();
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  child.on('message', message => {
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error)); else task.resolve(message.sample);
  });
  const rejectPending = error => {
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  };
  child.on('error', rejectPending);
  child.on('exit', (code, signal) => rejectPending(new Error(`Benchmark worker exited: ${code ?? signal}`)));
  return {
    run() {
      return new Promise((resolveRun, reject) => {
        const id = sequence++;
        pending.set(id, { resolve:resolveRun, reject });
        child.send({ id, method:'run' }, error => {
          if (error) { pending.delete(id); reject(error); }
        });
      });
    },
    async stop() { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; },
  };
}

function markdown(report, documentPath, jsonPath) {
  const fmt = value => value.toFixed(3);
  const kib = value => (value / 1024).toFixed(1);
  const link = path => relative(dirname(documentPath), path).replaceAll('\\', '/');
  const rows = report.scenarios.flatMap(item => item.variants.map(variant =>
    `| ${item.name} | ${variant.name === 'partial-index' ? 'A: TEMP partial index' : 'B: 기존 집계에 통합'} | ${fmt(variant.timeMs.median)} | ${fmt(variant.timeMs.p10)}–${fmt(variant.timeMs.p90)} | ${kib(variant.additionalLiveTempBytes.median)} | ${kib(variant.liveTempBytes.median)} | ${kib(variant.allocatedTempBytes.median)} |`));
  const comparisons = report.scenarios.map(item => {
    const [a, b] = item.variants;
    const percent = (1 - b.timeMs.median / a.timeMs.median) * 100;
    return `- **${item.name}**: B의 중앙값은 A보다 ${Math.abs(percent).toFixed(1)}% ${percent >= 0 ? '짧았다' : '길었다'}. 같은 쌍의 A−B 시간 차 중앙값은 ${fmt(item.pairedSavingMs.median)}ms, P10–P90은 ${fmt(item.pairedSavingMs.p10)}–${fmt(item.pairedSavingMs.p90)}ms였다. B의 집계 후 TEMP live 공간은 ${Math.abs(a.liveTempBytes.median - b.liveTempBytes.median) / 1024} KiB ${a.liveTempBytes.median >= b.liveTempBytes.median ? '절약됐다' : '증가했다'}.`;
  });
  const peakRows = report.scenarios.flatMap(item => item.variants.map(variant =>
    `| ${item.name} | ${variant.name} | ${(variant.rssAfterSqlBytes.median / 1048576).toFixed(1)} | ${variant.processPeakRssBytes === null ? '측정 불가' : (variant.processPeakRssBytes / 1048576).toFixed(1)} |`));
  return `# 요청 제목 TEMP 인덱스와 집계 통합 A/B 검증

측정 시각: ${report.recordedAtSeoul} (Asia/Seoul). 동일한 ${report.cases}개 요청 케이스를 두 배치 구조에서 검증했다. 제품의 집계 코드는 변경하지 않았다.

## 비교한 로직

- **A — TEMP partial index**: 현재 제목 상관 서브쿼리를 유지하고 \`component_events(root_id,id) WHERE is_main=1 AND request_title IS NOT NULL\` 인덱스를 추가한다. 인덱스 생성 시간도 측정에 포함한다.
- **B — 기존 집계에 통합**: 현재 \`roots GROUP BY\`에서 \`min(CASE WHEN e.is_main=1 AND e.request_title IS NOT NULL THEN e.id END)\`를 함께 구한다. 기존 \`events.id INTEGER PRIMARY KEY\`로 JOIN해 제목을 가져온다. 별도 Map·제목 테이블·제목 인덱스를 만들지 않는다. 내부 이벤트 ID column은 사용자에게 저장하는 결과 비교에서 제외한다.

두 방식 모두 제공자·세션·요청 식별자로 범위를 구분하고, 제목이 있는 메인 이벤트 중 가장 작은 이벤트 ID를 선택한다. 현재 \`prepareSummaries()\` SQL을 실행 시 가져와 제목 부분만 치환한다. 원본 SQL의 구조가 달라져 치환 위치가 맞지 않으면 실패한다.

## 입력과 정확성

- 합성 입력: 각 구조 ${report.cases}개 요청, ${report.scenarios[0].events}개 이벤트. 개인 대화·인증 정보·네트워크 호출은 사용하지 않는다.
- **long-session**: Codex의 한 긴 세션에 모든 요청을 배치한다.
- **mixed-sessions**: Claude·Codex와 여러 세션에 배치한다. 제공자 간 session ID, 세션·제공자 간 root ID를 의도적으로 중복한다.
- 각 케이스 종류는 ${report.categoryCounts.map(item => `${item.name} ${item.count}개`).join(', ')}다.
- 기대 제목은 fixture에서 독립적으로 지정하고, 제목·요청 수·입출력/캐시 토큰·시작/완료 시각·상태·결제 방식을 검사한다.
- \`node:test\`는 각 구조 ${report.cases}개 케이스에 대해 최적화하지 않은 현재 제품 SQL, A, B의 모든 집계 결과 column이 같은지도 검사한다. 총 ${report.cases * report.scenarios.length}개 서로 다른 배치 케이스를 비교한다.
- 벤치마크의 워밍업·측정 모든 실행에서도 기대값을 검사하고, 각 A/B 쌍의 전체 결과 SHA-256 일치를 검사했다. 실패하면 보고서를 성공 결과로 생성하지 않는다.

## 측정 방법

- Node ${report.environment.node}, SQLite ${report.environment.sqlite}, ${report.environment.platform}/${report.environment.arch}, ${report.environment.cpu}, 논리 CPU ${report.environment.logicalCpus}개.
- 구조별 A·B를 별도 Node process에 둔다. 두 process의 SQL 실행은 순차 실행한다.
- 각 방식 워밍업 ${report.warmups}회 후 ${report.pairs}쌍 측정한다. 쌍마다 A→B, B→A 순서를 교차한다. 측정 중 두 방식을 동시에 실행하지 않는다.
- 매 실행 새 DB 연결과 TEMP 테이블을 만든다. \`temp_store=FILE\`, main/TEMP cache 각 4 MiB로 제품 설정을 따른다. process JIT와 OS 캐시가 워밍업된 조건이며 최초 디스크 읽기 성능은 측정하지 않는다.
- 시간 범위: 전체 \`prepareSummaries\` SQL 실행. 공통 TEMP 복사·인덱스, 토큰 중복 제거, 상태·제목 집계가 포함된다. 입력 이벤트 생성, 정확성 검사, 공간 조회, JSONL 읽기·파싱, 영속 DB 교체, worker IPC, UI 렌더링은 제외한다.
- \`performance.now()\`로 시간을 측정하고 중앙값·P10·P90과 쌍별 차를 기록한다. P10–P90은 관측 변동 범위이며 신뢰구간이 아니다.
- TEMP live 공간은 \`dbstat('temp')\`의 실제 할당 페이지 합계다. 추가 live 공간은 집계 완료 후에서 입력 준비 완료 시점을 뺀 값이다. allocated는 \`temp.page_count × temp.page_size\`이며 재사용 가능한 빈 페이지를 포함한다.

## 시간과 TEMP 공간

시간 단위는 ms, 공간 단위는 KiB다. 전체 갱신 시간이 아니라 위에 정의한 SQL 집계 구간이다.

| 배치 구조 | 방식 | 시간 중앙값 | 시간 P10–P90 | 추가 TEMP live | 전체 TEMP live | TEMP allocated |
|---|---|---:|---:|---:|---:|---:|
${rows.join('\n')}

${comparisons.join('\n')}

## Process 메모리

단위는 MiB다. SQL 직후 RSS는 같은 시점의 process 전체 사용량 중앙값이다. 최대 RSS는 해당 방식의 격리 process가 워밍업·모든 측정·fixture 준비·결과 검증을 포함해 기록한 최대값이다. SQL 작업만의 최대 메모리나 JS 객체만의 메모리로 해석하지 않는다.

| 배치 구조 | 방식 | SQL 직후 RSS 중앙값 | process 최대 RSS |
|---|---|---:|---:|
${peakRows.join('\n')}

## 해석과 한계

위 비교는 현재 SQL과 이 합성 데이터에서의 측정 결과다. 두 배치 구조의 결과를 함께 보고 선택한다. 제품 적용 전에는 JSONL 파싱·fork 중복 제거·영속 저장까지 포함한 기존 통합 테스트도 통과해야 한다.

집계 후 TEMP 할당은 정렬 도중 잠깐 생성된 임시 구조의 최대 공간을 측정하지 않는다. RSS에는 Node와 SQLite, fixture·결과 객체가 함께 포함된다. 단일 데이터 크기의 측정만으로 점근적 공간복잡도나 모든 실제 세션에서의 우월성을 증명할 수 없다. 실제 전체 갱신의 다른 단계는 그대로이므로 이 비율을 전체 갱신에 적용하지 않는다.

## 재실행

\`npm run benchmark:titles -- --cases ${report.cases} --pairs ${report.pairs} --warmups ${report.warmups}\`

정확성 테스트는 \`npm run check\`에 포함된다. 시간에 고정된 합격선을 두지 않는다. 기본 Markdown·원시 JSON은 \`tests/results/benchmarks/request-titles.md\`, \`tests/results/benchmarks/request-titles.json\`에 저장된다. \`--report docs/RequestTitleAB.md\`를 추가하면 Markdown과 인접한 \`benchmarks/RequestTitleAB.json\`에도 보관한다. 원시 JSON에는 개별 시간·공간, SQL hash, 실행 계획이 들어간다.

원시 기록: [측정 JSON](${link(jsonPath)}).

코드: [fixture와 두 SQL](${link(resolve(__dirname, '../fixtures/request-title-ab.ts'))}), [정확성 테스트](${link(resolve(__dirname, '../node/request-title-ab.test.ts'))}), [A/B 실행기](${link(__filename)}).
`;
}

async function main() {
  const args = process.argv.slice(2);
  const options = { cases:2000, pairs:20, warmups:4, report:undefined };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].replace(/^--/, '');
    assert.ok(Object.hasOwn(options, key) && args[index + 1], `Unknown/missing option: ${args[index]}`);
    options[key] = key === 'report' ? args[index + 1] : Number(args[index + 1]);
  }
  for (const key of ['cases', 'pairs', 'warmups']) assert.ok(Number.isSafeInteger(options[key]), `${key} must be an integer`);
  assert.ok(options.cases >= 10 && options.cases <= 100000 && options.pairs >= 4 && options.pairs <= 200
    && options.warmups >= 1 && options.warmups <= 20, 'Invalid benchmark dimensions');
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-title-ab-'));
  const scenarios = [];
  try {
    for (const name of ['long-session', 'mixed-sessions']) {
      const names = ['partial-index', 'combined-aggregate'];
      const workers = names.map(variant => startWorker(variant, name, options.cases, join(directory, name, variant)));
      const warmups = [[], []];
      const samples = [[], []];
      try {
        for (let round = 0; round < options.warmups + options.pairs; round++) {
          const pair = [];
          const order = round % 2 ? [1, 0] : [0, 1];
          for (const variant of order) {
            pair[variant] = await workers[variant].run();
            pair[variant].orderPosition = order.indexOf(variant);
          }
          assert.equal(pair[0].outputDigest, pair[1].outputDigest, 'A/B summary results differ');
          assert.equal(pair[0].originalSqlSha256, pair[1].originalSqlSha256, 'Production SQL changed during the benchmark');
          for (let variant = 0; variant < 2; variant++) {
            (round < options.warmups ? warmups : samples)[variant].push(pair[variant]);
          }
          console.log(`${name}: ${round < options.warmups ? `warmup ${round + 1}/${options.warmups}` : `pair ${round - options.warmups + 1}/${options.pairs}`} — A ${pair[0].elapsedMs.toFixed(2)}ms, B ${pair[1].elapsedMs.toFixed(2)}ms; ${options.cases} cases matched`);
        }
      } finally { await Promise.all(workers.map(worker => worker.stop())); }
      const variants = names.map((variant, index) => ({ name:variant, timeMs:summary(samples[index], 'elapsedMs'),
        additionalLiveTempBytes:summary(samples[index], 'additionalLiveTempBytes'),
        liveTempBytes:summary(samples[index], 'liveTempBytes'), allocatedTempBytes:summary(samples[index], 'allocatedTempBytes'),
        rssAfterSqlBytes:summary(samples[index], 'rssAfterSqlBytes'),
        processPeakRssBytes:samples[index].at(-1).processPeakRssBytes, samples:samples[index], warmups:warmups[index] }));
      scenarios.push({ name, events:samples[0][0].events, variants,
        pairedSavingMs:summary(samples[0].map((sample, index) => ({ value:sample.elapsedMs - samples[1][index].elapsedMs })), 'value') });
    }
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('agent-tracker-title-ab-'));
    await rm(directory, { recursive:true, force:true });
  }
  const report = { recordedAtSeoul:new Intl.DateTimeFormat('sv-SE', { timeZone:'Asia/Seoul', dateStyle:'short', timeStyle:'medium' }).format(new Date()),
    ...options, environment:{ node:process.version, sqlite:scenarios[0].variants[0].samples[0].sqlite,
      platform:process.platform, arch:process.arch, cpu:cpus()[0]?.model, logicalCpus:cpus().length },
    categoryCounts:TITLE_CASES.map((name, index) => ({ name, count:Math.floor((options.cases + TITLE_CASES.length - 1 - index) / TITLE_CASES.length) })), scenarios };
  const output = resolve(__dirname, '../results/benchmarks');
  await mkdir(output, { recursive:true });
  const raw = JSON.stringify(report, null, 2) + '\n';
  const defaultJsonPath = join(output, 'request-titles.json');
  const defaultDocumentPath = join(output, 'request-titles.md');
  await writeFile(defaultJsonPath, raw);
  await writeFile(defaultDocumentPath, markdown(report, defaultDocumentPath, defaultJsonPath));
  if (options.report) {
    const reportPath = resolve(options.report);
    const jsonPath = join(dirname(reportPath), 'benchmarks', `${basename(reportPath, '.md')}.json`);
    await mkdir(dirname(jsonPath), { recursive:true });
    await writeFile(jsonPath, raw);
    await writeFile(reportPath, markdown(report, reportPath, jsonPath));
  }
  console.log(`Report: ${options.report ? resolve(options.report) : join(output, 'request-titles.md')}`);
}

if (process.argv[2] === '--worker') {
  worker().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
