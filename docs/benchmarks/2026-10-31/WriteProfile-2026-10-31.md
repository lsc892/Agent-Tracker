# 통계 진입·INSERT·UPDATE 비용 조사

기준일: 2026-10-31, Asia/Seoul.

실제 로컬 로그를 빈 DB에 처음 적재할 때 갱신은 약 **15.5초**, 그중 **영속 세션 저장 API는 1.13초**였다. 변경이 없는 진입은 약 **155ms**이며 요청 통계를 다시 저장하지 않는다. 요청을 추가하거나 기존 요청의 사용량을 바꿀 때는 영향받은 세션을 읽고 다시 저장한다.

이 수치는 SQL마다 상세 타이머를 붙이지 않은 3회 구간 측정의 중앙값이다. INSERT·UPDATE 문장별 시간은 **별도의 상세 계측 1회**에서 구했으며, 두 종류의 시간을 더해 전체 시간을 계산하지 않는다.

## 진입 경로

1. [Dashboard 진입](../../../src/ui/dashboard.ts)에서 `refreshUsage()`를 호출한다. Worker가 `refreshSummary()`를 실행하고 완료 후 기본 일별·제공자별 페이지를 조회한다.
2. [스캐너](../../../src/summary/scanner.ts)는 파일을 탐색하며 manifest를 등록하거나 `last_seen_scan_id`를 UPDATE한다. 바뀐 원본만 읽어 파싱 이벤트를 TEMP 테이블에 넣고, 세션별 통계를 준비한다.
3. [세션 저장](../../../src/summary/db/sessions.ts)은 manifest·프로젝트·세션·요청·모델·도구·비용을 반영한다. 측정한 작은 세션은 기존 요청을 DELETE한 뒤 전체 요청을 INSERT한다. 1,000요청 이상인 세션의 선택적 차이 반영은 이번 입력의 대상 세션에 적용되지 않는다.
4. 일별 사전 집계가 이미 있으면 영향 세션을 재집계한다. 집계가 없는 최초 상태라면 [첫 조회](../../../src/summary/db/rollups.ts)에서 `usage_request_daily`·`usage_model_daily`에 `INSERT ... SELECT`를 수행한다.

## 실제 로그에서의 구간 비용

원본은 **366파일·531,789,135바이트(약 507MiB)**를 고정 복사했다. 집계 결과는 **1,040요청·933모델 행·283세션·14프로젝트**다. 이전 [조회 조사](QueryProfile-2026-10-31.md)의 설치 DB 1,030요청과 다른 snapshot이며, 이 두 입력의 시간을 직접 합산하지 않는다.

| 경우 | 스캔부터 갱신 반환 | 세션 저장 API | 첫 페이지+coverage |
| --- | ---: | ---: | ---: |
| 빈 DB에 최초 적재 | 약 15,493ms | 1,133ms | 약 47ms |
| 변경 없는 진입 | 약 155ms | 0ms | 약 4ms |
| Codex 요청 1개 추가 | 약 276ms | 18.75ms | 약 4ms |
| Codex 기존 요청 사용량 변경 | 약 249ms | 18.09ms | 약 4ms |
| Claude 요청 1개 추가 | 약 205ms | 10.00ms | 약 4ms |

`세션 저장 API`는 `replaceSessions()` 내부의 JS 처리·읽기 SQL·쓰기 SQL·세션 집계 유지·COMMIT을 포함한다. 전체 갱신에 포함되는 중첩 구간이다. 표의 첫 페이지는 비용 표시를 끈 기본 일별·제공자별 100행과 Worker가 붙이는 coverage 조회다. 새 DB 연결 시간은 별도로 JSON의 `openMs`에 보존했다. 실제 Worker가 유지되는 재진입에는 연결을 다시 여는 비용이 들지 않는다.

