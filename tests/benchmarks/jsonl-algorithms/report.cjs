// 같은 표본의 구간 시간·공간과 최종 시간·관측 피크를 알고리즘별 한 행으로 정리한다.
'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { join, resolve, dirname } = require('node:path');
const { stats, comparable } = require('./run.cjs');

const root = resolve(__dirname, '../../..');
const date = '2026-11-16';
const output = join(root, 'docs/benchmarks', date);
const filename = `JsonlAlgorithmsAB-${date}`;
const names = {
  'full-sha256': 'SHA-256 전체 파싱',
  'full-xxh128': 'XXH3-128 전체 파싱',
  'full-blake3': 'BLAKE3 전체 파싱',
  'sha256-checkpoint': 'SHA-256 검증·재개',
  'xxh128-checkpoint': 'XXH3-128 검증·재개',
  'blake3-checkpoint': 'BLAKE3 검증·재개',
  'block-fixed': '고정 블록 XXH3-128',
  'block-rolling': 'Rolling + XXH3-128',
  'block-merkle': 'Merkle + XXH3-128',
  'block-rolling-merkle': 'Rolling + Merkle + XXH3-128',
  'fingerprint-tail': '앞 1KiB 식별·재개 †',
};
const scenarios = {
  'codex-append': '새 요청 추가',
  'codex-update-existing': '기존 요청의 사용량 갱신',
};
const fixed = (value, digits = 2) => value.toFixed(digits);
const mb = value => fixed(value / 1e6);
const sha = value => createHash('sha256').update(value).digest('hex');

function readReport() {
  const input = resolve(process.argv[2] || join(output, filename + '.json'));
  const isFile = fs.statSync(input).isFile();
  const report = JSON.parse(fs.readFileSync(isFile ? input : join(input, 'results.private.json'), 'utf8'));
  if (report.hashMicro) return report;
  const workspace = isFile ? dirname(input) : input;
  if (!report.finishedAt) throw new Error('The measurement has not finished');
  for (const dataset of report.datasets) {
    const config = JSON.parse(fs.readFileSync(join(workspace, dataset.name, 'config.private.json'), 'utf8'));
    dataset.appendTargets = Object.fromEntries(Object.entries(config.targets).map(([label, target]) =>
      [label, { provider: target.provider, storedBytes: target.originalBytes, existingSessionRequests: target.requests }]));
    const expected = new Map(dataset.samples.filter(row => row.variant === 'full-sha256')
      .map(row => [row.scenario, JSON.stringify(comparable(row))]));
    const conditional = dataset.samples.filter(row => row.variant === 'fingerprint-tail' && row.scenario.startsWith('middle-'));
    dataset.conditionalFingerprintCases = { samples: conditional.length,
      differedFromFullParsing: conditional.filter(row => JSON.stringify(comparable(row)) !== expected.get(row.scenario)).length };
  }
  const microPath = resolve(process.argv[3] || join(root, 'tests/.cache/jsonl-algorithms-hash-micro-2026-11-16.json'));
  const usnPath = resolve(process.argv[4] || join(root, 'tests/.cache/jsonl-usn-129e91c819f94f37bde73ad516176121/usn.private.json'));
  const result = { ...report,
    hashMicro: JSON.parse(fs.readFileSync(microPath, 'utf8')),
    usn: JSON.parse(fs.readFileSync(usnPath, 'utf8').replace(/^\uFEFF/, '')),
    protocol: { ...report.protocol, blockBytes: 65536, fingerprintBytes: 1024 },
    measurementFiles: ['run.cjs', 'preparation.cjs', 'block-validation.cjs', 'correctness.cjs', 'hashers.cjs']
      .map(name => ({ path: `tests/benchmarks/jsonl-algorithms/${name}`, sha256: sha(fs.readFileSync(join(__dirname, name))) })),
    limitations: [
      'In-memory immutable checkpoints are measured. Persistence and restart restoration are unmeasured.',
      'Block candidates share one index containing blocks, rolling lookup and Merkle levels.',
      'Block validators also calculate the full XXH3-128 fingerprint in the same physical read.',
      'Middle modifications fall back to full parsing. Matched-block DTO reuse is unimplemented.',
      'Fingerprint tail is conditional on append-only input and misses four explicit rewrite counterexamples.',
      'All file preparation uses sourceWorkers=1.',
      'RSS is sampled process memory including runtime and allocator retention.',
      'USN timing is unavailable with the existing process token. OS cache and background load are uncontrolled.',
    ],
  };
  fs.mkdirSync(output, { recursive: true });
  const publishedPath = join(output, filename + '.json');
  if (fs.existsSync(publishedPath)) {
    const previous = JSON.parse(fs.readFileSync(publishedPath, 'utf8'));
    result.previousMeasurements = previous.previousMeasurements ?? [];
    if (previous.finishedAt !== result.finishedAt) {
      const { previousMeasurements: _history, ...archived } = previous;
      result.previousMeasurements.push(archived);
    }
  }
  fs.writeFileSync(publishedPath, JSON.stringify(result, null, 2) + '\n');
  return result;
}

