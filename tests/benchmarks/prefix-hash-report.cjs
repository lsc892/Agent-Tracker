// 공개 원시 표본에서 갱신·평균 조회·메모리·해시와 복잡도 보고서를 재생성한다.
'use strict';
const fs = require('node:fs');
const { join, dirname, basename, resolve } = require('node:path');
const path = resolve(process.argv[2] || 'docs/benchmarks/2026-11-19/PrefixHashAB-2026-11-19.json');
const report = JSON.parse(fs.readFileSync(path, 'utf8'));
const assert = require('node:assert/strict');
const microPath = process.argv[3];
const threadsPath = process.argv[4];
const longPath = process.argv[5];
const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2; };
const samples = (dataset, variant, scenario = 'append') => dataset.results[variant].samples.filter(row => row.measured && row.scenario === scenario);
const med = (dataset, variant, scenario, field) => median(samples(dataset, variant, scenario).map(field));
const time = (dataset, variant, scenario) => med(dataset, variant, scenario, row => row.elapsedMs);
const f = value => value.toFixed(3);
const mib = value => (value / 1024 / 1024).toFixed(2);
const change = (a, b) => ((a - b) / a * 100).toFixed(1) + '%';
const variants = ['A', 'sha256', 'blake3', 'xxh128'];
const names = { A: '기존 manifest', sha256: 'SHA-256', blake3: 'BLAKE3', xxh128: 'XXH3-128', threads4: 'SHA-256 / 4 Worker' };
const scenarios = { append: '새 요청 +1', 'update-existing': '기존 응답 +130토큰', unchanged: '내용·mtime 모두 무변경', 'same-content-touch': '동일 내용·mtime만 변경', 'middle-rewrite': '같은 크기·mtime 중간 수정', 'middle-insert': '중간 삽입' };
for (const dataset of report.datasets) if (dataset.expected) for (const variant of variants) for (const sample of samples(dataset, variant)) {
  assert.equal(sample.totals.requests, dataset.expected.requests + 1);
  assert.equal(sample.totals.tokens, dataset.expected.tokens + 130);
}
if (microPath) report.hashMicro = JSON.parse(fs.readFileSync(microPath, 'utf8'));
if (threadsPath) report.threadComparison = JSON.parse(fs.readFileSync(threadsPath, 'utf8'));
if (longPath) report.longComparison = JSON.parse(fs.readFileSync(longPath, 'utf8'));
for (const dataset of [...(report.threadComparison?.datasets ?? []), ...(report.longComparison?.datasets ?? [])])
  if (dataset.expected) for (const variant of Object.keys(dataset.results)) for (const sample of samples(dataset, variant)) {
    assert.equal(sample.totals.requests, dataset.expected.requests + 1);
    assert.equal(sample.totals.tokens, dataset.expected.tokens + 130);
  }