- 최초 적재의 JSONL 읽기·파싱 콜백 구간은 **9,616ms**, `prepareSummaries()` 구간은 **2,218ms**였다. 읽기·파싱 구간에는 이름 메타데이터 읽기와 파서 콜백의 TEMP INSERT/UPDATE도 포함된다. 이를 순수 파일 읽기 시간으로 해석하지 않는다.
- 최초 페이지의 지연 중 일별 사전 집계 구축 구간은 **39.50ms**였다. 준비된 집계의 SELECT만 측정한 이전 조사와 구분해야 한다.
- Codex 대상 세션은 기존 41요청이다. 요청 1개 추가 시 **41개 DELETE → 42개 INSERT**, 기존 요청 사용량 변경 시 **41개 DELETE → 41개 INSERT**가 관측됐다. Claude 대상 세션은 기존 13요청으로 추가 후 14개를 INSERT했다.
- 변경 없는 진입에도 `manifest` UPDATE가 **366회** 실행된다. 대화 본문 읽기와 세션 통계 저장은 0이며, 이름 메타데이터 조회와 TEMP 작업은 남는다.

## INSERT·UPDATE 자체의 시간

다음은 실제 로그 최초 적재를 별도로 상세 계측한 실행의 **SQL 실행 누적 시간**이다. 이 실행의 갱신은 17,010ms로 구간 측정 중앙값 15,493ms보다 느렸다. 계측 부하와 실행 시점 차이가 있으므로 아래 수치를 구간 측정의 정확한 비중으로 나누지 않는다.

| 영속 테이블 SQL 분류 | 실행 횟수 | 누적 실행 |
| --- | ---: | ---: |
| INSERT | 3,337회 | 103.31ms |
| INSERT ... ON CONFLICT DO UPDATE | 2,446회 | 32.04ms |
| INSERT OR REPLACE: 비용 저장 | 1,040회 | 31.81ms |
| UPDATE | 733회 | 33.63ms |
| DELETE | 292회 | 17.69ms |

여러 SQL을 한 번에 실행하는 `exec()` 묶음은 이 표에서 제외했으며 JSON에서 `BATCH`로 구분했다. SQL 실행 시간에는 SQLite와 SQL에서 호출한 JS 함수가 포함되고, SQL 준비 시간·프로파일 집계 처리·COMMIT 호출 시간은 별도다. UPSERT는 실제로 INSERT하거나 UPDATE할 수 있으므로 순수 INSERT/UPDATE로 임의 분할하지 않는다.

주요 문장별 값:

| SQL | 횟수·직접 변경 행 | 누적 실행 | 최대 단일 실행 |
| --- | --- | ---: | ---: |
| `INSERT INTO turn_summary ... VALUES ...` | 1,040회·1,040행 | 40.67ms | 0.16ms |
| `INSERT OR REPLACE INTO turn_costs SELECT ...` | 1,040회·1,040행 | 31.81ms | 0.18ms |
| manifest의 관측된 파일 속성 UPDATE | 366회·366행 | 22.36ms | 0.13ms |
| `INSERT INTO usage_model_daily SELECT ...` | 1회·371행 | 16.12ms | **16.12ms** |
| `INSERT INTO usage_request_daily SELECT ...` | 1회·310행 | 13.39ms | 13.39ms |

이번 로컬 최초 적재에서 **영속 쓰기 SQL의 최대 단일 호출은 모델별 일별 집계 INSERT**였다. 반복된 요청 INSERT는 누적 시간이 더 크다. 변경 없는 진입에서는 영속 UPDATE 전체가 367회·**2.17ms**였고, 이 중 manifest의 파일 확인 UPDATE 366회는 **1.80ms**였다. 나머지 세션 이름 UPDATE 1회는 변경 행이 0이었다.

## 합성 1만·10만 요청

실제 Claude·Codex 파서로 읽는 JSONL을 사용했다. 세션당 100요청이며, 1만 요청은 100파일·100세션·5,637,210바이트, 10만 요청은 1,000파일·1,000세션·56,920,560바이트다. 이전 조회 실험의 세션당 10요청·20프로젝트 분포와 다르다. 이번 합성 입력은 10프로젝트다.