function stageBreakdown(sample) {
  const phase = (...keys) => keys.reduce((sum, name) => sum + (sample.scan[name]?.totalMs ?? 0), 0);
  const discovery = phase('discover', 'names');
  const validation = sample.metrics.validationMs ?? 0;
  const preparation = phase('readSources') - validation;
  const aggregation = phase('resolveParents', 'reconnect', 'aggregate');
  const persistence = phase('commitComponents', 'finishScan', 'optimize');
  const other = sample.elapsedMs - discovery - validation - preparation - aggregation - persistence;
  if (preparation < -0.00001 || other < -0.00001) throw new Error('Overlapping stage durations');
  return { discovery, validation, preparation, aggregation, persistence, other, total: sample.elapsedMs };
}

function validationSpace(variant) {
  if (variant.startsWith('full-')) return '—';
  if (variant === 'block-fixed' || variant === 'block-rolling') return 'O(B)';
  if (variant.startsWith('block-')) return 'O(M+B)';
  if (variant === 'blake3-checkpoint') return 'O(H)';
  return 'O(1)';
}

function peakSpace(variant) {
  if (variant.startsWith('block-')) return 'O(P+C+M+B)';
  if (variant === 'full-blake3') return 'O(P+H)';
  if (variant === 'blake3-checkpoint') return 'O(P+C+H)';
  if (variant.startsWith('full-')) return 'O(P)';
  return 'O(P+C)';
}

function unifiedTable(dataset, selectedScenarios) {
  const lines = [
    '| 알고리즘 | 작업 | 탐색·이름<br>O(F) | 검증 시간 / 공간 | 상태준비·읽기·파싱<br>O(S+L+W) | 병합·정렬<br>O(S) | DB 저장·종료<br>O(S+Q) | 기타<br>O(1) | 최종 시간 | 개선율 %<br>전체 / 원본준비 | 최고 RSS / 최고 힙 MB | 피크 공간복잡도 | 캐시 직렬화 MB |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |',
  ];
  for (const [variant, name] of Object.entries(names)) {
    for (const scenario of selectedScenarios) {
      const samples = dataset.samples.filter(row => row.measured && row.variant === variant && row.scenario === scenario);
      if (!samples.length) continue;
      const stages = samples.map(stageBreakdown);
      const time = field => fixed(stats(stages.map(row => row[field])).median);
      const baseline = dataset.samples.filter(row => row.measured && row.variant === 'full-sha256' && row.scenario === scenario);
      const baseTotal = stats(baseline.map(row => row.elapsedMs)).median;
      const baseSource = stats(baseline.map(row => row.scan.readSources?.totalMs ?? 0)).median;
      const currentSource = stats(samples.map(row => row.scan.readSources?.totalMs ?? 0)).median;
      const totalImprovement = baseTotal ? fixed((1 - stats(stages.map(row => row.total)).median / baseTotal) * 100, 1) : 'N/A';
      const sourceImprovement = baseSource ? fixed((1 - currentSource / baseSource) * 100, 1) : 'N/A';
      const initial = dataset.initialization.find(row => row.variant === variant);
      const cacheBytes = initial.cache.serializedBytes + initial.cache.indexSerializedBytes;
      const peakRss = Math.max(...samples.map(row => row.observedPeak.rss));
      const peakHeap = Math.max(...samples.map(row => row.observedPeak.heapUsed));
      const preparation = variant === 'full-blake3' ? `${time('preparation')} (+H 공간)` : time('preparation');
      const task = scenario === 'codex-append' ? '새 요청 +1' : '기존 요청 갱신';
      lines.push(`| ${name} | ${task} | ${time('discovery')} | ${time('validation')} / ${validationSpace(variant)} | ${preparation} | ${time('aggregation')} | ${time('persistence')} | ${time('other')} | **${time('total')}** | **${totalImprovement} / ${sourceImprovement}** | **${mb(peakRss)} / ${mb(peakHeap)}** | ${peakSpace(variant)} | ${mb(cacheBytes)} |`);
    }
  }
  lines.push('| USN 저널·재개 | 두 작업 | 미측정 | 미측정 | 미측정 | 미측정 | 미측정 | 미측정 | 미측정 | 미측정 | 미측정 | 구현 기준 미산정 | 미측정 |');
  return lines;
}