const lines = [
  '# 완성 줄 위치·원본 prefix 해시 증분 A/B 테스트', '',
  '가정: 사용자는 manifest 판정을 제거하고 P·원본 [0,P) 해시 검증 뒤 append 부분만 파싱하면 알고리즘·시간·공간을 줄일 수 있다고 제안했다. Codex는 파싱 절감과 전체 prefix 재읽기·상태 보관 비용을 구분해 검증했다.', '',
  'A는 수정 전 소스·빌드 사본의 manifest 크기/mtime 판정과 변경 파일 전체 파싱이다. B는 실제 제품에 구현한 완성 줄 경계·해시 검증·파서/winner 재개다. 해시 공급자만 SHA-256 / BLAKE3 / XXH3-128로 바꾼다. 제품 기본값은 플랫폼별 native 바이너리와 추가 배포 의존성이 없는 Node 내장 SHA-256이다. 두 native 해시는 Git 제외 캐시의 벤치마크 의존성으로 비교했다.', '',
  '## 1. 전체 갱신 결과', '',
  '중앙값 ms. 괄호는 A 대비 개선율 `(A-B)/A×100`이며 음수는 악화다. 데이터 준비·원본 복원·GC·검증·조회는 갱신 시간에서 제외하고 실제 refreshSummary의 COMMIT·풀 종료까지 포함한다.', '',
  '| 입력 | 작업 | A ms | SHA-256 ms | BLAKE3 ms | XXH3-128 ms | 파싱 줄 A → B | 읽은 MiB A → B |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
];
for (const dataset of report.datasets) for (const scenario of Object.keys(scenarios)) {
  const a = time(dataset, 'A', scenario);
  const cells = variants.slice(1).map(variant => { const b = time(dataset, variant, scenario); return `${f(b)} (${change(a, b)})`; });
  lines.push(`| ${dataset.name} | ${scenarios[scenario]} | ${f(a)} | ${cells.join(' | ')} | ${med(dataset, 'A', scenario, row => row.parsedRows)} → ${med(dataset, 'sha256', scenario, row => row.parsedRows)} | ${mib(med(dataset, 'A', scenario, row => row.bytes))} → ${mib(med(dataset, 'sha256', scenario, row => row.bytes))} |`);
}
lines.push('', '현재 로그에서는 변경 세션의 관련 원본만 읽던 A보다 전체 prefix를 검사하는 B의 읽기량이 크다. A의 파싱 줄 수에는 변경 없는 형제 원본도 포함된다. B의 중간 변경은 해당 파일을 전체 파싱하고 형제 원본은 prefix 검증 뒤 캐시를 재사용하므로 파싱 줄 수가 더 적을 수 있다. append 파싱 줄 감소가 전체 갱신 시간 감소를 뜻하지 않는다. 세 해시의 O 표기는 같고 실제 차이는 해시 처리량·native 호출·파일 I/O 비용이다.', '',
  '새 요청 추가의 표본 범위(min–max ms):', '',
  '| 입력 | A | SHA-256 | BLAKE3 | XXH3-128 |', '| --- | ---: | ---: | ---: | ---: |');
for (const dataset of report.datasets) lines.push(`| ${dataset.name} | ` + variants.map(variant => {
  const values = samples(dataset, variant).map(row => row.elapsedMs); return `${f(Math.min(...values))}–${f(Math.max(...values))}`;
}).join(' | ') + ' |');
lines.push('',
  '## 2. 일·월·세션·프로젝트 평균 토큰 조회', '',
  '새 요청 추가 뒤 실제 제품 API의 전체 결과 반환까지 측정했다. 각 셀은 A → 제품 SHA-256 B 중앙값 ms다. 평균은 제품의 완료 요청 표본·빈 사용량 설정을 유지하며, JS 독립 집계로 요청 수·토큰·완료 표본과 그룹별 평균을 대조했다.', '',
  '| 조회 | ' + report.datasets.map(dataset => dataset.name).join(' | ') + ' |',
  '| --- | ' + report.datasets.map(() => '---:').join(' | ') + ' |');
for (const [group, label] of [['day', '일별'], ['month', '월별'], ['session', '세션별'], ['project', '프로젝트별']]) {
  lines.push(`| ${label} | ` + report.datasets.map(dataset => `${f(med(dataset, 'A', 'append', row => row.queries[group].ms))} → ${f(med(dataset, 'sha256', 'append', row => row.queries[group].ms))}`).join(' | ') + ' |');
}
lines.push('', '## 3. 보관 공간과 관측 메모리', '',
  '| 입력 | 구성 | GC 뒤 시작 RSS 중앙값 MiB | append 관측 최고 RSS MiB | 최고 주 스레드 heap MiB | 최고 external MiB | 파서 캐시 직렬화 MiB |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: |');
