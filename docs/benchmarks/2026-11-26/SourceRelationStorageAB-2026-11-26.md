# 원본 관계 저장 형식 A/B 테스트

사용자는 `relation_meta` BLOB을 줄이고 개선 폭을 측정하도록 요청했다. BLOB의 객체 구조와 Codex 파일별 관계 조회를 줄이면 DB 공간과 부모 후보 조회 시간이 감소할 것으로 예상했다. A는 `20eb14e`에 스키마 v28 작업 내용이 적용된 빌드다. B는 같은 코드에서 `thread_id`·`thread_usage`로 이관하고, Codex 부모 후보용 관계를 한 SQL 문으로 읽는 v29다.

## 1. 결과

시간은 교대 10쌍의 중앙값 ms다. 괄호는 감소율이며 음수는 증가를 뜻한다.

| 측정 항목 | 실로그 714파일·695스레드 | 합성 요청 10,000건 | 합성 요청 100건 |
| --- | ---: | ---: | ---: |
| 요청 1건 추가 | 169.51 → 174.63 (−3.0%) | 38.96 → 39.09 (−0.4%) | 24.16 → 24.51 (−1.5%) |
| 일별 평균 토큰 조회 | 2.173 → 2.265 (−4.2%) | 1.574 → 1.637 (−4.0%) | 1.719 → 1.594 (+7.3%) |
| 월별 평균 토큰 조회 | 1.071 → 1.042 (+2.7%) | 0.794 → 0.816 (−2.8%) | 0.673 → 0.666 (+1.0%) |
| 세션별 평균 토큰 조회 | 3.497 → 3.226 (+7.7%) | 1.275 → 1.178 (+7.5%) | 0.702 → 0.666 (+5.1%) |
| 프로젝트별 평균 토큰 조회 | 0.952 → 0.966 (−1.5%) | 0.691 → 0.723 (−4.7%) | 0.624 → 0.615 (+1.5%) |
| 빈 DB 최초 수집 | 2,759.67 → 2,754.79 (+0.2%) | 226.78 → 228.74 (−0.9%) | 23.33 → 23.56 (−1.0%) |
| 부모 후보용 관계 조회 | 3.559 → 0.879 (+75.3%) | 0.232 → 0.059 (+74.7%) | 0.023 → 0.009 (+59.6%) |
| 새 DB 메인 파일 (KiB) | 960 → 912 (+5.0%) | 204 → 196 (+3.9%) | 68 → 60 (+11.8%) |
| 새 DB의 `source_file` 점유 (KiB) | 416 → 368 (+11.5%) | 52 → 44 (+15.4%) | 12 → 4 (+66.7%) |

Windows x64, Ryzen 5 7500F, Node 24.14.1, SQLite 3.51.2에서 준비 3쌍과 교대 10쌍을 실행했다. 갱신은 새 프로세스와 파일 Worker 4개를 사용했고, OS 캐시를 비우지 않았다. 요청 1건 추가는 각 빌드의 같은 초기 상태를 복원한 뒤 스캔부터 COMMIT과 결과 반환까지 포함했다. 평균 조회는 1건 추가 뒤 `Asia/Seoul` 기준 2020년 이상 2035년 미만에서 미상 날짜를 포함해 제공자별 전체 페이지를 읽었다. 평균 분모는 완료 표본 수다. 부모 후보용 조회는 준비된 DB에서 관계 Map을 만드는 구간을 표본당 50회 반복해 조회당 시간으로 환산했다.