| 입력·경우 | 갱신 전체 중앙값 | 세션 저장 API | 첫 페이지+coverage |
| --- | ---: | ---: | ---: |
| 1만·최초 | 5,509ms | 2,599ms | 295ms |
| 1만·변경 없음 | 40.60ms | 0ms | 7.57ms |
| 1만·요청 1개 추가 | 88.76ms | 36.58ms | 6.43ms |
| 1만·기존 요청 사용량 변경 | 94.18ms | 36.38ms | 6.39ms |
| 10만·최초 | **90,069ms** | **35,724ms** | **3,065ms** |
| 10만·변경 없음 | 283.73ms | 0ms | 79.56ms |
| 10만·요청 1개 추가 | 332.65ms | 43.43ms | 79.22ms |
| 10만·기존 요청 사용량 변경 | 356.13ms | 39.66ms | 81.12ms |

10만 요청 최초 적재 3회는 **58,503~104,659ms**로 편차가 컸다. 세션 저장 중앙값 35,724ms 외에 TEMP의 `prepareSummaries()` 구간 중앙값이 38,733ms였다. 이 구간 값은 각자 중앙값이므로 합계가 전체 중앙값과 정확히 일치하지 않으며, 부하를 통제한 성능 보장값으로 해석하지 않는다.

10만 최초 적재의 상세 SQL은 계측기를 보완한 별도 실행을 사용했다. 이 실행의 갱신은 **62,849ms**·세션 저장은 33,514ms였다. 입력 해시와 결과 해시가 원래 3회 구간 측정과 동일함을 확인했다.

| 영속 SQL 분류 | 실제 로그 누적 | 합성 1만 누적 | 합성 10만 누적 |
| --- | ---: | ---: | ---: |
| INSERT | 103.31ms | 801.75ms | **8,423.78ms** |
| UPSERT | 32.04ms | 62.78ms | 609.23ms |
| INSERT OR REPLACE | 31.81ms | 205.40ms | 2,136.56ms |
| UPDATE | 33.63ms | 12.11ms | **122.54ms** |
| DELETE | 17.69ms | 6.25ms | 62.43ms |

10만 요청에서는 `turn_summary` INSERT 100,000회가 누적 **3,198ms**, 비용 저장 100,000회가 **2,137ms**였다. 최대 단일 영속 쓰기는 `usage_model_daily` INSERT 한 번의 **1,518ms**였고, 요청 일별 집계 INSERT 한 번은 **1,458ms**였다. 영속 UPDATE의 최대 단일 호출은 세션 이름 갱신 **0.318ms**였다.

별도 상세 실행에서 SQL 준비 누적 **9,708ms**, TEMP 정규화 SQL 묶음 누적 **14,380ms**도 관측했다. 따라서 INSERT/UPDATE 문장 실행과 함께 SQL 준비·TEMP 집계·세션 저장 내부의 읽기/JS 작업도 비용에 포함해야 한다. 이 값들은 같은 실행의 중첩된 타이머여서 세션 저장이나 전체 시간에 다시 더하지 않는다.

## TEMP와 COMMIT 비용

같은 상세 계측의 TEMP 이벤트 INSERT는 **30,924회·누적 1,814ms**였다. 정규화 과정의 TEMP SQL 묶음 하나는 292회 합계 **2,833ms**였다. 따라서 영속 INSERT·UPDATE의 실행 시간만으로 DB 처리 전체 비용을 설명할 수 없다.

구간 측정의 최초 적재에는 **COMMIT 8,984회·누적 약 1,130ms**가 있었다. 여기에는 이벤트 배치의 TEMP 트랜잭션, manifest 진단, 최종 세션 저장과 첫 집계 구축이 포함된다. `storeMs`에 포함되는 COMMIT도 있어 이 시간을 저장 구간에 다시 더하지 않는다. 변경 없는 진입은 COMMIT 11회·누적 약 3.83ms였다.