for (const dataset of report.datasets) for (const variant of variants) {
  const rows = samples(dataset, variant);
  lines.push(`| ${dataset.name} | ${names[variant]} | ${mib(median(rows.map(row => row.memoryBefore.rss)))} | ${mib(Math.max(...rows.map(row => row.peak.rss)))} | ${mib(Math.max(...rows.map(row => row.peak.heapUsed)))} | ${mib(Math.max(...rows.map(row => row.peak.external)))} | ${mib(median(rows.map(row => row.cacheSerializedBytes)))} |`);
}
lines.push('', '메모리는 구성별 별도 프로세스에서 5ms 타이머·갱신 종료에 관측했다. 동기 파싱 중 순간 피크는 놓칠 수 있다. RSS는 런타임·SQLite·native 메모리와 Worker를 포함하고 heap/external은 호출한 주 스레드 관측값이다. v8.serialize 크기는 RAM 사용량이 아니며 직렬화는 측정 밖에서 수행한다. A는 갱신 간 파서 캐시가 없으므로 이 열이 0이다. DB 파일 크기의 직접 A/B는 미측정이며 새 P/해시 열과 캐시 비용을 RSS·직렬화·이론 공간으로 구분한다.', '',
  '## 4. 시간·공간복잡도', '',
  'F는 파일 수, N은 현재 전체 원본 byte, P는 파일별 이전 완성 줄 경계, D=N-P는 tail byte, R은 보관 요청/응답·계보 근거 수다. C=64KiB, L은 줄 보관 예산(기본 4MiB), W≤4는 파일 준비 Worker 수다. A(Rₐ,F)는 기존 영향 세션 병합·정렬·SQL 비교/rollup 비용이다.', '',
  '| 단계 | SHA-256 | BLAKE3 | XXH3-128 |',
  '| --- | --- | --- | --- |',
  '| `[0,P)` 전체 검증 시간 | Θ(P) | Θ(P) | Θ(P) |',
  '| 일치한 tail 파싱 | Θ(D), 기존 파서 상태 재사용 | 동일 | 동일 |',
  '| prefix 변경 후 복구 | O(P+N) 읽기·해시 + Θ(N) 파싱 | 동일 | 동일 |',
  '| 해시 내부 보조 공간 | O(1) | 이론 O(log(N/1024)) CV stack, 지원 파일 길이에서 제한됨 | O(1) |',
  '| 저장 digest 폭 | 256bit / 32byte | 기본 256bit / 32byte | 128bit / 16byte |',
  '| P를 8byte로 잡은 원시 검증 payload | 파일당 40byte | 파일당 40byte | 파일당 24byte |',
  '| 구현의 SQLite hex 문자열 | 해시 64문자 + INTEGER | 해시 64문자 + INTEGER | 실험 해시 32문자 + INTEGER |', '',
  '원시 검증 payload는 P·해시만 센 값이며 경로·진단·문자열/객체·SQLite 행·파서/winner 캐시를 포함하지 않는다.', '',
  '- 매번 모든 파일을 검사하므로 새 방식의 갱신은 O(F log F + ΣN + A(Rₐ,F))다. append의 **파싱**만 O(ΣD)로 줄며 전체 갱신을 O(D)라고 할 수 없다. A의 무변경 판정은 본문 없이 파일 목록/stat O(F), 정렬·DB bookkeeping을 포함하면 그 기존 비용이 더해진다.',
  '- 리더 보조 공간은 O(C+L), 검증 메타데이터는 O(F)다. 파서 문맥·winner 캐시를 포함한 전체 공간은 O(F+R+C+L)이며 영향 세션의 출력·병합 상태도 추가된다. 이전 구현보다 갱신 간 유지 공간이 증가한다.',
  '- P와 해시만으로 누계·응답 중복·미완료 turn·부모/fork 관계를 복원할 수 없다. 따라서 원문/전체 이벤트 대신 최소한의 기존 파서 문맥과 요청별 winner/관계 근거를 보관한다. 캐시가 없으면 전체 파싱한다.',
  '- 스레드는 총 작업 차수를 줄이지 않는다. 파일별 검증/파싱을 병렬화할 수 있지만 I/O·직렬 병합/DB·Worker 시작과 상태 복사 비용이 남는다. SHA/XXH 스트림의 조각 해시를 단순 결합해 같은 원본 해시를 만들 수 없다. BLAKE3는 내부 tree의 병렬성을 지원하지만 이번 native streaming 공급자가 단일 파일에 여러 Worker를 쓰는 것으로 측정하지 않았다.', '',
  '파일 Worker는 체크포인트를 structured clone으로 전달하므로 해당 파일의 보관 상태 수 R_transfer에 비례한 복사 작업이 추가된다. 병렬 경로의 총 작업은 O(N + R_transfer + F log F + A)로 보며, 동시 Worker가 늘면 상수 메모리와 복사본 비용도 증가한다.', '',
  '## 5. 정합성과 적용 범위', '',
  '- 새 요청은 +1요청/+130토큰, 기존 응답 갱신은 요청 수 유지/+130토큰을 검증한다. 모든 구성·표본에서 요청 facts·모델·도구·비용의 정규화 digest와 네 집계 결과가 A와 일치해야 성공한다. 각 조회는 JS 독립 합계/평균 oracle, 모든 표본은 FK/integrity 검사를 수행했다.',
  '- 정규화는 물리 ID·갱신 시각·진단 파일 ID를 제외하고 비정수를 유효숫자 10자리로 맞춘다. 정수 토큰·요청 수·평균 표본 수와 그룹 구성은 유지한다.',
  '- 중간 수정은 같은 크기·mtime으로 구성한다. A에는 재파싱 표시를 줘 전체 파싱 oracle로 사용한다. 기존 A의 자동 metadata 판정은 이 변경을 놓칠 수 있으며 이 별도 동작은 새 회귀 테스트가 검증한다. 중간 삽입은 전체 파싱 결과와 대조한다.',
  '- 회귀 테스트는 원본 UTF-8·CRLF·큰 이미지·미완성 줄, prefix 변경/삽입/축소, 실패 상태 폐기/복구, 파일 Worker에서 체크포인트 재개, 이전 manifest DB 이관과 DB 재시작을 확인한다. 기존 동점 winner 순서·취소·실패 보존·삭제/이동·fork 테스트도 유지한다.',
  '- native 두 공급자의 제품 경로 대조는 이 보고서의 변경 시나리오와 해시 벡터 범위다. 삭제·이동·fork·오류 등 전체 회귀 suite는 기본 SHA-256 제품으로 수행했다. native 해시와 파일 Worker 병렬화의 조합은 측정하지 않았다.',
  '- 유한 길이 해시에는 충돌이 있으므로 해시 일치가 수학적인 byte 동일성 증명은 아니다. SHA-256/BLAKE3는 암호학적 해시이며 XXH3는 비암호학적 해시다. XXH3의 128bit를 공격 저항으로 해석하지 않는다. 모든 비교는 갱신 사이 안정된 파일을 전제하며, 동시 writer의 악의적인 내용 변경·mtime 복원에 대한 원자적 파일 스냅샷을 제공하지 않는다.',
  '- 제품은 SHA-256 prefix 검사와 원본·진단용 source_file 목록을 사용한다. manifest 테이블/모듈/metadata 변경 판정은 제거했다. 파일 ID·진단·소실 보존을 위한 목록은 필요하므로 남긴다. 파서/winner 캐시는 메모리에만 유지하고 DB 재시작 첫 갱신과 Zstd 파일은 전체 파싱한다. 압축 파일의 tail 재개는 이번 적용 범위 밖이다.', '',
  '## 6. 조건과 재현', '',
  `환경: ${report.environment.node}, ${report.environment.platform}, ${report.environment.cpu}. 각 입력·작업에 준비 3회 뒤 정방향/역방향 구성을 교대해 각 10회 측정한다. 동시에 한 자식 프로세스만 작업하며 OS 파일 캐시는 비우지 않는다. 시간대 Asia/Seoul, 고정 조회 기간 2020-01-01~2035-01-01(UTC 경계), 미상 시각 포함·빈 사용량 포함이다.`, '',
  '| 입력 | 요청 수 | 파일 수 | 원본 MiB |', '| --- | ---: | ---: | ---: |');
