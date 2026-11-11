// 보존된 전체 DTO 집계와 현재 스트리밍 winner 수집을 같은 고정 입력에서 비교한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { join, resolve, dirname, relative, sep, basename } = require('node:path');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { cpus } = require('node:os');
const { performance } = require('node:perf_hooks');
const helpers = require('./incremental-refresh.cjs');
const { allUsage, independentCheck, stats, fingerprints, digest } = require('./temp-batch-ab.cjs');
const root = resolve(__dirname, '../..'), groups = ['day', 'month', 'session', 'project'];
const sha = value => createHash('sha256').update(value).digest('hex');
const seoul = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());

function totals(db) {
  return { ...db.connection.prepare(`SELECT count(*) requests,coalesce(sum(input_tokens),0) input,
    coalesce(sum(output_tokens),0) output,coalesce(sum(total_tokens),0) tokens FROM turn_summary`).get() };
}

function checked(db, filter, buildUsageQuery) {
  const verified = helpers.verify(db, buildUsageQuery), independent = {};
  for (const group of groups) independent[group] = independentCheck(db, filter, group, allUsage(db, group, filter));
  // parser version is intentionally different; compare semantic facts independently of it.
  const statements = [
    'SELECT * FROM turn_summary ORDER BY provider,session_id,root_turn_id',
    `SELECT t.provider,t.session_id,t.root_turn_id,u.* FROM turn_summary t JOIN turn_model_usage u ON u.turn_id=t.id ORDER BY t.provider,t.session_id,t.root_turn_id,u.model`,
    `SELECT t.provider,t.session_id,t.root_turn_id,u.* FROM turn_summary t JOIN turn_capability_usage u ON u.turn_id=t.id ORDER BY t.provider,t.session_id,t.root_turn_id,u.category,u.name`,
    `SELECT t.provider,t.session_id,t.root_turn_id,u.* FROM turn_summary t JOIN turn_costs u ON u.turn_id=t.id ORDER BY t.provider,t.session_id,t.root_turn_id`,
    'SELECT * FROM projects ORDER BY project_key', 'SELECT * FROM sessions ORDER BY provider,session_id',
    `SELECT provider,session_id,size_bytes,processing_status,last_error,source_missing,content_hash FROM manifest ORDER BY provider,path`,
  ];
  const facts = statements.map(sql => db.connection.prepare(sql).all().map(helpers.normalized));
  return { ...totals(db), factsSha256: digest(facts), aggregatesSha256: verified.aggregatesSha256,
    rawChecks: verified.rawChecks, independent };
}

async function worker(configPath, variant, work) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')), product = config.products[variant];
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const { buildUsageQuery } = require(join(product, 'dist/src/summary/db/queries'));
  await fsp.mkdir(work, { recursive: true });
  const path = join(work, 'summary.sqlite'), db = new SummaryDatabase(path), samples = {};
  let target;
  const refresh = async name => {
    global.gc();
    const memoryBefore = process.memoryUsage(), start = performance.now();
    const refreshed = await refreshSummary(db, { dbPath: path, roots: config.roots });
    const ms = performance.now() - start;
    const memoryAfter = process.memoryUsage(), highWaterRssBytes = process.resourceUsage().maxRSS * 1024;
    assert.equal(refreshed.interrupted, false); assert.equal(refreshed.error, undefined); assert.equal(refreshed.failed, 0);
    global.gc();
    const retainedHeapAfterGcBytes = process.memoryUsage().heapUsed;
    samples[name] = { ms, parsed: refreshed.parsed, bodyBytes: refreshed.bodyBytes, memoryBefore, memoryAfter,
      retainedHeapAfterGcBytes, retainedHeapDeltaBytes: retainedHeapAfterGcBytes - memoryBefore.heapUsed, highWaterRssBytes };
    return samples[name];
  };
  try {
    await refresh('initial');
    const initial = checked(db, config.filter, buildUsageQuery);
    if (config.expected) assert.deepEqual([initial.requests, initial.tokens], [config.expected.requests, config.expected.tokens]);
    if (config.oracle) assert.deepEqual([initial.requests, initial.input, initial.output, initial.tokens],
      [config.oracle.requests, config.oracle.input_tokens, config.oracle.output_tokens, config.oracle.total_tokens]);
    await refresh('unchanged'); assert.equal(samples.unchanged.bodyBytes, 0);
    target = helpers.chooseTarget(db, 'codex', config.directory);
    await helpers.inspectCodexTarget(target, product);
    await helpers.appendRows(target, helpers.codexAppendRows(target, 'streaming-ab-added-request', 'streaming-ab-added-response'), config.directory, 1);
    await refresh('append');
    const added = checked(db, config.filter, buildUsageQuery);
    assert.deepEqual([added.requests, added.input, added.output, added.tokens],
      [initial.requests + 1, initial.input + 123, initial.output + 7, initial.tokens + 130]);
    const reads = {};
    for (const group of groups) {
      for (let n = 0; n < 3; n++) allUsage(db, group, config.filter);
      const started = performance.now(), result = allUsage(db, group, config.filter);
      const ms = performance.now() - started;
      independentCheck(db, config.filter, group, result);
      reads[group] = { ms, rows: result.length, sha256: digest(result.map(helpers.normalized)) };
    }
    process.send({ result: { samples, initial, added, reads, targetRequestsBefore: target.requests,
      targetBytesBefore: target.originalBytes, sqlite: db.connection.prepare('SELECT sqlite_version() v').get().v } });
  } finally {
    if (target) { await fsp.truncate(target.path, target.originalBytes); await fsp.utimes(target.path, target.originalAtime, target.originalMtime); }
    db.close();
  }
}

