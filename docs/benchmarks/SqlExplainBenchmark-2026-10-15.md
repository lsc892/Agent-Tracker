# Agent Tracker SQL 벤치마크: 현재 집계와 일별 rollup 비교

측정일: 2026-10-15 (Asia/Seoul). **B안을 실제 제품 SQL에 적용했다. 100K·세션당 100turn에서 프로젝트 평균은 872.847→4.137ms(-99.53%)로 줄었고, DB는 +7.82%, 같은 세션 교체 시간은 +36.70% 증가했다.** 최초 구축과 소량의 부분 날짜 조회 비용은 아래에서 별도로 비교한다.

현재 비교는 **A=적용 전 제품**, **B=실제 제품의 일별 rollup**이다. 결과 캐시는 사용하지 않는다. 이전 후보 단계와 인덱스 유지/제거 실험은 아래 접힌 기록에 보존했으며 서로 다른 실행의 수치를 섞지 않는다.

[실제 제품 A/B 원시 JSON](SqlRollupProductBenchmark-2026-10-15.json) · [후보 단계 rollup A/B 원시 JSON](SqlRollupABBenchmark-2026-10-15.json) · [기존 인덱스 실험 원시 JSON](SqlExplainBenchmark-2026-10-15.json)

## 제품 B안 적용 검증

A는 수정 전에 보존한 schema v10 제품 실행물, B는 **현재 schema v11의 실제 SummaryDatabase API**다. 기준 revision은 `f92f80876de75ca63f0ee5cb0905255516753af5`이며 보존 소스 44개의 hash와 새 구현 hash를 [제품 경로 원시 JSON](SqlRollupProductBenchmark-2026-10-15.json)에 기록했다. 후보 코드의 시간과 섞어 비교하지 않는다.

- 요청·모델 facts는 유지하고 `usage_request_daily`·`usage_model_daily`와 단일 시간대 metadata를 추가했다. 제공자·프로젝트·세션·일·월별 합계/평균과 누계가 실제 rollup을 사용한다.
- 완료 표본의 합계·건수를 합쳐 가중평균을 구한다. 다중 모델 건수·cache/duration NULL·오류·미상 시각과 이름 필터를 보존한다. 완전한 현지 날짜는 rollup, 부분 경계는 facts로 처리한다.
- 시간대는 하나만 저장하며 설정 변경 때 원자적으로 재구축한다. 세션 교체·삭제·진단 변경은 같은 transaction에서 영향 세션만 갱신한다. 비용 포함·지원 범위 밖 시각·Node 22.15는 기존 SQL을 사용한다. 결과 캐시는 없다.

### 실제 제품의 읽기 시간

대표 조건은 요청 100K행·모델 facts 116,352행·1,000세션·세션당 100turn이다. 전체 그룹 집계 후 최대 100행 + COUNT를 호출한 warm-cache 중앙값이며 **SQL 준비·시간대 metadata·read snapshot·날짜 안전성 검사도 포함**한다. 괄호 대신 별도 열로 증감률 `(B−A)/A × 100`을 표시하며 음수는 시간 감소다.

| 조회 | A ms | B ms | 증감률 |
| --- | ---: | ---: | ---: |
| 전체 토큰·turn 평균 | 860.266 | 4.023 | -99.53% |
| 전체 모델별 토큰·평균 | 949.312 | 17.415 | -98.17% |
| 전 기간 월별 | 2287.382 | 6.464 | -99.72% |
| 전 기간 월별·모델별 | 2530.366 | 23.654 | -99.07% |
| 프로젝트별 평균 순위 | 872.847 | 4.137 | -99.53% |
| 자정 경계 7일 | 160.522 | 2.153 | -98.66% |
| 최근 7일·부분 날짜 | 190.275 | 46.451 | -75.59% |
| 전체 세션·모델별 | 1219.455 | 46.947 | -96.15% |
| 모델 누계 | 526.957 | 17.365 | -96.70% |

### 줄어든 집계 입력과 추가 DB 공간

논리적 전체 집계 입력이며 SQLite가 실제 방문한 행 수를 계측한 값은 아니다. 모델 입력에는 모델 없는 요청의 LEFT JOIN 대체 행도 포함한다. DB는 checkpoint 후의 전체 할당 MiB다.

| 요청 수 / 세션당 turn | 요청 입력 A→B (%) | 모델 입력 A→B (%) | DB MiB A→B (%) |
| --- | ---: | ---: | ---: |
| 280 / 10 | 280→31 (-88.93%) | 334→72 (-78.44%) | 0.156→0.227 (+45.00%) |
| 280 / 100 | 280→6 (-97.86%) | 334→15 (-95.51%) | 0.156→0.188 (+20.00%) |
| 100,000 / 10 | 100,000→10,991 (-89.01%) | 119,192→25,535 (-78.58%) | 29.953→42.309 (+41.25%) |
| 100,000 / 100 | 100,000→1,991 (-98.01%) | 119,192→5,175 (-95.66%) | 29.457→31.762 (+7.82%) |

100K·100turn의 DB는 **30,887,936→33,304,576bytes, +2,416,640bytes(+7.82%)**다. 그중 rollup 표·인덱스·metadata의 B-tree 할당은 2,412,544bytes다. 영속 공간은 기존 `O(N+M)`에 실제 일별 조합 `O(R+Rm)`을 추가한다. 주 입력은 `K`에서 `r+B`로 줄지만 그룹화·정렬은 남는다. 세션·날짜·모델이 매번 달라지면 집계 행 수도 증가하므로 최악의 선형 차수가 사라지는 것은 아니다.

### 실제 갱신 transaction 비용

대표 100K·100turn 조건. `replaceSessions`를 그대로 실행했고 **양쪽 모두 BEGIN IMMEDIATE 1회·COMMIT 1회**다. 입력 준비·상태 복원·checkpoint는 시간 밖이며 WAL은 각 표본 전 TRUNCATE 후 크기의 중앙값이다.

| 작업 | A→B ms (%) | WAL A→B KiB (%) |
| --- | ---: | ---: |
| 같은 100turn 세션 교체 | 7.588→10.372 (+36.70%) | 128.78→160.97 (+24.99%) |
| 1turn 추가 후 101turn 세션 교체 | 7.688→11.672 (+51.83%) | 136.83→181.09 (+32.35%) |

추가 집계 SQL과 인덱스·WAL 쓰기 비용을 감수한 결과다. 세션 전체 교체 방식은 유지하므로 긴 세션의 갱신 비용은 남는다. 프로젝트 전체의 facts를 재집계하거나 테이블마다 transaction을 만들지는 않는다.

### 소량·최초 조회·최악 관측

| 요청 수 / 세션당 turn | 프로젝트 평균 A→B ms (%) | 부분 날짜 7일 A→B ms (%) | 최초 조회 A→B ms |
| --- | ---: | ---: | ---: |
| 280 / 10 | 3.834→1.498 (-60.92%) | 1.568→4.064 (+159.28%) | 2.561→17.464 |
| 280 / 100 | 3.326→0.746 (-77.57%) | 3.119→5.317 (+70.45%) | 2.969→12.252 |
| 100,000 / 10 | 922.810→33.731 (-96.34%) | 207.511→56.004 (-73.01%) | 1005.824→4564.969 |
| 100,000 / 100 | 872.847→4.137 (-99.53%) | 190.275→46.451 (-75.59%) | 940.184→4393.769 |

소량의 부분 날짜 조회는 B가 느리다. 280행·100turn의 부분 날짜·모델 조회도 2.429→7.184ms(+195.81%)다. 이는 임의 시간 경계 변환·SQL 구성·병합의 고정 비용을 포함한 결과이며, 작은 데이터에 대한 자동 경로 선택 임계값은 도입하지 않았다.

반복 조회의 B 최대 표본은 **274.318ms(0.274초)**로 100K·10turn의 `sessions-model`에서 관측했다(중앙값 274.071ms). A의 최대 표본은 2786.512ms였다. **최초 조회는 예외**다. B는 처음 facts를 전부 집계하므로 100K에서 4.394~4.565초가 관측됐다. 이 최초 시간은 구축을 포함한 provider total + COUNT의 1회 관측이며, 반복 표본의 중앙값과 구분한다. 시간대 변경도 재구축 비용이 발생한다. 100K보다 큰 데이터·cold I/O·비용 fallback·UI 전체에서 2초 미만을 보장하는 자료는 아니다.

### 방법·정확성·재현