for (const dataset of report.datasets) lines.push(`| ${dataset.name} | ${samples(dataset, 'A')[0].totals.requests - 1} | ${dataset.inventory.reduce((n, item) => n + item.files, 0)} | ${mib(dataset.inventory.reduce((n, item) => n + item.bytes, 0))} |`);
lines.push('', '현재 입력은 읽기 전용 원본에서 만든 고정 사본이며 인증 파일·원본 DB를 수정하지 않는다. 합성 입력은 고정 순번으로 Claude/Codex를 절반씩 생성하고 세션당 100요청(100건 입력은 10요청), 프로젝트를 세션 순번 mod 10으로 분포시키며 세션 날짜와 100요청 경계를 이동한다. 실제 요청 수·파일 수·토큰 합계는 원시 결과에 남긴다. 원본 snapshot의 SHA-256은 실험 종료 뒤 다시 확인한다. UI/확장 IPC 응답성과 실제 quota는 이 측정에 포함하지 않는다.', '',
  '```powershell',
  'npm install --prefix tests/.cache/jsonl-algorithms-deps --no-audit --no-fund --save-exact xxhash-addon@2.1.0 @napi-rs/blake-hash@1.4.0',
  'node tests/benchmarks/prefix-hash-ab.cjs --before=<빌드된 수정 전 소스> --after=<빌드된 현재 소스> --prepare-only',
  'node tests/benchmarks/prefix-hash-ab.cjs --workspace=<출력된 비공개 workspace> --output=<새 결과 JSON>',
  'node tests/benchmarks/jsonl-algorithms/hash-micro.cjs --output=<새 순수 해시 JSON>',
  'node tests/benchmarks/prefix-hash-report.cjs <결과 JSON> <순수 해시 JSON> <Worker 비교 JSON> <긴 세션 JSON>',
  '```', '',
  `원시 표본·소스/빌드/입력 SHA-256·해시 검증: [${basename(path)}](${basename(path)}). 원본·개인 경로·세션 ID·프롬프트·응답·credential은 공개 결과에 포함하지 않는다.`, '');