고정 실로그는 Claude 12개와 Codex 702개다. 합성 입력은 두 제공자에 균등하게 배정하고, 각각 100세션·세션당 100요청과 10세션·세션당 10요청을 사용했다. 각 세션의 요청은 7월 1일부터 14일에 분포하며 제공자마다 모델 두 종류를 사용했다. 세 규모에서 준비를 포함한 117쌍의 집계 표본 수·토큰 합계·그룹별 평균 해시가 일치했다. 독립 JSONL 검산과 원본 복원 후 해시, 추가 1건의 130토큰 증가, v28 이관 전후의 8개 표, SQLite 무결성과 외래 키를 확인했다. 설치 DB v19의 읽기 전용 사본을 v28과 v29로 각각 이관했을 때 원본 730행과 소실 55행을 포함한 저장값도 일치했다. [원시 표본과 소스·입력 해시](SourceRelationStorageAB-2026-11-26.json)

## 2. 분석

- **공간** — 실로그의 관계 값은 BLOB 57,040바이트에서 ID 문자열 25,668바이트로 줄었다. 플래그와 행 헤더를 포함한 `source_file`의 실제 레코드 페이로드도 363,962 → 332,591바이트로 감소했다. 새 DB에서 4 KiB 페이지 12개가 줄었다. 기존 960 KiB 사본은 v29 이관 직후에도 파일 크기가 960 KiB였고, 측정 사본을 `VACUUM`한 뒤 868 KiB였다. 실로그 v28 사본의 이관과 연결 열기는 한 번 관측해 23.0 ms였다.
- **부모 후보 조회** — 실로그 Codex 702행에서 `sourceRelations` 호출 702회가 `codexSourceThreadIds` 호출 1회로 줄었고, 10쌍 모두 조회가 빨라졌다. 이 수치는 부모 후보용 관계 Map 구축의 시간이다. 부모 JSONL 읽기와 누계 비교는 갱신 표에 포함했다.
- **전체 갱신** — 요청 1건 추가의 실로그 중앙값은 3.0% 늘었고 10쌍 중 3쌍에서 B가 빨랐다. 최초 수집과 평균 조회는 항목과 입력 규모에 따라 방향이 달랐다. 측정으로 확인된 개선은 저장 공간과 부모 후보용 관계 조회다.

## 재실행

같은 [고정 입력](../2026-11-25/SQLiteIndexRemovalAB-2026-11-25.md)을 `current-data`, `synthetic-10000`, `synthetic-100`에 사본으로 준비한다. 각 `snapshot.private.json`과 `append.private.json`의 절대 경로를 사본 아래로 옮긴다. 스키마 v28 소스와 v29 소스를 각각 `A`·`B` 아래에 두고 `dist/src/summary`로 컴파일한다. 원시 JSON의 소스·빌드·입력 해시로 비교 대상을 확인할 수 있다. 아래 명령은 [기존 갱신 측정기](../../../tests/benchmarks/historical-summary-ab.cjs)에 두 빌드와 이미 준비한 추가 입력을 사용하도록 범위를 지정한다.

```powershell
$benchRoot = '별도 사본과 A·B 빌드가 있는 폴더'
$launcher = @'
const fs=require('node:fs');
const Module=require('node:module');
const path=require('node:path');
const runner=path.resolve('tests/benchmarks/historical-summary-ab.cjs');
const source=fs.readFileSync(runner,'utf8')
  .replace("const revisions = ['9627303', 'fd83620', 'current'];","const revisions = ['A', 'B'];")
  .replaceAll("join(workspace, 'current')","join(workspace, 'B')")
  .replaceAll("join(workspace, 'current',","join(workspace, 'B',")
  .replace("join(workspace, '9627303')","join(workspace, 'A')")
  .replace('revisions.slice(0, 2)','revisions.slice(0, 1)')
  .replace("['cold', 'unchanged', 'append', ...(!requests ? ['recent-cold', 'recent-append'] : [])]","['cold', 'unchanged', 'append']");
process.argv[1]=runner;
const benchmark=new Module(runner,module);
benchmark.filename=runner;
benchmark.paths=Module._nodeModulePaths(path.dirname(runner));
benchmark._compile(source,runner);
'@
$launcher | node --no-warnings - $benchRoot (Join-Path $benchRoot 'results.json') 10 3
```