function initialTable(report) {
  const lines = [
    '| 알고리즘 | 현재 최초 구축 ms | 현재 구축 후 GC 힙 MB | 10,000요청 최초 구축 ms | 10,000요청 구축 후 GC 힙 MB | 100요청 최초 구축 ms | 100요청 구축 후 GC 힙 MB |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const [variant, name] of Object.entries(names)) {
    const cells = report.datasets.flatMap(dataset => {
      const row = dataset.initialization.find(value => value.variant === variant);
      return [fixed(row.initializationMs), mb(row.retainedMemory.heapUsed)];
    });
    lines.push(`| ${name} | ${cells.join(' | ')} |`);
  }
  return lines;
}

function render(report) {
  const datasetNames = Object.fromEntries(report.datasets.map(dataset => [dataset.name,
    `${dataset.name === 'current' ? '현재 데이터' : '합성'} ${dataset.baseline.requests.toLocaleString('en-US')}요청`]));
  const current = report.datasets.find(dataset => dataset.name === 'current');
  const measured = (variant, scenario) => current.samples.filter(row => row.measured && row.variant === variant && row.scenario === scenario);
  const median = (samples, select) => stats(samples.map(select)).median;
  const notes = [
    '## 측정값과 공간 기호', '',
    '시간은 준비 3회 뒤 10회 측정의 중앙값이며 모두 ms다. RSS와 힙은 그 10회에서 각각 가장 높게 관측된 MB다. RAM 표본은 10ms 및 읽기·단계 경계에서 수집했으며 순간 최고값을 놓칠 수 있다. RSS에는 런타임·native 라이브러리·allocator가 보유한 메모리도 포함된다.', '',
    '공간 기호는 F = 탐색하는 파일·manifest·이름 metadata 항목, S = 이번 갱신에서 보유하는 원본별 winner·요청·관계 근거와 최종 결과 상태, C = 블록 인덱스를 제외한 갱신 간 파서·winner·관계 근거 체크포인트, L = 한 행의 작업 공간, Q = DB 측 작업 공간, W = Zstd decoder window다. 공통 공간을 **P = F+S+L+Q+W**로 두었다. M은 캐시의 전체 블록·트리 노드 수, B는 블록 버퍼 크기 64KiB, H는 BLAKE3의 논리적 트리 frontier 크기 O(log(입력 바이트/1024+1))다.', '',
    '구간별 추가 작업 공간은 탐색·이름 O(F), 상태준비·읽기·파싱 O(S+L+W), 병합·정렬 O(S), DB 저장·종료 O(S+Q), 기타 O(1)이다. C와 블록 인덱스는 갱신 도중 계속 상주하므로 최종 피크 식에 함께 들어간다. 고정 블록·rolling 검증은 기존 인덱스를 조회하며 O(B) 작업 버퍼를 추가하고, Merkle 검증은 현재 노드 O(M)을 추가로 구성한다. 전체 파싱의 BLAKE3는 읽기·파싱 구간에 H가 추가된다. S는 legacy 위치·서명·도구 위치 이력 때문에 최악에 이벤트 발생 수에 비례할 수 있다. 이론적 Big-O는 코드의 저장 구조에서 도출했다.', '',
    'P를 펼친 SHA-256 전체 파싱의 피크 식은 O(F+S+L+Q+W), SHA-256·XXH3 체크포인트는 O(F+S+L+Q+W+C), 블록 후보는 O(F+S+L+Q+W+C+M+B)다. 파일당 식별자·metadata 항목 크기를 고정한 모델이며 런타임의 고정 비용은 RSS 관측값에 포함된다.', '',
    '검증 칸은 해당 구간의 시간과 공간복잡도다. 전체 파싱 세 구성은 읽는 동안 해시를 계산해 상태준비·읽기·파싱 칸에 함께 포함한다. 이 칸은 원본 준비 전체 시간에서 별도 검증 시간을 뺀 값이며 상태 복제·파일 열기·JSON 해석·winner 갱신이 포함된다. 기타는 각 표본의 전체 시간에서 앞의 다섯 구간을 뺀 잔여 시간이다. 구간 중앙값의 합은 최종 시간 중앙값과 달라질 수 있다.', '',
    '최종 시간은 실제 refreshSummary 시작부터 COMMIT·마무리까지다. 사본 변경·DB 복원·GC·정합성 검사·조회는 이 시간 밖에서 수행했다. 캐시 직렬화 MB는 파서 상태와 블록 인덱스를 합쳐 v8.serialize로 표현한 크기이며 native 해시 상태를 제외한다. 최고 RSS와 최고 힙은 각각 관측한 최고값으로 서로 다른 시점일 수 있다.', '',
  ];
  const lines = [
    '# JSONL 알고리즘별 새 요청 추가·기존 요청 갱신 실측', '',
    '**각 알고리즘의 두 작업을 연속된 행으로 배치하고, 구간별 시간·공간복잡도·최종 시간·개선율·피크 메모리를 한 표에 함께 표시했다.** 현재 1,424·합성 10,000·100요청의 동일한 기준 상태에서 두 작업을 새로 계측했다.', '',
    '- **새 요청 추가**는 새 요청·응답 ID의 기록 4행을 추가해 요청 수 +1, 총 토큰 +130이 된다.',
    '- **기존 요청 갱신**은 집계에 포함된 기존 요청·응답 ID를 유지한 사용량 기록 1행을 추가한다. 해당 응답의 입력 토큰 +123·출력 토큰 +7로, 요청 수는 유지되고 총 토큰만 +130이 된다. 기존 turn 검산 값이 있으면 같은 기록에서 함께 갱신한다.',
    '',
    '두 경우 모두 기존 JSONL 뒤에 기록을 추가한다. 두 번째 경우의 최종 집계는 기존 응답의 기여를 최신 사용량으로 교체한다. 각 표본에서 같은 원본·DB·메모리 체크포인트 기준으로 되돌린 뒤 계측했다.', '',
    '**시간은 준비 3회 후 10회 중앙값 ms, 피크는 10회 중 최고 관측값 MB**다. 개선율은 같은 작업의 SHA-256 전체 파싱 대비 감소율이며 양수는 개선, 음수는 증가다. 원본준비 개선율은 검증·상태 복제·읽기·파싱을 합친 구간을 비교한다. 표 머리의 O(...)는 해당 구간의 추가 작업 공간이다. P·C·M·B·H의 정의는 표 아래에 적었다.', '',
  ];
  for (const dataset of report.datasets) {
    const target = dataset.appendTargets.codex;
    const addition = dataset.scenarios.find(row => row.name === 'codex-append');
    const update = dataset.scenarios.find(row => row.name === 'codex-update-existing');
    lines.push(`## ${datasetNames[dataset.name]}에서 두 작업 비교`, '',
      `대상 Codex 파일은 ${target.storedBytes.toLocaleString('en-US')}바이트, 대상 세션은 ${target.existingSessionRequests}요청이다. 새 요청은 ${addition.addedBytes}바이트, 기존 요청 갱신은 ${update.addedBytes}바이트를 추가했다. 전자는 전체 요청 수 ${dataset.baseline.requests} → ${dataset.baseline.requests + 1}, 후자는 ${dataset.baseline.requests} → ${dataset.baseline.requests}이며 토큰 증가량은 둘 다 130이다. W는 이 일반 JSONL 경로에서 0이다.`, '',
      ...unifiedTable(dataset, Object.keys(scenarios)), '');
  }
  lines.push('† 앞 1KiB 식별·재개는 추가 전용 조건의 후보다. 별도 중간 수정 반례 4건에서 전체 파싱과 결과가 달랐다.', '', ...notes,
    '체크포인트 후보는 기준 상태를 메모리에 보관한 시제품이다. 블록 네 구성은 weak·strong·위치 lookup·Merkle level 인덱스를 함께 보관하며 같은 읽기에서 전체 XXH3-128도 계산한다. 중간 변경을 발견하면 전체 파싱으로 복구한다. 블록별 DTO 재사용과 디스크 체크포인트 저장·재시작 복원은 미측정이다.', '',
    '<details>', '<summary>최초 구축 비용과 구축 후 상주 힙</summary>', '',
    '각 구성에서 최초 전체 파싱·캐시 구축을 한 번 관측한 값이다. 표의 구축 후 GC 힙은 메모리가 회수된 뒤 상주 상태를 보여 준다. 최초 구축 중 피크는 기존 실행기에서 측정하지 않아 수치를 채우지 않았다.', '',
    ...initialTable(report), '', '</details>', '', '## 해석과 확인 범위', '');
  for (const [scenario, label] of Object.entries(scenarios)) {
    const original = measured('full-sha256', scenario);
    const checkpoint = measured('sha256-checkpoint', scenario);
    const before = median(original, row => row.elapsedMs);
    const after = median(checkpoint, row => row.elapsedMs);
    lines.push(`현재 ${label}에서 SHA-256 전체 파싱 → SHA-256 검증·재개의 전체 갱신은 **${fixed(before)} → ${fixed(after)}ms, ${fixed((1 - after / before) * 100, 1)}% 감소**다. 원본준비는 ${fixed(median(original, row => row.scan.readSources.totalMs))} → ${fixed(median(checkpoint, row => row.scan.readSources.totalMs))}ms, 파싱 행 수는 ${median(original, row => row.metrics.parsedRows).toLocaleString('en-US')} → ${median(checkpoint, row => row.metrics.parsedRows).toLocaleString('en-US')}행이다.`, '');
  }
  lines.push('기존 요청 갱신도 파서·winner 상태를 복원한 뒤 마지막 사용량 기록만 해석할 수 있다. 현재 구현에서는 변경된 세션의 병합과 DB 비교·저장은 계속 수행한다. 파일·이름 탐색도 두 작업에 공통으로 남으므로 파싱 구간 개선율과 전체 개선율이 다르다. 작은 파일은 전체 파싱 비용이 작아 체크포인트 복제·검증 비용과 함께 판단해야 한다.', '',
    '합성 10,000요청은 여러 파일에 나뉘어 변경 대상이 약 66KB이고, 현재 데이터의 변경 대상은 약 8.12MB다. 따라서 총 요청 수가 더 많아도 이번 재개 기법의 이득이 더 클 필요는 없다. 세 입력은 요청 밀도·대상 파일 크기가 함께 달라지므로 규모 숫자만으로 증가 추세를 추정할 수 없다.', '',
    '이론적으로 기존 파일 N바이트·추가분 Δ바이트에서 전체 해시·전체 파싱은 O(N+Δ) 읽기와 해석을 수행한다. 전체 prefix를 검증하는 체크포인트는 검증 O(N+Δ), 상태 복제 O(C), 추가분 파싱 O(Δ)다. 고정 블록은 O(N+Δ), Merkle은 모든 잎을 다시 읽어야 하므로 O(N+Δ+M)이다. Rolling은 검사 창 수 A와 strong 비교한 바이트 합 K에 대해 O(N+Δ+A+K)이며 weak checksum 갱신만 창당 O(1)이다. 이번 추가 조건에서는 대부분 같은 위치의 블록과 맞고, 임의 수정의 weak 충돌이 많으면 K가 커질 수 있다. 앞 1KiB 후보의 검사는 O(1), 상태 복제·추가분 처리는 O(C+Δ)이지만 중간 변경을 보장하지 못한다. 파일 내용 변경 위치를 알려 주는 별도 근거가 없으면 Merkle tree만으로 임의 수정 검사를 O(log N)로 줄일 수 없다.', '',
    `총 ${report.datasets.reduce((sum, dataset) => sum + dataset.samples.filter(row => row.measured).length, 0)}개 본 측정 표본에서 요청 수·토큰 증가량과 전체 파싱 대비 결과를 대조했다. ` +
    `필수 정합성 ${report.correctness.requiredPassed}/${report.correctness.requiredCases}건이 통과했다. 성능 표본의 필수 후보는 요청 facts와 일·월·세션·프로젝트 집계가 전체 파싱과 일치했다. 합성 입력의 요청·토큰 합계는 생성 산식과 대조했고 그룹 수·토큰 합계·완료 요청 평균은 별도 JS 합산과 대조했다.`, '',
    'USN은 현재 NTFS 볼륨에서 GENERIC_READ 열기가 Win32 5로 거부됐고 metadata-only handle의 저널 조회는 Win32 1을 반환했다. 구간 시간·최종 시간·피크 RAM은 미측정이다. USN의 이론적 추가 상태는 관심 파일 ID 맵과 읽기 버퍼지만, 이 환경에서 성능값을 도출할 자료가 없다.', '',
    `측정 환경은 ${report.environment.node}·OpenSSL ${report.environment.openssl}·Windows x64·${report.environment.cpu.trim()}다. 파일 준비는 sourceWorkers=1로 고정했고 한 번에 후보 프로세스 하나를 실행했다. 정방향·역방향 순서를 교대했고 OS 캐시가 예열된 조건이다. 백그라운드 부하와 OS 캐시 상태는 통제하지 않았다.`, '',
    '| 입력 | 파일 수 | 저장 MB | Zstd 파일 수 | 기준 요청 수 | 기준 토큰 합계 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const dataset of report.datasets) lines.push(`| ${datasetNames[dataset.name]} | ${dataset.inventory.reduce((sum, row) => sum + row.files, 0)} | ${mb(dataset.inventory.reduce((sum, row) => sum + row.bytes, 0))} | ${dataset.inventory.reduce((sum, row) => sum + row.compressed, 0)} | ${dataset.baseline.requests} | ${dataset.baseline.tokens} |`);
  lines.push('', '실제 로그는 관측 크기까지 복사한 고정 사본이다. 합성 데이터는 제공자별 절반·프로젝트 10개·2026년 7월의 고정 날짜 산식을 사용한다. 합성 10,000요청은 세션당 100요청, 100요청은 세션당 10요청이다.', '',
    `원시 표본·구간 타이머·평균 조회·순수 해시 계측·메모리·코드 및 입력 해시는 [${filename}.json](${filename}.json)에 보존했다. 이번 두 작업의 결과는 최상위 datasets에, 앞선 압축·중간 수정·무변경 측정은 previousMeasurements에 원래 표본과 함께 보존했다. 실행 방법은 [벤치마크 실행기](../../../tests/benchmarks/jsonl-algorithms/README.md)에 있다.`, '',
    '구간의 코드 근거는 [원본 준비](../../../tests/benchmarks/jsonl-algorithms/preparation.cjs), [블록 검사](../../../tests/benchmarks/jsonl-algorithms/block-validation.cjs), [갱신 조율](../../../src/summary/scanner/refresh/index.ts), [원본별 상태](../../../src/summary/aggregation/sourceWinners.ts), [최종 병합](../../../src/summary/aggregation/memoryAggregate.ts), [DB 저장](../../../src/summary/db/memoryStore/index.ts)에서 확인할 수 있다.', '',
    '[XXH3 명세](https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash_spec.md), [BLAKE3 명세](https://c2sp.org/BLAKE3), [rsync rolling 탐색](https://rsync.samba.org/tech_report/node4.html), [Merkle tree](https://www.rfc-editor.org/rfc/rfc9162.html#section-2.1), [Filebeat 파일 식별](https://www.elastic.co/docs/reference/beats/filebeat/file-identity), [USN 변경 기록](https://learn.microsoft.com/en-us/windows/win32/fileio/change-journal-records), [Zstd 프레임](https://www.rfc-editor.org/rfc/rfc8878.html#section-3.1).', '');
  return lines.join('\n');
}

function main() {
  const report = readReport();
  const markdown = render(report);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(join(output, filename + '.md'), markdown);
  console.log(JSON.stringify({ markdown: join(output, filename + '.md'), inputDatasets: report.datasets.length }));
}

if (require.main === module) main();
module.exports = { stageBreakdown, render };