async function run(config, variant, pair, work) {
  return new Promise((done, fail) => {
    const child = fork(__filename, ['--worker', config, variant, work], {
      execArgv: ['--expose-gc', '--no-warnings'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    let result, error = '';
    child.stderr.on('data', data => { error += data; });
    child.on('message', message => { if (message.result) result = message.result; });
    child.on('error', fail);
    child.on('exit', code => {
      if (code !== 0 || !result) { fail(new Error(error.slice(-2500) || `Worker failed ${code}`)); return; }
      console.log(`${pair < 0 ? 'warmup' : 'pair'} ${pair}/${variant}: initial=${result.samples.initial.ms.toFixed(2)}ms append=${result.samples.append.ms.toFixed(2)}ms bytes=${result.samples.append.bodyBytes}`);
      done(result);
    });
  });
}

async function frozenCopy(directory, manifestPath) {
  const input = JSON.parse(fs.readFileSync(manifestPath, 'utf8')), originalDirectory = dirname(manifestPath);
  for (const file of input.files) assert.equal(sha(fs.readFileSync(file.path)), file.sha256, 'Original frozen input hash');
  const source = resolve(originalDirectory, 'snapshot');
  const mapped = path => {
    const name = relative(source, path);
    assert.ok(name && !name.startsWith('..') && !resolve(path).includes('\0'));
    return resolve(directory, 'snapshot', name);
  };
  await fsp.cp(source, join(directory, 'snapshot'), { recursive: true, preserveTimestamps: true });
  return { ...input, roots: input.roots.map(entry => ({ ...entry, path: mapped(entry.path), ...(entry.dataHome ? { dataHome: mapped(entry.dataHome) } : {}) })),
    files: input.files.map(file => ({ ...file, path: mapped(file.path) })) };
}

function summarize(trials) {
  const result = {};
  for (const metric of ['initial', 'append', 'unchanged', ...groups]) {
    result[metric] = {};
    for (const variant of ['A', 'B']) result[metric][variant] = stats(trials.map(pair => groups.includes(metric)
      ? pair[variant].reads[metric].ms : pair[variant].samples[metric].ms));
    const a = result[metric].A.medianMs, b = result[metric].B.medianMs;
    result[metric].improvementPercent = a ? (a - b) / a * 100 : null;
  }
  for (const metric of ['retainedHeapAfterGcBytes', 'retainedHeapDeltaBytes', 'highWaterRssBytes', 'bodyBytes']) {
    result[metric] = Object.fromEntries(['A', 'B'].map(variant => [variant,
      Object.fromEntries(['initial', 'append'].map(scenario => [scenario,
        stats(trials.map(pair => pair[variant].samples[scenario][metric])).medianMs]))]));
  }
  return result;
}

function markdown(report, jsonName) {
  const cell = value => `${value.A.medianMs.toFixed(2)} → ${value.B.medianMs.toFixed(2)} (${value.improvementPercent >= 0 ? '+' : ''}${value.improvementPercent.toFixed(2)}%)`;
  const labels = { initial: '초회 전체 수집·저장', append: '요청 1건 추가·갱신·COMMIT', unchanged: '변경 없는 갱신', day: '일별 평균 토큰 조회', month: '월별 평균 토큰 조회', session: '세션별 평균 토큰 조회', project: '프로젝트별 평균 토큰 조회' };
  return `# 스트리밍 winner A/B 테스트\n\n${report.startedAtSeoul}–${report.completedAtSeoul}, Asia/Seoul.\n\n가정: 사용자는 파일을 읽으며 같은 그룹의 winner와 비교하고 더 좋은 후보의 전체 값을 같은 DTO에 반영한 뒤 패자를 버리는 방식을 요청했다. 에이전트의 성능 가정은 전체 이벤트 DTO 보관을 줄이면 메모리를 절약할 수 있으나 유효성 근거와 winner 선택을 위한 두 번의 읽기로 수집 시간은 증가할 수 있다는 것이다.\n\n개선 방향: A = 교체 직전 보존 빌드의 파일별 전체 DTO 캐시·후처리 winner 선택. B = 현재 작업 트리의 근거 수집 → 두 번째 읽기에서 winner DTO 갱신·패자 폐기. B는 그룹 조회용 Map을 유지한다. 이전 배열 선형 탐색 대조군과 다른 실제 수집 구현이다. 제품 코드와 설치 상태는 이번 실험에서 바꾸지 않았다.\n\n## 1. 결과\n\n각 셀은 A → B 중앙값 ms (개선율)이다. 양수는 개선, 음수는 악화다.\n\n| 측정 항목 | ${report.datasets.map(data => data.name === 'current' ? `현재 고정 사본 ${data.requests.toLocaleString('en')}건` : `${data.requests.toLocaleString('en')}건`).join(' | ')} |\n| --- | ---: | ---: | ---: |\n${Object.entries(labels).map(([key, label]) => `| ${label} | ${report.datasets.map(data => cell(data.summary[key])).join(' | ')} |`).join('\n')}\n\n측정 조건: ${report.environment.platform}, Node ${report.environment.node}, SQLite ${report.environment.sqlite}, ${report.environment.cpu}. ${report.conditions}\n\n현재 데이터는 이 날짜의 기존 정합성 검증에 사용한 601파일·1,518요청 고정 사본이며 이후 새 로그는 포함하지 않는다. 합성 데이터는 고정 산식(난수 없음)으로 제공자 절반씩, 10프로젝트, 2026-07-01부터 14일 분포다. 1만 요청은 100세션·세션당 100건, 100요청은 10세션·세션당 10건이다. 평균의 분모는 제품과 같이 완료되고 사용량이 기록된 요청이며 미상 시각도 포함한다. 전체 기간은 ${report.filter.fromMs} ≤ 시작 시각 < ${report.filter.toMs}, 시간대 Asia/Seoul로 고정했다.\n\n정확성: 모든 준비·측정 쌍에서 요청 수·입출력 토큰·요청/모델/도구/비용/이름/진단 facts와 10차원 조회가 A/B 동일했다. 정규화 요청에서 별도 JS로 계산한 네 집계의 합계·완료 분모·평균·결과 건수, 합성 입력 산식, 현재 사본의 사전 oracle 합계를 통과했다. 요청 추가 후 정확히 1요청·130토큰 증가했다. 원시 결과: [JSON](./${jsonName}).\n\n## 2. 분석\n\n<!-- 측정 결과를 확인한 뒤 판정·관측 근거·선택 의견을 작성한다. -->\n`;
}

async function main() {
  const options = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--') && arg.includes('=')).map(arg => {
    const index = arg.indexOf('='); return [arg.slice(2, index), resolve(arg.slice(index + 1))];
  }));
  assert.ok(options.before && options.output, '--before=<archived dist directory> --output=<new JSON>');
  assert.equal(fs.existsSync(options.output), false, 'Never overwrite measurements');
  const smoke = process.argv.includes('--smoke'), directory = await fsp.mkdtemp(join(root, 'tests/.cache/streaming-winner-ab-'));
  const products = { A: join(directory, 'products/A'), B: join(directory, 'products/B') };
  await fsp.cp(options.before, join(products.A, 'dist'), { recursive: true });
  await fsp.cp(join(options.after || root, 'dist'), join(products.B, 'dist'), { recursive: true });
  const filter = { fromMs: -8640000000000000, toMs: 8640000000000000, unknownTime: 'include', excludeEmptyUsage: true };
  const report = { startedAtSeoul: seoul(), scope: 'Archived pre-replacement product A versus frozen current worktree B; integrated scanner comparison including source cache removal, two reads and removal of derived metadata persistence.',
    runnerSha256: sha(fs.readFileSync(__filename)), helperHashes: Object.fromEntries(['incremental-refresh.cjs', 'temp-batch-ab.cjs', 'summary-paths.cjs'].map(name => [name, sha(fs.readFileSync(join(__dirname, name)))])),
    builds: Object.fromEntries(['A', 'B'].map(variant => [variant, fingerprints(products[variant], 'dist/src')])),
    sources: { B: fingerprints(options.after || root, 'src'), A: { availability: 'Pre-replacement source snapshot is not complete; archived compiled build is frozen and fully fingerprinted.' } },
    environment: { platform: process.platform, node: process.version, cpu: cpus()[0]?.model, timezone: 'Asia/Seoul' },
    conditions: '각 규모 준비 3쌍 뒤 A→B/B→A 교대 10쌍. variant/표본마다 별도 새 프로세스·새 DB에서 초회 구축 후 동일한 1요청 추가 전 상태를 만든다. 파일 복사·생성·append 자체·프로세스 기동·검증은 측정에서 제외한다. 추가 시간은 갱신과 COMMIT 완료까지다. 평균 조회는 추가 후 전체 페이지 반환까지다. OS 파일 캐시는 warm이고 SQLite·JS 캐시는 variant별 독립이다. refresh 직전과 직후 강제 GC는 시간에서 제외하며 직후 heap은 retained 크기이고 peak가 아니다. 초회 maxRSS는 첫 검증 전 프로세스 high-water이며 모듈 적재를 포함한다. 변경 없는 갱신의 본문 읽기는 모두 0byte다.',
    warmups: smoke ? 0 : 3, pairs: smoke ? 1 : 10, filter, datasets: [] };
  const specs = smoke ? [{ name: 'synthetic-100', requests: 100, 'turns-per-session': 10 }]
    : [{ name: 'current' }, { name: 'synthetic-10000', requests: 10000, 'turns-per-session': 100 }, { name: 'synthetic-100', requests: 100, 'turns-per-session': 10 }];
  for (const spec of specs) {
    const dataDirectory = join(directory, spec.name); await fsp.mkdir(dataDirectory, { recursive: true });
    assert.ok(spec.name !== 'current' || options['current-snapshot'], '--current-snapshot=<frozen manifest> required for full run');
    const snapshot = spec.name === 'current' ? await frozenCopy(dataDirectory, options['current-snapshot'])
      : await helpers.makeSnapshot(dataDirectory, { ...spec, after: products.B });
    const oracle = spec.name === 'current' && options.oracle ? JSON.parse(fs.readFileSync(options.oracle, 'utf8')) : undefined;
    if (oracle) assert.equal(snapshot.sha256, oracle.snapshotSha256);
    const config = join(dataDirectory, 'config.json');
    await fsp.writeFile(config, JSON.stringify({ products, directory: dataDirectory, roots: snapshot.roots, expected: snapshot.expected, oracle: oracle?.totals, filter }));
    const entry = { name: spec.name, inventory: snapshot.inventory, inputSha256: snapshot.sha256, expected: snapshot.expected,
      oracle: oracle ? { sha256: sha(fs.readFileSync(options.oracle)), totals: oracle.totals } : undefined, trials: [], warmupChecks: [] };
    for (let pair = -report.warmups; pair < report.pairs; pair++) {
      const both = {};
      for (const variant of (pair + report.warmups) % 2 ? ['B', 'A'] : ['A', 'B']) {
        both[variant] = await run(config, variant, pair, join(dataDirectory, `pair-${pair}/${variant}`));
      }
      assert.deepEqual(both.A.initial, both.B.initial, 'Initial facts and all aggregates');
      assert.deepEqual(both.A.added, both.B.added, 'Added facts and all aggregates');
      assert.equal(both.A.targetRequestsBefore, both.B.targetRequestsBefore);
      for (const group of groups) assert.deepEqual([both.A.reads[group].rows, both.A.reads[group].sha256], [both.B.reads[group].rows, both.B.reads[group].sha256]);
      if (pair < 0) entry.warmupChecks.push({ pair, equal: true }); else entry.trials.push(both);
      report.environment.sqlite = both.A.sqlite; assert.equal(both.A.sqlite, both.B.sqlite);
    }
    entry.requests = entry.trials[0].A.initial.requests; entry.tokens = entry.trials[0].A.initial.tokens;
    entry.summary = summarize(entry.trials);
    for (const file of snapshot.files) assert.equal(sha(fs.readFileSync(file.path)), file.sha256, 'Frozen copy must be restored');
    entry.correctness = { allAbPairs: true, rawSqlRollup10Dimensions: true, independentJsAverages: true, exactAppendDelta: true, sourceRestored: true, foreignKeysAndIntegrity: true };
    report.datasets.push(entry);
    await fsp.mkdir(dirname(options.output), { recursive: true });
    await fsp.writeFile(options.output + '.partial', JSON.stringify(report, null, 2) + '\n');
    console.log(`completed ${spec.name}: ${entry.requests} requests`);
  }
  report.completedAtSeoul = seoul();
  report.buildCopiesUnchanged = ['A', 'B'].every(variant => digest(fingerprints(products[variant], 'dist/src')) === digest(report.builds[variant]));
  assert.equal(report.buildCopiesUnchanged, true);
  await fsp.writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await fsp.unlink(options.output + '.partial');
  await fsp.writeFile(options.output.replace(/\.json$/i, '.md'), markdown(report, basename(options.output)), { flag: 'wx' });
  console.log(`Saved ${basename(options.output)}`);
}

if (process.argv[2] === '--worker') worker(...process.argv.slice(3)).catch(error => { console.error(error); process.exitCode = 1; });
else if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