측정 시작 2026-10-15 22:34:30 (Asia/Seoul), Node v24.19.0, SQLite 3.53.3, Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz, Windows x64. 결정적 합성 데이터 4분포 × 16조회 = 64쌍이며 준비 1회·교대 표본 3개, 짧은 조회는 최대 20회 묶어 1회 평균을 표본으로 사용했다. 표본 원문·범위·P10/P90·rows/count 시간과 SQL·EXPLAIN은 새 JSON에 있다. 원본 로그·fixture 생성·전체 결과 검증·계획 조회·IPC·UI는 시간 밖이다. 두 비교군은 같은 SQLite backup에서 시작해 ANALYZE했으며, SQLite page cache와 OS cache가 따뜻한 조건이다.

페이지와 COUNT를 비교하고 누계를 제외한 56개 조회는 페이지 밖의 **전체 그룹 모든 필드**도 대조했다. 정수·건수는 정확히, 부동소수 평균만 `1e-9` 허용오차로 일치해야 통과한다. 두 실제 쓰기 작업 뒤 제공자·모델 합계도 비교했다. 기능 검증은 `npm run check` **269개 테스트 통과**로 확인했으며 migration ID 보존, partial/DST·unknown 범위, 변경·삭제·이동·진단, refresh 실패 rollback, WAL reader·시간대 교체, 비용 변경과 구버전 Node fallback을 포함한다. 실제 VS Code 화면·실계정 호출·장시간 writer 경합·전원 손실은 검증하지 않았다.

RSS는 두 비교군·검증 결과가 섞인 공유 프로세스 관측이므로 독립적인 A/B peak 차이를 주장하지 않는다. 새 제품 비교의 공간 실측은 DB B-tree·할당 공간이며 아래 후보 단계의 별도 프로세스 RSS 결과를 새 제품의 메모리 결과로 대체하지 않는다.

현재 workspace에서 기준 사본을 사용한 재실행:

```powershell
npm.cmd run benchmark:sql:rollup:product -- --baseline=tests/results/benchmarks/rollup-product-baseline-20261015-221640 --sizes=280,100000 --turns=10,100 --samples=3 --output=tests/results/benchmarks/sql-rollup-product.json
```

기준 사본은 변경 전 `src/`·`dist/src/`·`manifest.json`이며 tests/results 아래의 로컬 보존물이다. 다른 환경에서는 JSON에 기록한 기준 revision으로 같은 실행물을 준비해야 한다. [실제 제품 비교 실행기](../../tests/benchmarks/sql-rollup-product.cjs) · [제품 회귀 테스트](../../tests/node/summary-rollup.test.ts) · [현재 설계](../AgentTracker.md).

<details>
<summary>실제 제품 64개 조회의 소량·대량 전체 비교</summary>

세션당 10turn. 단위 ms, 괄호는 증감률.

| 조회 | 280행 A→B (%) | 100K행 A→B (%) |
| --- | ---: | ---: |
| 전체 토큰·turn 평균 | 2.856→0.742 (-74.01%) | 949.771→20.834 (-97.81%) |
| 전체 모델별 토큰·평균 | 3.269→1.034 (-68.36%) | 1087.601→103.822 (-90.45%) |
| 전 기간 월별 | 6.789→0.945 (-86.09%) | 2380.544→39.834 (-98.33%) |
| 전 기간 월별·모델별 | 7.908→1.530 (-80.66%) | 2785.409→128.815 (-95.38%) |
| 최근 7일·부분 날짜 | 1.568→4.064 (+159.28%) | 207.511→56.004 (-73.01%) |
| 최근 7일·부분 날짜·모델별 | 2.241→4.611 (+105.77%) | 252.894→106.555 (-57.87%) |
| 최근 7일·시각 미상 제외 | 1.793→3.549 (+97.92%) | 187.467→53.028 (-71.71%) |
| 특정 프로젝트 최근 30일 | 0.831→2.938 (+253.41%) | 9.299→3.905 (-58.00%) |
| 특정 프로젝트 최근 30일·모델별 | 0.982→3.477 (+254.15%) | 8.877→6.104 (-31.24%) |
| 전체 세션별 | 3.546→1.538 (-56.63%) | 484.900→75.547 (-84.42%) |
| 전체 세션·모델별 | 4.759→2.339 (-50.85%) | 1528.886→274.071 (-82.07%) |
| 특정 세션 | 1.055→0.929 (-11.94%) | 0.884→1.062 (+20.16%) |
| 프로젝트별 평균 순위 | 3.834→1.498 (-60.92%) | 922.810→33.731 (-96.34%) |
| 자정 경계 7일 | 1.646→2.167 (+31.61%) | 196.787→5.534 (-97.19%) |
| 제공자 누계 | 2.339→0.646 (-72.37%) | 1009.589→13.901 (-98.62%) |
| 모델 누계 | 1.349→0.944 (-30.05%) | 650.746→103.038 (-84.17%) |

세션당 100turn. 단위 ms, 괄호는 증감률.

| 조회 | 280행 A→B (%) | 100K행 A→B (%) |
| --- | ---: | ---: |
| 전체 토큰·turn 평균 | 2.659→0.692 (-73.99%) | 860.266→4.023 (-99.53%) |
| 전체 모델별 토큰·평균 | 3.446→0.716 (-79.21%) | 949.312→17.415 (-98.17%) |
| 전 기간 월별 | 6.943→0.846 (-87.82%) | 2287.382→6.464 (-99.72%) |
| 전 기간 월별·모델별 | 7.877→1.021 (-87.04%) | 2530.366→23.654 (-99.07%) |
| 최근 7일·부분 날짜 | 3.119→5.317 (+70.45%) | 190.275→46.451 (-75.59%) |
| 최근 7일·부분 날짜·모델별 | 2.429→7.184 (+195.81%) | 216.465→52.493 (-75.75%) |
| 최근 7일·시각 미상 제외 | 2.494→5.772 (+131.41%) | 162.064→38.192 (-76.43%) |
| 특정 프로젝트 최근 30일 | 1.089→2.571 (+136.15%) | 8.421→3.162 (-62.46%) |
| 특정 프로젝트 최근 30일·모델별 | 1.765→3.927 (+122.53%) | 8.171→3.646 (-55.39%) |
| 전체 세션별 | 3.565→0.754 (-78.86%) | 450.862→11.830 (-97.38%) |
| 전체 세션·모델별 | 4.031→1.062 (-73.65%) | 1219.455→46.947 (-96.15%) |
| 특정 세션 | 1.635→0.836 (-48.88%) | 1.940→1.075 (-44.57%) |
| 프로젝트별 평균 순위 | 3.326→0.746 (-77.57%) | 872.847→4.137 (-99.53%) |
| 자정 경계 7일 | 2.735→1.617 (-40.89%) | 160.522→2.153 (-98.66%) |
| 제공자 누계 | 3.065→0.643 (-79.01%) | 887.309→2.818 (-99.68%) |
| 모델 누계 | 1.526→0.805 (-47.24%) | 526.957→17.365 (-96.70%) |

</details>

---

<details>
<summary>이하: 제품 적용 전 후보 단계의 읽기·공간·쓰기 측정 기록</summary>

## A와 B의 차이

| 항목 | A: 현재 제품 | B: 일별 rollup 후보 |
| --- | --- | --- |
| 원본 저장 | `turn_summary` + `turn_model_usage` 및 기존 관련 표 | A와 동일하게 보존 |
| 기존 인덱스 | 날짜·프로젝트 인덱스, 요청 UNIQUE, 모델 PK 유지 | A와 동일하게 유지 |
| 추가 저장 | 없음 | 요청 `provider×프로젝트×세션×현지 일`, 모델 `provider×프로젝트×세션×현지 일×모델` 집계 표 |
| 추가 인덱스 | 없음 | 각 rollup에 일/프로젝트별 보조 인덱스 2개씩 |
| 합계·평균 조회 | 선택된 turn을 읽어 `SUM`/`AVG` | 일별 표본 합계·건수를 합쳐 `SUM(합계)/SUM(건수)` |
| 임의 시간 범위 | 선택 범위의 turn 집계 | 완전한 날짜는 rollup, 경계 날짜의 일부 시간은 원본 집계 후 병합 |
| 세션 갱신 | 기존 세션 facts 등을 교체하는 transaction 1개 | 같은 transaction에서 해당 세션 rollup도 교체 |
| 가속 범위 | 현재 기능 | `Asia/Seoul`, 비용 미포함. 그 밖의 시간대·비용 포함 조회는 A로 fallback |

완료/사용량 기록 있는 완료 표본, cache·duration의 NULL 규칙을 따로 보존한다. 모델 여러 개가 쓰인 turn은 각 모델 집계에 포함되므로 **모델별 건수 합계를 전체 요청 건수로 사용하지 않는다.**

표의 **증감은 B−A**, **증감률은 (B−A)/A × 100**이다. 음수는 시간 감소, 양수는 시간·공간·WAL의 증가를 뜻한다. 증감률은 반올림 전 원시값으로 계산했다. 반복 조회는 warm-cache 중앙값(준비 1회·교대 표본 3개)이며 cold I/O 결과가 아니다.