if (report.hashMicro) {
  lines.push('## 7. 순수 해시 CPU 비용', '', '동일한 64KiB hot buffer를 반복 공급한다. 파일 I/O·JSON 파싱·DB·입력 준비를 포함하지 않는 별도 지표다. 구성별 별도 프로세스, 준비 3회·교대 10회.', '',
    '| byte 수 | SHA-256 ms | BLAKE3 ms | XXH3-128 ms |', '| ---: | ---: | ---: | ---: |');
  for (const bytes of report.hashMicro.sizes) lines.push(`| ${bytes} | ` + ['sha256', 'blake3', 'xxh128'].map(algorithm => f(report.hashMicro.summaries.find(row => row.algorithm === algorithm && row.bytes === bytes).medianMs)).join(' | ') + ' |');
}
if (report.threadComparison) {
  lines.push('', '## 8. 파일 준비 Worker 1개와 4개', '', '해시를 SHA-256으로 고정하고 실제 제품의 제한된 파일 준비 풀만 비교한다. 1개 경로도 제품에서는 통계 전용 Worker 안에서 실행한다. 아래 값은 전체 refresh 시간이며 확장 IPC는 제외한다. 여러 파일·1MiB 이상일 때만 중첩 파일 Worker를 시작하고, 작은 입력은 기존 순차 경로를 따른다.', '',
    '| 입력 | 작업 | Worker 1 ms | Worker 4 ms | 개선율 | 실제 추가 Worker 수 | 1 → 4 최고 RSS MiB |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const dataset of report.threadComparison.datasets) for (const scenario of ['append', 'same-content-touch', 'unchanged']) {
    const a = time(dataset, 'sha256', scenario), b = time(dataset, 'threads4', scenario);
    const rss = variant => Math.max(...samples(dataset, variant, scenario).map(row => row.peak.rss));
    lines.push(`| ${dataset.name} | ${scenarios[scenario]} | ${f(a)} | ${f(b)} | ${change(a, b)} | ${Math.max(...samples(dataset, 'threads4', scenario).map(row => row.fileWorkerPeak ?? 0))} | ${mib(rss('sha256'))} → ${mib(rss('threads4'))} |`);
  }
}
if (report.longComparison) {
  lines.push('', '## 9. 같은 10,000요청을 긴 세션 2파일에 배치', '',
    '요청 수를 유지하고 세션당 5,000요청·총 2파일로 묶어 파일 수/세션 밀도의 영향을 분리한다. 기본 10,000건은 세션당 100요청·100파일이다. 두 경우 모두 실제 제품의 갱신·COMMIT과 독립 평균 검증을 사용한다. 2파일 시나리오도 준비 3회·교대 10회이며 이 시나리오의 Worker 수는 1이다.', '',
    '| 배치 | 작업 | A ms | SHA-256 ms | BLAKE3 ms | XXH3-128 ms | 파싱 줄 A → B |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const dataset of [report.datasets.find(row => row.name === 'synthetic-10000'), ...report.longComparison.datasets]) for (const scenario of ['append', 'same-content-touch', 'unchanged']) {
    lines.push(`| ${dataset.name} | ${scenarios[scenario]} | ${variants.map(variant => f(time(dataset, variant, scenario))).join(' | ')} | ${med(dataset, 'A', scenario, row => row.parsedRows)} → ${med(dataset, 'sha256', scenario, row => row.parsedRows)} |`);
  }
}
lines.push('', '## 판단과 선택', '',
  'append 부분의 파싱 절감은 성립한다. 전체 prefix를 매번 읽는 비용과 파서 상태 보관 때문에 전체 갱신 가속·총 메모리 감소는 별도 문제이며, 현재 데이터의 결과가 나빠지면 개선으로 해석하지 않는다. XXH3-128의 순수 해시 속도 이점을 전체 제품의 같은 배수 개선으로 일반화하지 않는다. 요청한 내용 검증 동작을 구현하되 기본 제품은 배포 구조를 단순하게 유지하는 내장 SHA-256을 사용한다. BLAKE3/XXH3의 native 공급자를 제품에 포함하는 플랫폼별 패키징·호환성 검증은 수행하지 않았다.', '',
  '근거: [Node Hash.copy](https://nodejs.org/api/crypto.html#hashcopyoptions), [BLAKE3 공식 구현/병렬 구조](https://github.com/BLAKE3-team/BLAKE3), [BLAKE3 명세](https://github.com/BLAKE3-team/BLAKE3-specs), [XXH3 공식 구현/비암호학적 성격](https://github.com/Cyan4973/xxHash).', '');