단일 UPDATE의 최대 관측값은 TEMP `scan_files`의 `source_identity`·`content_hash` UPDATE에서 **142.32ms**였다. 같은 문장 732회의 합계가 248.64ms였으므로 이 최대값을 매회 비용으로 일반화하지 않는다. TEMP 페이지 처리·OS 부하 등 지연 원인을 독립 계측하지 않아 특정 원인으로 단정하지 않는다.

## 측정 범위와 재현

- 설치 DB·원본 로그는 변경하지 않았다. 고정 사본 안에서만 로그에 이벤트를 추가했고 매 반복 전후 크기와 수정 시각을 복원했다. 최초·변경 없음·추가·기존 요청 변경의 결과 해시를 반복 대조하고 요청 수·토큰 증가량·FK·DB 무결성을 확인했다.
- 각 조건은 같은 준비 상태에서 시작한다. 실제 로그는 한 번 고정했고, 이름 메타데이터도 복사했다. 서버·quota 호출은 하지 않았다.
- 상세 SQL 계측은 별도 반복에서 실행했다. `iterate()`는 iterator 생성·각 `next()`·정리 호출만 재며, 결과를 소비하는 JS 작업 시간을 포함하지 않는다. SQL 파라미터·대화·제목·실제 경로·세션 ID는 보고서에 저장하지 않는다.
- `directChangedRows`는 SQLite가 반환하는 직접 변경 행이며 FK cascade를 제외한다. `engineChangedRowsIncludingTempAndCascades`는 TEMP와 cascade를 포함한 전체 변경 수다. SQL 호출 수·변경 행 수를 물리 디스크 I/O로 해석하지 않는다.
- 캐시 4,096KiB·`temp_store=FILE`·제품 optimize를 유지했다. OS 캐시를 비우거나 백그라운드 작업을 중지하지 않았다. Worker 시작·대기·통신·웹뷰 렌더링은 제외한다.
- 전체 구간 표본과 로컬·1만 요청의 상세 SQL은 [원시 JSON](WriteProfile-2026-10-31.json)에 있다. 원래 10만 최초 적재의 `diagnostic`은 계측기가 일회성 statement를 강하게 보관해 과도한 부하를 일으킨 실행이므로 시간 판단에 사용하지 않았다. 원시 값은 보존했다.
- 최종 계측기는 일회성 statement를 붙잡지 않는 WeakMap을 사용하고 제품의 고정 statement 캐시만 복원한다. 10만 최초 적재의 최종 상세 시간은 [보완 상세 JSON](WriteProfile-detail-fixed-2026-10-31.json)에 보존했다. 전체 시간용 3회 표본에는 상세 statement 계측을 적용하지 않았다.

```powershell
npm.cmd run build
node tests/benchmarks/write-profile.cjs tests/results/benchmarks/write-profile.json
# 짧은 합성 검증
node tests/benchmarks/write-profile.cjs tests/results/benchmarks/write-profile-smoke.json --smoke
# 10만 최초 적재의 상세 SQL만 측정
node tests/benchmarks/write-profile.cjs tests/results/benchmarks/write-profile-detail.json --no-real --only=synthetic-100000 --detail-initial-only
```

출력이 이미 있으면 새 파일명을 사용한다. [측정 실행기](../../../tests/benchmarks/write-profile.cjs)

검증: 짧은 합성 입력의 일반·상세 전용 실행, 본문의 3개 입력·13개 조건, 보완된 10만 최초 상세 실행을 완료했다. 결과 해시·요청/토큰 수·FK·DB 무결성을 확인했고 `npm.cmd run check`의 타입 검사·린트·374개 테스트와 문서 링크·`git diff --check`를 통과했다. 제품 기능은 변경하지 않았다.