## 대표 조건: 100K 요청·세션당 100turn

1,000개 세션의 같은 데이터 사본을 비교했다. 전체 요청·모델 조회가 집계에 넣는 **논리적 입력**은 다음과 같이 줄었다. 이는 SQLite 실제 행 방문 횟수 계측값이 아니다.

| 항목 | A | B | 증감 | 증감률 |
| --- | ---: | ---: | ---: | ---: |
| 요청 집계 입력 | 100,000행 | 1,991행 | -98,009행 | -98.01% |
| 모델 집계 입력 | 119,192행 | 5,175행 | -114,017행 | -95.66% |

모델의 실제 원본 테이블은 116,352행이다. 위 119,192행은 모델 없는 요청의 LEFT JOIN 대체 행까지 포함한 조회 입력이며, 서로 다른 수치를 혼동하지 않는다. 시각 미상도 별도 일 bucket으로 보존한다.

### 읽기 시간

단위 ms. 전체 그룹을 집계한 뒤 최대 100행 반환 + 전체 그룹 COUNT를 합친 시간이다. `LIMIT 100`이 집계 입력을 100행으로 제한하는 것은 아니다.

| 조회 | A ms | B ms | 증감 ms | 증감률 |
| --- | ---: | ---: | ---: | ---: |
| 전체 토큰·turn 평균 | 863.532 | 3.762 | -859.770 | -99.56% |
| 전체 모델별 토큰·turn 평균 | 944.236 | 19.403 | -924.833 | -97.95% |
| 전 기간 월별 | 2614.903 | 8.145 | -2606.758 | -99.69% |
| 전 기간 월별·모델별 | 2671.642 | 21.512 | -2650.130 | -99.19% |
| 프로젝트별 평균 순위 | 840.885 | 3.759 | -837.126 | -99.55% |
| 특정 프로젝트 최근 30일 | 8.381 | 1.118 | -7.263 | -86.66% |
| 특정 프로젝트 최근 30일·모델별 | 8.548 | 1.505 | -7.043 | -82.39% |
| 전체 세션별 | 454.091 | 21.210 | -432.881 | -95.33% |
| 특정 세션 | 1.568 | 0.307 | -1.261 | -80.44% |
| 자정 경계 7일 | 193.450 | 5.696 | -187.754 | -97.06% |
| 최근 7일·부분 날짜 | 178.419 | 43.764 | -134.655 | -75.47% |

### 공간·쓰기에서 추가되는 비용

원본을 지우지 않으므로 **집계 입력은 줄지만 DB 파일은 커진다.** DB는 MiB(1,048,576bytes), WAL은 KiB(1,024bytes)이며, WAL은 checkpoint 후 빈 파일에서 한 번의 COMMIT 뒤 생긴 논리적 크기다.

| 항목 | A | B | 증감 | 증감률 |
| --- | ---: | ---: | ---: | ---: |
| DB 전체 할당 | 29.457MiB | 31.750MiB | +2.293MiB | +7.78% |
| 같은 세션 재설치 | 9.893ms | 15.020ms | +5.127ms | +51.83% |
| 1turn 추가 후 세션 교체 | 9.181ms | 13.810ms | +4.628ms | +50.41% |
| 같은 세션 재설치 WAL | 128.78KiB | 160.97KiB | +32.19KiB | +24.99% |
| 1turn 추가 후 세션 교체 WAL | 136.83KiB | 181.09KiB | +44.26KiB | +32.35% |

DB 원시값은 30,887,936→33,292,288bytes로 **2,404,352bytes(+7.78%)** 증가했다. 그중 추가 집계 표·인덱스 할당은 2,400,256bytes다.

B의 최초 구축은 **3,600.667ms, 1회 관측**이다. DDL + 전체 집계 transaction이며 ANALYZE는 제외했다. 반복 조회의 중앙값과 동일한 반복 측정으로 해석하지 않는다. A는 rollup 구축이 없다.

프로젝트 평균 조회 절감 837.126ms로 최초 구축을 단순 나누면 약 4.30회(정수 5회) 조회에 해당한다. 이는 서로 다른 관측 시간의 상각 추산이며, 실제 조회·갱신 비율이나 cold I/O에 대한 보장이 아니다.

## B가 느린 경우도 먼저 확인

소량 데이터에서 이미 인덱스로 대상을 좁히면 rollup 병합·UNION·경계 계산 비용이 더 클 수 있다. 큰 증감률만으로 모든 조회를 B로 바꾸는 근거는 되지 않는다.

| 조건·조회 | A ms | B ms | 증감 ms | 증감률 |
| --- | ---: | ---: | ---: | ---: |
| 280행 / 10turn · 특정 프로젝트 최근 30일 | 0.422 | 0.718 | +0.296 | +70.26% |
| 280행 / 10turn · 특정 프로젝트 최근 30일·모델별 | 0.659 | 0.888 | +0.229 | +34.70% |
| 280행 / 100turn · 최근 7일·부분 날짜 | 2.138 | 2.859 | +0.720 | +33.68% |
| 280행 / 100turn · 최근 7일·부분 날짜·모델별 | 2.454 | 4.038 | +1.584 | +64.53% |
| 280행 / 100turn · 최근 7일·시각 미상 제외 | 2.100 | 2.718 | +0.618 | +29.44% |
| 280행 / 1turn · 특정 프로젝트 최근 30일 | 0.408 | 0.656 | +0.248 | +60.74% |

280행·10turn의 프로젝트 조회는 대상이 이미 10turn뿐이다. 280행·100turn의 부분 날짜 7일 조회는 B의 입력 82개 중 79개가 raw 경계 입력이어서 일별 압축 이득이 작았다. 같은 조건 안에서는 A/B에 같은 기간을 적용했다. 자정 경계 7일과 임의 timestamp 7일은 서로 다른 조건이다.

280행·1turn 사례는 요청·모델 입력이 전혀 줄지 않았다. 전체 요청 조회는 날짜·모델 판정과 표본 상태의 사전 계산으로 1.970→0.460ms였지만, 세션별 조회는 3.224→3.001ms로 차이가 작고 좁은 프로젝트 조회는 느려졌다. 일반적인 주 분포와 구분하기 위한 경계 사례다.

이 결과는 **소량·좁은 범위에서는 A, 반복적인 넓은 집계에서는 B를 사용할 후보 근거**다. 자동 경로 선택의 임계값은 아직 구현하거나 검증하지 않았다.

## 소량·대량 및 세션 길이에 따른 차이

전체 요청 수뿐 아니라 같은 세션·날짜·모델에 몇 turn이 누적되는지가 압축률과 추가 공간을 결정한다.

| 요청 수 / 세션당 turn | 세션 수 | 요청 입력 A→B | 감소율 | 모델 입력 A→B | 감소율 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 280 / 10 | 28 | 280→31 | 88.93% | 334→72 | 78.44% |
| 280 / 100 | 3 | 280→6 | 97.86% | 334→15 | 95.51% |
| 100,000 / 10 | 10,000 | 100,000→10,991 | 89.01% | 119,192→25,535 | 78.58% |
| 100,000 / 100 | 1,000 | 100,000→1,991 | 98.01% | 119,192→5,175 | 95.66% |
| 280 / 1 | 280 | 280→280 | 0.00% | 334→334 | 0.00% |

| 요청 수 / 세션당 turn | 프로젝트 평균 A→B ms (증감률) | 모델 전체 A→B ms (증감률) | B의 DB 추가량 | B의 같은 세션 교체 추가 시간 |
| --- | ---: | ---: | ---: | ---: |
| 280 / 10 | 2.751→0.611 (-77.78%) | 2.921→0.556 (-80.96%) | +68.00KiB (+42.50%) | +1.374ms (+65.56%) |
| 280 / 100 | 2.870→0.633 (-77.95%) | 2.647→0.415 (-84.31%) | +28.00KiB (+17.50%) | +4.216ms (+51.73%) |
| 100,000 / 10 | 850.789→27.205 (-96.80%) | 1113.648→106.146 (-90.47%) | +12.01MiB (+40.10%) | +1.437ms (+81.30%) |
| 100,000 / 100 | 840.885→3.759 (-99.55%) | 944.236→19.403 (-97.95%) | +2.29MiB (+7.78%) | +5.127ms (+51.83%) |
| 280 / 1 | 3.553→0.993 (-72.06%) | 3.191→1.421 (-55.48%) | +212.00KiB (+123.26%) | +0.795ms (+59.30%) |