if (report.finalVerification) lines.push(
  `최종 검증: 타입·린트·Node ${report.finalVerification.passed}/${report.finalVerification.nodeTests} 테스트 통과. 준비 표본 포함 ${report.finalVerification.totalSamples}개(본 표본 ${report.finalVerification.measuredSamples}개)의 facts·네 조회와 ${report.finalVerification.independentQueryChecks}개 독립 평균 대조를 통과했다.`, '',
  '측정은 고정한 빌드로 수행했다. 최종본과의 소스 차이는 구형 스키마 v1/v2/v3의 루트·세션 인덱스 복원이며, 측정한 일반 JSONL 해시·파싱·집계·warm 갱신 경로는 같다. 구형 DB 마이그레이션 시간은 미측정이다. 측정 빌드와 최종 검증 소스/빌드 식별자는 JSON에 각각 보존한다.', '',
  '동일 내용을 쓰고 mtime만 바꾼 표본은 별도 항목으로 보존했다. 완전 무변경은 원래 크기·mtime을 유지하도록 따로 준비 3회·교대 10회 재측정했고 A의 본문 읽기 0byte·파싱 0행도 실행 중 검증했다.', '');
fs.writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
const markdown = join(dirname(path), basename(path, '.json') + '.md');
fs.writeFileSync(markdown, lines.join('\n'));
console.log(JSON.stringify({ markdown, raw: path }));
