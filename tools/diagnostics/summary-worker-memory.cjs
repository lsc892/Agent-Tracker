// 동일한 고정 로그에서 Worker 4·2·1개 설정의 메모리와 경과 시간을 관측한다.
'use strict';

const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');

const root = resolve(__dirname, '../..');
const memory = () => process.memoryUsage();
async function gc() { await nextTurn(); global.gc(); await nextTurn(); global.gc(); await nextTurn(); }

async function worker(configPath, directory, workers) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const { SummaryDatabase } = require('../../dist/src/summary/db');
  const { refreshSummary } = require('../../dist/src/summary/scanner');
  const { StreamingAggregation } = require('../../dist/src/summary/aggregation/memoryAggregate');
  const dbPath = join(directory, 'summary.sqlite'), database = new SummaryDatabase(dbPath);
  let peak, createdWorkers = 0, activeWorkers = 0, maximumWorkers = 0;
  // [Worker 측정 정책] 생성 이벤트와 종료 이벤트로 전체 생성 수와 동시 실행 최댓값을 센다.
  process.on('worker', thread => {
    createdWorkers++; activeWorkers++; maximumWorkers = Math.max(maximumWorkers, activeWorkers);
    thread.once('exit', () => { activeWorkers--; });
  });
  const sample = () => {
    if (!peak) return;
    const now = memory();
    for (const key of Object.keys(now)) peak[key] = Math.max(peak[key], now[key]);
  };
  // [측정 정책] 정기 샘플에 더해 동기 집계의 시작과 끝에서도 메모리를 읽는다.
  const originalFinish = StreamingAggregation.prototype.finish;
  StreamingAggregation.prototype.finish = function(...args) {
    sample(); const result = Reflect.apply(originalFinish, this, args); sample(); return result;
  };
  let expected;
  const samples = [];
  try {
    // [측정 정책] 예열 이후의 실행만 남기고 매번 파서 버전을 초기화해 같은 입력을 재파싱한다.
    for (let iteration = -2; iteration <= 5; iteration++) {
      database.connection.exec('UPDATE manifest SET parser_version=0');
      await gc();
      const before = memory(), workerCount = createdWorkers, started = performance.now();
      peak = { ...before };
      const timer = setInterval(sample, 10);
      let result;
      try { result = await refreshSummary(database, { dbPath, roots: config.roots, timezone: 'Asia/Seoul', sourceWorkers: workers }, undefined, sample); }
      finally { clearInterval(timer); }
      const elapsedMs = performance.now() - started, beforeGc = memory(), observedPeak = peak;
      peak = undefined;
      if (result.failed || result.interrupted || activeWorkers) throw new Error('Worker comparison did not finish cleanly');
      // [검증 정책] 반복 결과의 요청 수와 토큰 합계가 기준과 같은지 확인한다.
      const totals = database.connection.prepare('SELECT count(*) requests,sum(total_tokens) tokens FROM turn_summary').get();
      const encoded = JSON.stringify(totals);
      if (expected && encoded !== expected) throw new Error('Worker settings changed request/token totals');
      expected ??= encoded;
      await gc();
      if (iteration > 0) samples.push({ iteration, before, beforeGc, afterGc: memory(), observedPeak, elapsedMs,
        createdWorkers: createdWorkers - workerCount, maximumWorkers, activeWorkers,
        parsed: result.parsed, bodyBytes: result.bodyBytes });
    }
    process.send({ requestedWorkers: workers, totals: JSON.parse(expected), samples });
  } finally { database.close(); }
}

function run(config, directory, workers) {
  return new Promise((done, fail) => {
    // [실행 격리 정책] 각 Worker 설정을 강제 GC가 가능한 새 프로세스에서 관측한다.
    const child = fork(__filename, ['--child', config, directory, String(workers)], {
      cwd: root, execArgv: ['--expose-gc'], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let result, errorText = '';
    child.stderr.on('data', value => { errorText = (errorText + value).slice(-3000); });
    child.on('message', value => { result = value; });
    child.on('error', fail);
    child.on('exit', code => code === 0 && result ? done(result) : fail(new Error(`Worker ${workers}: ${errorText}`)));
  });
}

async function main() {
  const workspace = resolve(process.argv[2]);
  const report = { dateSeoul: '2026-11-16', runnerSha256: createHash('sha256').update(readFileSync(__filename)).digest('hex'),
    method: 'One fresh process per setting; 3 warmups + 5 full reparses of the same frozen real input; forced GC between runs. Fixed order 4,2,1; observations, not a randomized speed benchmark.',
    variants: [] };
  for (const workers of [4, 2, 1]) {
    const directory = join(workspace, `workers-${workers}`);
    await mkdir(directory, { recursive: true });
    const result = await run(join(workspace, 'real/config.private.json'), directory, workers);
    report.variants.push(result);
    console.log(JSON.stringify({ workers, samples: result.samples.map(sample => ({ iteration: sample.iteration,
      peakRssMB: +(sample.observedPeak.rss / 1e6).toFixed(2), afterGcHeapMB: +(sample.afterGc.heapUsed / 1e6).toFixed(2),
      elapsedMs: +sample.elapsedMs.toFixed(1) })) }));
  }
  const output = join(root, 'docs/research/2026-11-16/SummaryWorkerMemory-2026-11-16.json');
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output }));
}

if (process.argv[2] === '--child') {
  worker(process.argv[3], process.argv[4], Number(process.argv[5]))
    .then(() => process.disconnect(), error => { console.error(error.stack); process.exitCode = 1; process.disconnect(); });
} else main().catch(error => { console.error(error.stack); process.exitCode = 1; });