100K에서 세션당 10turn은 DB가 약 12.01MiB 늘고, 100turn은 약 2.29MiB 늘었다. 세션당 turn이 많은 사용자 조건에서 B의 읽기 절감에 비해 공간 증가가 작아졌다. 15개 전체 조회 조건은 [상세 표](#부록-a-rollup-ab-전체-조회표)에서 확인할 수 있다.

## 트랜잭션은 무엇이 달라지는가

현재 `replaceSessions`는 요청·모델·비용 등 여러 테이블 교체를 하나의 `BEGIN IMMEDIATE`/`COMMIT` 안에서 수행한다. B는 그 경로에 영향을 받은 세션의 집계 교체를 같은 transaction 안에 추가하는 후보이며 테이블마다 COMMIT하는 비교가 아니다. 전체 프로젝트를 다시 집계하지 않는다. 단, 현행 세션 전체 교체 비용은 남으므로 한 세션이 매우 길 때의 갱신 비용을 일별 집계가 제거하지는 않는다.

집계 유지 비용은 추가 SQL·인덱스 쓰기·WAL 페이지와 writer 점유 시간으로 나타난다. SQLite WAL에서도 동시 writer는 하나이므로 조회 개선량과 쓰기 지연을 함께 본다. WAL 파일 크기는 재사용·checkpoint에 영향을 받으며 파일 크기 증가를 곧바로 총 쓰기 바이트로 해석하지 않는다. [SQLite transaction](https://sqlite.org/lang_transaction.html), [WAL과 checkpoint](https://sqlite.org/wal.html).

영속 공간은 `dbstat`의 테이블·인덱스 B-tree 할당과 page count를 분리한다. DB 전체 파일에는 freelist·공통 메타데이터가 포함될 수 있다. 이 수치는 실제 DB 공간이며 이론적 보조 공간이나 쿼리의 peak TEMP·RSS와 같지 않다. 같은 Node 프로세스의 RSS에는 두 비교군·런타임·검증 결과가 섞이므로 독립적인 A/B 최대 메모리 차이로 해석하지 않는다. [SQLite dbstat](https://sqlite.org/dbstat.html).

아래는 대표 100K·100turn의 변경 종류별 결과다. 입력 추출·JS 객체 생성은 시간 밖에서 준비하고, 각 표본 전 같은 세션 상태로 복원했다. 실제 제품 `SummaryDatabase.replaceSessions`를 실행하며 B는 COMMIT 직전 해당 세션의 이전 집계를 삭제한 뒤 새 facts에서 해당 세션만 재집계했다. **양쪽 모두 작업당 BEGIN IMMEDIATE 1회·COMMIT 1회**다.

| 작업 | A→B ms | 시간 증감 ms (%) | WAL A→B KiB | WAL 증감 KiB |
| --- | ---: | ---: | ---: | ---: |
| 같은 세션 재설치 | 9.893→15.020 | +5.127 (+51.83%) | 128.78→160.97 | +32.19 |
| 1turn 추가 후 세션 교체 | 9.181→13.810 | +4.628 (+50.41%) | 136.83→181.09 | +44.26 |
| 과거 날짜 수정 | 9.486→13.617 | +4.131 (+43.55%) | 128.78→160.97 | +32.19 |
| 프로젝트 이동 | 9.351→13.143 | +3.792 (+40.55%) | 140.85→173.04 | +32.19 |
| 세션 삭제 | 3.131→3.945 | +0.815 (+26.02%) | 128.78→160.97 | +32.19 |

WAL은 자동 checkpoint를 끄고 매 측정 전 TRUNCATE checkpoint를 시간 밖에서 실행했다. checkpoint·다른 writer 대기·로그 파싱·스캐너 전체 갱신은 제외했다. 같은 내용 교체도 DB 설치 경로를 의도적으로 실행한 것이며, 변경 없는 파일을 건너뛰는 scanner 경로는 측정하지 않았다. 따라서 운영 전체 지연·디스크 실제 쓰기량·no-change 갱신 비용으로 해석하지 않는다.

다른 규모의 세션 교체 결과도 [상세 쓰기 표](#전체-규모의-세션-교체)에서 보존한다.

## 시간·공간복잡도

`N`은 요청 facts, `M`은 모델별 조회의 LEFT JOIN 입력 행 수(모델이 없는 요청의 대체 행 포함), `R`·`Rm`은 실제 존재하는 요청·모델 일별 집계 행 수다. 선택 조건에 맞는 사실 입력은 `K`·`Km`, 일별 집계 입력은 `r`·`rm`, 불완전한 경계 날짜의 사실 입력은 `B`·`Bm`, 반환 전 전체 그룹 수는 `G`로 구분한다. 가능한 모든 차원 조합을 만드는 것이 아니라 실제 조합만 저장한다.

| 항목 | A: 현재 facts 집계 | B: 일별 집계 |
| --- | --- | --- |
| 요청 기준 주 집계의 논리적 입력 | 선택된 `K`행 | `r + B`행 |
| 모델 기준 주 집계의 논리적 입력 | 선택된 `Km`행 | `rm + Bm`행 |
| 원본과 영속 인덱스 저장 | `O(N + M)` | 기존 저장 유지 + `O(R + Rm)` |
| 전체 기간 조회의 최악 입력 | `N` 또는 `M` | `R` 또는 `Rm` |
| 초기 집계 구축 | 없음 | 전체 facts와 모델 연결·날짜 변환·그룹화·집계 인덱스 작성 |
| 세션 변경 | 해당 세션 facts·모델·비용 등 교체 | 동일 교체 + 해당 세션 일별 기여분 교체 |

위의 입력 행 수는 실제 SQLite 가상 머신의 방문 횟수와 다르다. `EXPLAIN`도 실제 방문 횟수를 제공하지 않는다. rows 조회와 전체 그룹 COUNT가 같은 입력을 다시 처리할 수 있고, 현재 요청 집계의 모델 EXISTS, 모델 PK 연결, 테이블 행 조회, 날짜 UDF와 GROUP BY·ORDER BY 비용이 추가된다.

단순화한 범위 탐색·주 입력 순회량은 A의 `O(log N + K)`에서 B의 `O(log R + r + B)`로 바뀐다. 모델 기준도 같은 방식으로 선택된 모델 입력을 비교하되 요청→모델 PK 탐색 비용을 별도로 고려한다. 이 표기는 쿼리 전체 실행 시간의 엄밀한 상한이 아니다. 인덱스가 GROUP BY를 충족하지 않아 입력 `I`행을 정렬하는 계획에서는 보수적으로 `O(I log I)`의 그룹화 정렬 작업, 결과 정렬에는 `O(G log G)` 작업이 남을 수 있다. 그룹별 항목만 유지하는 B-tree의 `O(I log G)`와 입력 전체를 정렬하는 계획을 구분하며 실제 선택 계획과 실측을 함께 해석한다.

세션당 turn이 많고 날짜·모델 조합이 적으면 `R ≪ N`, `Rm ≪ M`이 되어 읽는 양이 크게 줄어든다. 반대로 세션마다 한 turn이거나 날짜·모델 조합이 매번 다르면 `R`·`Rm`이 사실 행 수와 비슷해져 최악 시간복잡도는 여전히 선형이며 추가 저장·갱신 비용이 생긴다. 평균의 나눗셈은 그룹당 상수 작업이다. 절감 원인은 원본 재집계·날짜 변환·모델 판정 입력을 줄이는 것이며 평균 계산 자체가 별도 전체 스캔을 없애는 것은 아니다.

세션당 turn 수 `T`와 날짜·모델 분포를 고정하고 세션 수를 늘리면 `R`도 대략 `N/T`에 비례한다. 이 경우 양쪽이 `N`에 대해 같은 선형 차수를 가지면서 입력량·상수 비용이 줄어드는 개선일 수 있다. 같은 세션·날짜·모델 조합에 turn만 누적되어 `R`이 유지되는 경우에는 집계 조회 입력이 `N`과 함께 늘지 않는다. 이번 소량·대량 실측만으로 모든 입력에서의 점근적 차수 개선을 입증하지 않는다.

완료/사용량 기록 있는 완료 표본의 합계·건수를 따로 보존해야 현재 평균을 재현할 수 있다. 미상 cache와 duration도 현재의 NULL·분모 규칙을 유지한다. 모델별 요청 수·시간은 같은 turn이 모델마다 포함되므로 모델 집계의 건수를 합쳐 전체 요청 건수로 쓰지 않는다.

## 측정 방법과 정확성

rollup 측정 시작: 2026-10-15 21:33:36 (Asia/Seoul). v24.19.0, SQLite 3.53.3, Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz, Windows x64, schema 10. 요청 280·100,000행 각각 세션당 10·100turn을 비교하고, 280행의 세션당 1turn 사례를 별도로 측정했다.

준비 1회·교대 표본 3개이며 짧은 조회는 여러 번 실행한 평균을 표본으로 사용했다. 느린 원본 전체 집계와 시간 밖의 전체 결과 검증을 함께 수행하므로 반복 표본을 3개로 제한했다. 모든 조회 시간은 준비된 SQL의 최대 100행 반환 + 전체 그룹 COUNT를 합친 warm-cache 중앙값이다. 원시 JSON에 rows/count 개별 시간·P10/P90·원시 표본·SQL·EXPLAIN QUERY PLAN·EXPLAIN opcode 집계를 보관했다.

이번 합성 fixture는 cache/duration NULL, 미기록 모델·미상 모델, 다중 모델과 진단 상태를 추가했다. 부록 B의 인덱스 실험과 fixture·실행 시각이 다르므로 개선 증감률은 이번 A와 B끼리 계산한다. 두 비교군은 같은 fixture의 SQLite backup 사본이며 모두 ANALYZE했다. 원본 로그 파싱·IPC·UI·SQL 준비·계획 조회·정확성 검증·최초 rollup 구축은 반복 조회 시간에서 제외했다.

- 5개 데이터 분포 × 15개 조회, 총 75개 A/B에서 페이지뿐 아니라 전체 그룹의 모든 출력 필드와 그룹 COUNT를 비교했다. 정수·건수는 정확히 일치해야 하고 평균의 부동소수 값만 절대/상대 허용오차 `1e-9`를 사용했다. 원시 결과의 해시는 비교 기준 출력의 정규화 해시다.
- 작은 3개 분포에서 제공자/모델 × 5개 grouping × 빈 사용량 포함/제외 × 시각 미상 4정책의 80조합과 fallback 2조합, 총 246개 의미 검증을 수행했다. 추가 고정 fixture의 독립 기대값·80조합 비교와 별도 단위 테스트 5개로 가중평균, NULL 표본, 다중 모델 건수, 경계 배제, 이름 필터와 기간 밖 세션 시작 시각을 검증했다.
- 실제 세션 변경·삭제·과거 날짜 수정·프로젝트 이동 후 전체 통계를 원본 SQL과 대조했다. 집계 갱신 후 COMMIT 직전 실패를 주입하여 rollback을 확인하고, 보조 검증에서 요청·모델·비용·프로젝트·세션·두 rollup을 포함한 모든 영속 테이블의 전체 열·행이 원복되는 것도 확인했다.
- 별도 WAL reader가 쓰기 도중과 COMMIT 뒤에도 이전 read transaction의 스냅샷을 유지하고, 새 read transaction에서는 요청과 rollup이 함께 반영된 상태를 읽는 것을 확인했다. 여러 writer의 실제 경합 부하·전원 손실·checkpoint 포함 장시간 처리량은 측정하지 않았다.
- 후보는 `Asia/Seoul`, 비용 미포함 통계를 사전 집계한다. 다른 시간대나 API 비용 포함 요청은 기존 SQL로 fallback하며 이를 검증했다. 다른 시간대의 rollup 재구축, Skill 집계, 모델 여러 개 선택 후 고유 turn을 중복 제거하는 통계는 이번 가속 범위에 포함하지 않았다. 모델별 조회는 기존 기능과 같은 모든 모델 GROUP BY이며, 모델 조건으로 먼저 진입하는 전용 인덱스의 효과는 측정하지 않았다.
- 당시 타입 검사·린트·테스트를 포함한 `npm run check`에서 251개 테스트가 통과했다. 제품 schema·SQL·worker 동작은 변경하지 않았고 설치·패키징·커밋은 수행하지 않았다.

결과 캐시는 도입하지 않았다. 제품 적용 전에는 지원할 시간대·비용 통계의 상태와 기존 필터 계약을 정하고 실제 세션 길이·날짜·모델 분포 및 갱신 빈도에서 후보를 검증할 수 있다. 이하의 기록은 후보 측정 당시의 범위이며, 실제 제품 적용 결과는 문서 앞부분에서 별도로 확인한다.

## 보조 관측: 프로세스 메모리

전체 결과 검증과 fixture를 같은 프로세스에 계속 보관한 주 실행기의 RSS는 A/B 메모리 비교에 사용하지 않았다. 별도 측정에서는 fixture·집계 구축을 부모에서 끝낸 뒤 조건·변형마다 새 자식 프로세스 하나를 순차 실행했다. SQL 준비 후 동일하게 GC 1회를 실행하고, 제품과 같은 최대 100행 + COUNT를 준비 1회·반복 3회 실행했다.

| 요청 수 / 세션당 turn | 조회 | A peak RSS MiB | B peak RSS MiB |
| --- | --- | ---: | ---: |
| 280 / 100 | 전체 토큰·평균 | 47.33 | 47.34 |
| 280 / 100 | 전체 모델별 토큰·평균 | 47.54 | 47.39 |
| 280 / 100 | 전 기간 월별 | 50.16 | 47.39 |
| 100,000 / 100 | 전체 토큰·평균 | 52.10 | 48.39 |
| 100,000 / 100 | 전체 모델별 토큰·평균 | 57.09 | 50.70 |
| 100,000 / 100 | 전 기간 월별 | 211.40 | 48.67 |

표는 프로세스 생애 최대 RSS의 단일 프로세스 관측이다. 런타임 시작·SQLite 연결·page cache·정렬·결과 배열이 포함되고, 쿼리만의 peak scratch나 할당 바이트를 뜻하지 않는다. 크기·조회별 새 프로세스 반복 표본을 여러 개 모은 신뢰 구간은 아니다. DB 영속 공간과 조회 보조 메모리는 구분해서 판단한다.

## 재실행과 원본

아래 rollup 명령은 기존 인덱스 실험의 JSON/표를 덮어쓰지 않는다. 이번 문서 재배치에서는 성능 측정이나 제품 테스트를 다시 실행하지 않았다.

```powershell
npm.cmd run benchmark:sql:rollup
node tests/benchmarks/sql-rollup-validation.cjs --append
node tests/benchmarks/sql-rollup-memory.cjs
npm.cmd run check
```

[rollup A/B 원시 결과·소스 hash·전체 계획·표본 JSON](SqlRollupABBenchmark-2026-10-15.json), [비교 실행기](../../tests/benchmarks/sql-rollup.cjs), [집계 후보](../../tests/benchmarks/sql-rollup-prototype.cjs), [독립 기대값·rollback 검증](../../tests/benchmarks/sql-rollup-validation.cjs), [프로세스별 메모리 측정](../../tests/benchmarks/sql-rollup-memory.cjs), [단위 테스트](../../tests/node/sql-rollup-oracle.test.ts).

</details>

## 부록 A: 후보 단계 rollup A/B 전체 조회표

본문은 시간·공간·쓰기의 주요 비교를 먼저 보여준다. 아래 표는 기존 15개 조회 조건을 빠짐없이 보존한 상세 자료다. 증감률이 양수이면 B가 느리다.

<details>
<summary>세션당 10·100turn: 소량·대량 15개 조회 전체 결과</summary>

세션당 10turn. 단위 ms, 증감률은 (B−A)/A × 100이며 양수이면 B가 느리다.

| 조회 | 280행 A→B ms | 증감률 | 100K A→B ms | 증감률 |
| --- | ---: | ---: | ---: | ---: |
| 전체 토큰·평균 | 2.277→0.295 | -87.04% | 945.118→19.168 | -97.97% |
| 전체 모델별 토큰·평균 | 2.921→0.556 | -80.96% | 1113.648→106.146 | -90.47% |
| 전 기간 월별 | 7.972→0.463 | -94.19% | 2465.770→45.033 | -98.17% |
| 전 기간 월별·모델별 | 8.255→0.666 | -91.93% | 2518.445→121.578 | -95.17% |
| 최근 7일·부분 날짜 | 1.445→1.236 | -14.44% | 187.751→51.635 | -72.50% |
| 최근 7일·부분 날짜·모델별 | 1.747→1.750 | +0.16% | 216.400→91.028 | -57.94% |
| 최근 7일·시각 미상 제외 | 1.123→1.139 | +1.43% | 170.052→43.467 | -74.44% |
| 특정 프로젝트 최근 30일 | 0.422→0.718 | +70.26% | 7.660→1.267 | -83.46% |
| 특정 프로젝트 최근 30일·모델별 | 0.659→0.888 | +34.70% | 4.824→2.668 | -44.69% |
| 전체 세션별 | 3.545→0.633 | -82.14% | 438.323→71.671 | -83.65% |
| 전체 세션·모델별 | 4.312→2.116 | -50.93% | 1379.831→209.771 | -84.80% |
| 특정 세션 | 0.550→0.290 | -47.17% | 0.477→0.293 | -38.58% |
| 프로젝트별 평균 순위 | 2.751→0.611 | -77.78% | 850.789→27.205 | -96.80% |
| 자정 경계 7일 | 1.459→0.363 | -75.15% | 195.003→11.485 | -94.11% |
| 자정 경계 7일·모델별 | 3.481→1.163 | -66.58% | 224.923→32.993 | -85.33% |

세션당 100turn. 단위 ms, 증감률은 (B−A)/A × 100이며 양수이면 B가 느리다.

| 조회 | 280행 A→B ms | 증감률 | 100K A→B ms | 증감률 |
| --- | ---: | ---: | ---: | ---: |
| 전체 토큰·평균 | 2.885→0.302 | -89.54% | 863.532→3.762 | -99.56% |
| 전체 모델별 토큰·평균 | 2.647→0.415 | -84.31% | 944.236→19.403 | -97.95% |
| 전 기간 월별 | 6.278→0.315 | -94.98% | 2614.903→8.145 | -99.69% |
| 전 기간 월별·모델별 | 7.065→0.519 | -92.65% | 2671.642→21.512 | -99.19% |
| 최근 7일·부분 날짜 | 2.138→2.859 | +33.68% | 178.419→43.764 | -75.47% |
| 최근 7일·부분 날짜·모델별 | 2.454→4.038 | +64.53% | 207.208→54.571 | -73.66% |
| 최근 7일·시각 미상 제외 | 2.100→2.718 | +29.44% | 176.918→42.227 | -76.13% |
| 특정 프로젝트 최근 30일 | 1.022→0.663 | -35.16% | 8.381→1.118 | -86.66% |
| 특정 프로젝트 최근 30일·모델별 | 1.273→0.897 | -29.54% | 8.548→1.505 | -82.39% |
| 전체 세션별 | 3.269→0.488 | -85.06% | 454.091→21.210 | -95.33% |
| 전체 세션·모델별 | 3.508→0.981 | -72.04% | 1175.514→52.521 | -95.53% |
| 특정 세션 | 1.214→0.260 | -78.61% | 1.568→0.307 | -80.44% |
| 프로젝트별 평균 순위 | 2.870→0.633 | -77.95% | 840.885→3.759 | -99.55% |
| 자정 경계 7일 | 2.082→0.562 | -73.01% | 193.450→5.696 | -97.06% |
| 자정 경계 7일·모델별 | 3.195→0.347 | -89.15% | 255.488→11.239 | -95.60% |

</details>

### 전체 규모의 공간과 최초 구축

소량 DB는 KiB로 표시해 반올림에 따른 A/B 차이 혼동을 줄였다. 집계 표/인덱스는 KiB이며 전체 DB 증가는 메타데이터 증가도 포함한다. 최초 구축은 각 조건에서 1회 관측이다.

| 요청 수 / 세션당 turn | A DB | B DB | 추가 공간 | DB 증감률 | 집계 표 / 인덱스 KiB | 최초 구축 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 280 / 10 | 160.00KiB | 228.00KiB | +68.00KiB | +42.50% | 32.0 / 32.0 | 18.401 |
| 280 / 100 | 160.00KiB | 188.00KiB | +28.00KiB | +17.50% | 8.0 / 16.0 | 14.368 |
| 100,000 / 10 | 29.95MiB | 41.96MiB | +12.01MiB | +40.10% | 7232.0 / 5064.0 | 4563.341 |
| 100,000 / 100 | 29.46MiB | 31.75MiB | +2.29MiB | +7.78% | 1416.0 / 928.0 | 3600.667 |
| 280 / 1 | 172.00KiB | 384.00KiB | +212.00KiB | +123.26% | 112.0 / 96.0 | 15.081 |

### 전체 규모의 세션 교체

| 요청 수 / 세션당 turn | 작업 | A→B ms | 추가 ms | WAL A→B KiB |
| --- | --- | ---: | ---: | ---: |
| 280 / 10 | 같은 세션 재설치 | 2.095→3.469 | 1.374 | 24.2→48.3 |
| 280 / 10 | 1turn 추가 후 세션 교체 | 1.767→3.684 | 1.917 | 28.2→56.4 |
| 280 / 100 | 같은 세션 재설치 | 8.151→12.367 | 4.216 | 96.6→120.7 |
| 280 / 100 | 1turn 추가 후 세션 교체 | 8.018→10.839 | 2.820 | 100.6→124.8 |
| 100,000 / 10 | 같은 세션 재설치 | 1.767→3.204 | 1.437 | 56.4→88.5 |
| 100,000 / 10 | 1turn 추가 후 세션 교체 | 1.671→3.773 | 2.102 | 64.4→112.7 |
| 100,000 / 100 | 같은 세션 재설치 | 9.893→15.020 | 5.127 | 128.8→161.0 |
| 100,000 / 100 | 1turn 추가 후 세션 교체 | 9.181→13.810 | 4.628 | 136.8→181.1 |
| 100,000 / 100 | 과거 날짜 수정 | 9.486→13.617 | 4.131 | 128.8→161.0 |
| 100,000 / 100 | 프로젝트 이동 | 9.351→13.143 | 3.792 | 140.9→173.0 |
| 100,000 / 100 | 세션 삭제 | 3.131→3.945 | 0.815 | 128.8→161.0 |
| 280 / 1 | 같은 세션 재설치 | 1.341→2.136 | 0.795 | 20.1→44.3 |
| 280 / 1 | 1turn 추가 후 세션 교체 | 1.151→2.165 | 1.014 | 24.2→56.4 |

## 부록 B: 기존 인덱스 유지/제거 실험

측정 시작: 2026-10-15 19:09:29 (Asia/Seoul). 이 실험은 rollup 도입 전 날짜·프로젝트 보조 인덱스의 효과를 본 별도 비교다. **여기의 `current`/`secondary-off`는 본문 A/B가 아니다.** Fixture·시각·표본 수가 다르므로 두 실험 간 숫자로 개선 증감률을 계산하지 않는다.

현재 제품의 `buildUsageQuery`와 `buildUsageCountQuery`를 직접 호출했다. 각 측정은 표 최대 100행 조회와 전체 그룹 수 COUNT를 합친 시간이며 평균 토큰·입출력·시간 등의 실제 집계식을 포함한다. SQL 준비·EXPLAIN·데이터 생성·원본 로그 파싱·결과 검증·worker IPC·UI는 측정에서 제외했다.

Node v24.19.0, SQLite 3.53.3, Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz, schema 10.

준비 실행 2회, 표본 9개. 짧은 조회는 표본당 여러 번 실행한 평균을 사용하고 current/secondary-off 순서를 교대했다. 아래는 표본 중앙값(ms)이다.

`current`는 제품 인덱스, `secondary-off`는 임시 사본에서 날짜·프로젝트용 인덱스 두 개만 제거한 경우다. 요청 UNIQUE와 모델 PK는 유지한다. 두 사본 모두 ANALYZE를 실행했으며 실제 운영 DB의 통계 상태와 다를 수 있다.

### 기존 인덱스 실험의 관측 결과

실제 로컬 데이터의 약 280개는 요청 facts가 아니라 대화 로그 파일 수다. Claude 22개와 Codex 262개, 총 284개를 현재 파서로 수집한 결과 세션 246개·요청 요약 874행·모델 요약 769행이었다. 수집 실패는 0개다. 설치된 확장의 영속 DB는 표준 VS Code 사용자 저장소에서 발견되지 않아 로컬 로그를 별도 임시 DB로 수집했다.

아래는 모두 현재 제품 인덱스를 유지한 조회 중앙값이며 단위는 ms다.

| 조회 | 합성 요청 280행 | 합성 요청 100,000행 | 실제 요청 874행 |
| --- | ---: | ---: | ---: |
| 전체 토큰·평균 | 2.697 | 957.887 | 7.077 |
| 전체 모델별 토큰·평균 | 3.242 | 1020.283 | 7.051 |
| 전 기간 월별 토큰·평균 | 6.578 | 2165.324 | 17.448 |
| 특정 프로젝트 최근 30일 | 0.438 | 7.370 | 1.934 |
| 특정 세션 | 0.486 | 0.407 | 0.788 |

전체 조회는 `SEARCH t USING INDEX idx_summary_project_period (provider=?)`지만 두 제공자를 모두 선택하므로 요청 100,000행 전체가 집계 대상이다. SEARCH라고 표시되는 것만으로 전체 범위를 읽지 않는다고 해석할 수 없다. 월별 조회는 이 범위에 날짜→월 변환과 GROUP BY·ORDER BY용 TEMP B-tree를 추가한다. EXPLAIN은 이 구성을 보여주며 각 구성의 개별 소요 시간은 이 실험으로 분리하지 않았다.

특정 프로젝트+기간은 `SEARCH ... (provider=? AND project_key=? AND started_at_ms>? AND started_at_ms<?)`로 범위를 좁힌다. 합성 100K에서 대상은 834요청이며 현재 인덱스 7.370ms, 두 보조 인덱스 제거 시 58.749ms로 이 조건에서는 약 7.97배 차이가 났다. 반대로 전체 조회는 두 인덱스를 제거한 사본이 765.973ms로 더 빨랐다. 인덱스 추가·삭제의 일괄 결론으로 확대하지 않는다.

특정 세션은 기존 UNIQUE `(provider,session_id,root_turn_id)`의 앞부분을 탐색했다. 합성 데이터는 세션당 10요청으로 만들었기 때문에 100K 데이터에서도 이 조회의 대상은 10요청이다. 실제 선택 세션은 41요청이다. 한 세션에 100K 요청이 몰린 경우를 측정한 수치는 아니다.

요청의 사용량 기록 판정인 `has_model`의 상관 EXISTS가 여러 집계식에서 참조되어, 제공자별 행 조회 계획에 동일한 모델 PK 탐색이 반복해서 나타났다. 실제 반복 실행 횟수는 이 EXPLAIN으로 측정하지 않았다. 추가 개선을 검토한다면 전체 집계 입력 수와 이 반복 참조를 별도로 실험할 수 있다. 이번 작업에서는 제품 SQL·인덱스·rollup을 변경하지 않았다.

합성 데이터는 두 제공자·90일 분포·세션당 10요청이며 일부 다중 모델·0토큰·시간 미상·실패·진행 중 요청을 포함한다. 데이터별 13조건, 총 39조건에서 인덱스 유지/제거 결과의 그룹 수와 모든 반환 필드가 일치했고, 측정 전후 결과도 일치했다. 실제 데이터 원문과 요약 DB는 저장소에 보관하지 않았다.

재실행:

```powershell
npm.cmd run benchmark:sql -- --local-logs
```

스킬은 사용자 전역 `~/.codex/skills/agent-tracker-sql-benchmark/SKILL.md`에 설치했다. 기본 합성 규모는 `--sizes=280,100000`, 반복은 `--samples=9 --warmup=2`다. 원본 로그 수집과 SQL 실행 시간은 별개다.

### 기존 인덱스 실험의 데이터 규모

| 데이터 | 요청 facts | 모델 facts | 세션 | 원본 파일 |
| --- | ---: | ---: | ---: | ---: |
| synthetic-280 | 280 | 330 | 28 | 0 |
| synthetic-100000 | 100000 | 118292 | 10000 | 0 |
| local | 874 | 769 | 246 | 284 |

### synthetic-280 인덱스 비교

| 조회 | current ms | secondary-off ms | 인덱스 제거 증감률 | 전체 그룹 |
| --- | ---: | ---: | ---: | ---: |
| total-provider | 2.697 | 2.925 | +8.46% | 2 |
| total-model | 3.242 | 3.265 | +0.70% | 9 |
| month-provider | 6.578 | 6.136 | -6.72% | 7 |
| month-model | 8.963 | 9.494 | +5.92% | 26 |
| day-7-provider | 1.219 | 1.258 | +3.18% | 4 |
| day-7-model | 1.980 | 1.920 | -3.04% | 9 |
| day-7-known-provider | 1.179 | 1.302 | +10.46% | 3 |
| project-30-provider | 0.438 | 0.525 | +19.69% | 1 |
| project-30-model | 0.660 | 0.853 | +29.21% | 2 |
| sessions-provider | 3.525 | 3.619 | +2.67% | 28 |
| sessions-model | 3.675 | 3.315 | -9.80% | 60 |
| one-session-provider | 0.486 | 0.485 | -0.22% | 1 |
| project-average-provider | 3.041 | 3.707 | +21.89% | 28 |

### synthetic-100000 인덱스 비교

| 조회 | current ms | secondary-off ms | 인덱스 제거 증감률 | 전체 그룹 |
| --- | ---: | ---: | ---: | ---: |
| total-provider | 957.887 | 765.973 | -20.04% | 2 |
| total-model | 1020.283 | 859.627 | -15.75% | 10 |
| month-provider | 2165.324 | 2076.372 | -4.11% | 8 |
| month-model | 2377.002 | 2347.822 | -1.23% | 40 |
| day-7-provider | 185.615 | 285.157 | +53.63% | 9 |
| day-7-model | 211.650 | 298.114 | +40.85% | 31 |
| day-7-known-provider | 166.964 | 270.241 | +61.86% | 7 |
| project-30-provider | 7.370 | 58.749 | +697.12% | 1 |
| project-30-model | 7.575 | 77.132 | +918.23% | 5 |
| sessions-provider | 441.735 | 332.364 | -24.76% | 10000 |
| sessions-model | 1334.748 | 1136.385 | -14.86% | 21220 |
| one-session-provider | 0.407 | 0.434 | +6.59% | 1 |
| project-average-provider | 787.604 | 943.597 | +19.81% | 40 |

### local 인덱스 비교

| 조회 | current ms | secondary-off ms | 인덱스 제거 증감률 | 전체 그룹 |
| --- | ---: | ---: | ---: | ---: |
| total-provider | 7.077 | 6.995 | -1.16% | 2 |
| total-model | 7.051 | 7.071 | +0.29% | 10 |
| month-provider | 17.448 | 17.055 | -2.25% | 6 |
| month-model | 17.405 | 17.154 | -1.44% | 21 |
| day-7-provider | 2.837 | 3.125 | +10.14% | 7 |
| day-7-model | 2.976 | 3.116 | +4.71% | 12 |
| day-7-known-provider | 2.180 | 2.272 | +4.24% | 6 |
| project-30-provider | 1.934 | 2.226 | +15.09% | 1 |
| project-30-model | 1.952 | 2.342 | +19.98% | 4 |
| sessions-provider | 5.118 | 5.028 | -1.75% | 246 |
| sessions-model | 11.052 | 10.947 | -0.95% | 302 |
| one-session-provider | 0.788 | 0.775 | -1.64% | 1 |
| project-average-provider | 7.786 | 8.674 | +11.40% | 15 |

### 기존 실행계획의 해석 범위

- EXPLAIN QUERY PLAN은 선택한 계획이다. 실행한 행 수·디스크 I/O·실측 시간을 직접 제공하지 않는다. bytecode 명령 수도 실행 횟수가 아니다.
- SEARCH는 키 조건 탐색, SCAN은 테이블 또는 인덱스 순회다. SCAN USING INDEX도 전체 인덱스 순회일 수 있다. 이름·모델 등의 보조 테이블 SEARCH와 요청 facts의 탐색을 구분한다.
- USE TEMP B-TREE는 GROUP BY/ORDER BY용 임시 구조다. 디스크 유출이나 실제 TEMP 최대 공간을 입증하지 않는다.
- 전 기간 SUM/AVG는 대상 facts를 읽어야 한다. LIMIT 100은 반환 그룹 수를 제한하며 집계 입력을 100행으로 제한하지 않는다.
- 반복 조회로 캐시가 따뜻해진 상태다. OS 캐시를 비우지 않았으므로 cold 디스크 벤치마크가 아니다. 두 인덱스를 동시에 제거한 비교이므로 각 인덱스 단독 기여나 최적 인덱스 설계를 입증하지 않는다.
- 작은 수치 차이와 증감률만으로 개선을 확정하지 않는다. JSON의 P10/P90과 raw samples, 선택된 행 비율, 계획을 함께 본다. 실행 순서·세션 수·모델 수·데이터 분포에 따라 결과가 달라진다.
- 실제 데이터의 제목·프로젝트 경로·세션 ID·대화 본문은 보고하지 않는다. 로컬 로그 수집에는 제공자 서버 호출이 없다.

[전체 계획·SQL·표본 JSON](SqlExplainBenchmark-2026-10-15.json)

## 부록 C: 접어 둔 실행계획 원문

기존 인덱스 실험에서 기록한 `current`의 39개 행 조회 계획을 원문 그대로 보존했다. `SEARCH`는 키 탐색이라는 뜻이며 선택 범위 전체를 집계하지 않는다는 뜻은 아니다. 실행계획은 실제 행 방문 횟수나 실행 시간을 직접 계측하지 않는다. Rollup A/B의 전체 SQL·양쪽 계획·opcode·표본은 [별도 원시 JSON](SqlRollupABBenchmark-2026-10-15.json)에 있다.

<details>
<summary>synthetic-280 / total-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
```

</details>

<details>
<summary>synthetic-280 / total-model 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
SEARCH m USING PRIMARY KEY (turn_id=?) LEFT-JOIN
USE TEMP B-TREE FOR GROUP BY
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-280 / month-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-280 / month-model 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
SEARCH m USING PRIMARY KEY (turn_id=?) LEFT-JOIN
USE TEMP B-TREE FOR GROUP BY
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-280 / day-7-provider 실행계획</summary>

```text
MULTI-INDEX OR
INDEX 1
SEARCH t USING INDEX idx_summary_period (started_at_ms>? AND started_at_ms<?)
INDEX 2
SEARCH t USING INDEX idx_summary_period (started_at_ms=? AND provider=?)
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-280 / day-7-model 실행계획</summary>

```text
MULTI-INDEX OR
INDEX 1
SEARCH t USING INDEX idx_summary_period (started_at_ms>? AND started_at_ms<?)
INDEX 2
SEARCH t USING INDEX idx_summary_period (started_at_ms=? AND provider=?)
SEARCH m USING PRIMARY KEY (turn_id=?) LEFT-JOIN
USE TEMP B-TREE FOR GROUP BY
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-280 / day-7-known-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_period (started_at_ms>? AND started_at_ms<?)
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-280 / project-30-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=? AND project_key=? AND started_at_ms>? AND started_at_ms<?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
```

</details>

<details>
<summary>synthetic-280 / project-30-model 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=? AND project_key=? AND started_at_ms>? AND started_at_ms<?)
SEARCH m USING PRIMARY KEY (turn_id=?) LEFT-JOIN
USE TEMP B-TREE FOR GROUP BY
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-280 / sessions-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH p USING PRIMARY KEY (project_key=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH s USING PRIMARY KEY (provider=? AND session_id=?)
CORRELATED SCALAR SUBQUERY 3
SEARCH t USING INDEX sqlite_autoindex_turn_summary_1 (provider=? AND session_id=?)
```

</details>

<details>
<summary>synthetic-280 / sessions-model 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
SEARCH m USING PRIMARY KEY (turn_id=?) LEFT-JOIN
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 1
SEARCH p USING PRIMARY KEY (project_key=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH s USING PRIMARY KEY (provider=? AND session_id=?)
CORRELATED SCALAR SUBQUERY 3
SEARCH t USING INDEX sqlite_autoindex_turn_summary_1 (provider=? AND session_id=?)
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-280 / one-session-provider 실행계획</summary>

```text
SEARCH t USING INDEX sqlite_autoindex_turn_summary_1 (provider=? AND session_id=?)
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH p USING PRIMARY KEY (project_key=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH s USING PRIMARY KEY (provider=? AND session_id=?)
CORRELATED SCALAR SUBQUERY 3
SEARCH t USING INDEX sqlite_autoindex_turn_summary_1 (provider=? AND session_id=?)
```

</details>

<details>
<summary>synthetic-280 / project-average-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH p USING PRIMARY KEY (project_key=?)
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-100000 / total-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
```

</details>

<details>
<summary>synthetic-100000 / total-model 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
SEARCH m USING PRIMARY KEY (turn_id=?) LEFT-JOIN
USE TEMP B-TREE FOR GROUP BY
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-100000 / month-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-100000 / month-model 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
SEARCH m USING PRIMARY KEY (turn_id=?) LEFT-JOIN
USE TEMP B-TREE FOR GROUP BY
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-100000 / day-7-provider 실행계획</summary>

```text
MULTI-INDEX OR
INDEX 1
SEARCH t USING INDEX idx_summary_period (started_at_ms>? AND started_at_ms<?)
INDEX 2
SEARCH t USING INDEX idx_summary_period (started_at_ms=? AND provider=?)
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-100000 / day-7-model 실행계획</summary>

```text
MULTI-INDEX OR
INDEX 1
SEARCH t USING INDEX idx_summary_period (started_at_ms>? AND started_at_ms<?)
INDEX 2
SEARCH t USING INDEX idx_summary_period (started_at_ms=? AND provider=?)
SEARCH m USING PRIMARY KEY (turn_id=?) LEFT-JOIN
USE TEMP B-TREE FOR GROUP BY
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-100000 / day-7-known-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (ANY(provider) AND ANY(project_key) AND started_at_ms>? AND started_at_ms<?)
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-100000 / project-30-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=? AND project_key=? AND started_at_ms>? AND started_at_ms<?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
```

</details>

<details>
<summary>synthetic-100000 / project-30-model 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=? AND project_key=? AND started_at_ms>? AND started_at_ms<?)
SEARCH m USING PRIMARY KEY (turn_id=?) LEFT-JOIN
USE TEMP B-TREE FOR GROUP BY
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-100000 / sessions-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH p USING PRIMARY KEY (project_key=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH s USING PRIMARY KEY (provider=? AND session_id=?)
CORRELATED SCALAR SUBQUERY 3
SEARCH t USING INDEX sqlite_autoindex_turn_summary_1 (provider=? AND session_id=?)
```

</details>

<details>
<summary>synthetic-100000 / sessions-model 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
SEARCH m USING PRIMARY KEY (turn_id=?) LEFT-JOIN
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 1
SEARCH p USING PRIMARY KEY (project_key=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH s USING PRIMARY KEY (provider=? AND session_id=?)
CORRELATED SCALAR SUBQUERY 3
SEARCH t USING INDEX sqlite_autoindex_turn_summary_1 (provider=? AND session_id=?)
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>synthetic-100000 / one-session-provider 실행계획</summary>

```text
SEARCH t USING INDEX sqlite_autoindex_turn_summary_1 (provider=? AND session_id=?)
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH p USING PRIMARY KEY (project_key=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH s USING PRIMARY KEY (provider=? AND session_id=?)
CORRELATED SCALAR SUBQUERY 3
SEARCH t USING INDEX sqlite_autoindex_turn_summary_1 (provider=? AND session_id=?)
```

</details>

<details>
<summary>synthetic-100000 / project-average-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH p USING PRIMARY KEY (project_key=?)
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>local / total-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
```

</details>

<details>
<summary>local / total-model 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
SEARCH m USING PRIMARY KEY (turn_id=?) LEFT-JOIN
USE TEMP B-TREE FOR GROUP BY
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>local / month-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>local / month-model 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
SEARCH m USING PRIMARY KEY (turn_id=?) LEFT-JOIN
USE TEMP B-TREE FOR GROUP BY
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>local / day-7-provider 실행계획</summary>

```text
MULTI-INDEX OR
INDEX 1
SEARCH t USING INDEX idx_summary_period (started_at_ms>? AND started_at_ms<?)
INDEX 2
SEARCH t USING INDEX idx_summary_period (started_at_ms=? AND provider=?)
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>local / day-7-model 실행계획</summary>

```text
MULTI-INDEX OR
INDEX 1
SEARCH t USING INDEX idx_summary_period (started_at_ms>? AND started_at_ms<?)
INDEX 2
SEARCH t USING INDEX idx_summary_period (started_at_ms=? AND provider=?)
SEARCH m USING PRIMARY KEY (turn_id=?) LEFT-JOIN
USE TEMP B-TREE FOR GROUP BY
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>local / day-7-known-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_period (started_at_ms>? AND started_at_ms<?)
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>local / project-30-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=? AND project_key=? AND started_at_ms>? AND started_at_ms<?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH m USING PRIMARY KEY (turn_id=?)
```

</details>

<details>
<summary>local / project-30-model 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=? AND project_key=? AND started_at_ms>? AND started_at_ms<?)
SEARCH m USING PRIMARY KEY (turn_id=?) LEFT-JOIN
USE TEMP B-TREE FOR GROUP BY
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>local / sessions-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH p USING PRIMARY KEY (project_key=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH s USING PRIMARY KEY (provider=? AND session_id=?)
CORRELATED SCALAR SUBQUERY 3
SEARCH t USING INDEX sqlite_autoindex_turn_summary_1 (provider=? AND session_id=?)
```

</details>

<details>
<summary>local / sessions-model 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
SEARCH m USING PRIMARY KEY (turn_id=?) LEFT-JOIN
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 1
SEARCH p USING PRIMARY KEY (project_key=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH s USING PRIMARY KEY (provider=? AND session_id=?)
CORRELATED SCALAR SUBQUERY 3
SEARCH t USING INDEX sqlite_autoindex_turn_summary_1 (provider=? AND session_id=?)
USE TEMP B-TREE FOR ORDER BY
```

</details>

<details>
<summary>local / one-session-provider 실행계획</summary>

```text
SEARCH t USING INDEX sqlite_autoindex_turn_summary_1 (provider=? AND session_id=?)
USE TEMP B-TREE FOR GROUP BY
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 4
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH p USING PRIMARY KEY (project_key=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH s USING PRIMARY KEY (provider=? AND session_id=?)
CORRELATED SCALAR SUBQUERY 3
SEARCH t USING INDEX sqlite_autoindex_turn_summary_1 (provider=? AND session_id=?)
```

</details>

<details>
<summary>local / project-average-provider 실행계획</summary>

```text
SEARCH t USING INDEX idx_summary_project_period (provider=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH m USING PRIMARY KEY (turn_id=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH p USING PRIMARY KEY (project_key=?)
USE TEMP B-TREE FOR ORDER BY
```

</details>
