# 요청 제목 TEMP 인덱스: 실제 갱신·트랜잭션 측정

측정 시각: 2026-10-08 22:56:29 (Asia/Seoul). 입력: 실제 로컬 Claude·Codex JSONL의 고정 사본. 3쌍을 순차 실행했고 모든 쌍의 요청·토큰·제목·상태·모델·비용·Skill·이름·진단 결과 digest가 일치했다.

## 선택과 근거

사용자는 개인용·간헐적 통계 갱신에서 상시 인덱스 유지보다 갱신 중 메모리를 우선하여 **A: TEMP partial index**를 선택했다. 제목이 있는 메인 이벤트만 `component_events(root_id,id) WHERE is_main=1 AND request_title IS NOT NULL`로 인덱싱하며, 기존 최초 제목 선택 SQL을 유지한다. 제목 Map을 추가하지 않고 SQLite의 FILE TEMP와 기존 100행 단위 결과 읽기를 사용한다. component 재생성·staging 종료 시 인덱스가 제거되며 영속 schema·parser version은 변경하지 않는다.

검토한 B는 기존 roots 집계에 최초 제목 이벤트 ID를 포함한 뒤 events의 기본 키로 제목을 JOIN한다. B도 JS HashSet/Map을 사용하지 않는다. [앞선 2,000개 A/B 실험](RequestTitleAB.md)에서 B는 집계 시간과 TEMP live 공간이 적었고 A는 관측 RSS가 작았다. 그 RSS 차이는 fixture·결과 검증까지 포함한 process 값이므로 알고리즘 고유 메모리 차이로 확정하지 않는다. 이번에는 **최적화 전 무인덱스 SQL과 실제 구현 A**를 동일한 원본으로 비교했다. B와 A 비교 수치에 이번 결과를 섞지 않는다.

이번 최적화의 대상은 한 prepared_turns SQL 안에서 요청마다 실행되는 제목 상관 서브쿼리의 반복 탐색 비용이다. 프로젝트·세션 이름의 기존 정규화와 요청별 제목 탐색은 별도 경로다.

## 시간·공간 복잡도 모델

component별 E=이벤트 수, T=제목이 있는 메인 이벤트 수, R=출력 요청 수다. 전체 parser와 집계의 비용은 공통이며 아래는 제목 찾기의 추가 비용이다.

| 방식 | 시간 모델 | 추가 공간 모델 |
|---|---|---|
| 기존 무인덱스 | 제목 탐색의 최악 경우 O(R×E), 정렬 비용은 별도 | 별도 영속 인덱스 없음; 공통 TEMP와 임시 정렬 사용 |
| A TEMP partial index | 구축 O(E + T log T), 요청별 탐색 O(R log T + ΣKᵣ) | O(T×키 폭)의 TEMP B-tree |
| B 기존 집계 통합 | 이미 읽는 행에 O(E) 집계 연산, R번 기본 키 탐색 | 집계 상태·결과에 O(R)의 ID 추가 |

Kᵣ는 root_id를 공유한 후보 중 provider/session 필터를 확인하는 수다. A의 키에 provider/session은 없으므로 해당 검사를 생략하지 않는다. T가 0인 경우 인덱스는 빈 루트 페이지만 사용한다. 공통 events/component_events/winners 등의 TEMP는 행 폭을 W라 할 때 대략 O(E×W)이며 열이 많으면 이 공통 비용이 증가한다. 이 모델은 구현에서 추론한 증가 방식이고, 단일 입력의 실측만으로 Big-O를 입증한 것은 아니다.

FILE TEMP에도 RAM page cache가 있다. main/TEMP cache 각 4 MiB는 전체 process 메모리의 상한이 아니다. 이번 변경은 넓은 이벤트 행의 TEMP 복사 구조를 줄이지 않는다.

영속 교체 transaction은 이미 준비한 요청과 모델·Skill 행을 저장하고 같은 session의 이전 참조 행을 삭제한다. 그 비용은 새 행 수·이전 행 수·관련 DB 인덱스에 따라 달라진다. 제목 인덱스 구축·탐색은 교체 전에 끝나므로 위의 제목 탐색 모델과 교체 transaction 실측을 구분한다.

## 측정 조건과 구간

- Node v24.19.0, SQLite 3.53.3, schema 9, parser 13, win32/x64, Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz.
- JSONL 252개, 269210736 bytes. 파일별 크기를 고정하여 64 KiB씩 복사하고 동일 사본을 모든 실행에서 재사용했다. 활성 대화가 추가되어도 비교 입력은 달라지지 않는다.
- 기본 제공자 데이터 홈/환경 변수의 roots를 사용했다. Codex session_index와 threads의 id/title/name만 사본에 포함하고 credential·네트워크·실계정 quota는 사용하지 않는다. 원본과 설치된 확장 DB는 수정하지 않는다. 입력 사본과 실험 DB는 완료 후 삭제한다.
- 쌍마다 독립 process·새 DB를 사용하고 baseline→A, A→baseline 순서를 교차한다. initial은 빈 DB, rebuild는 manifest parser version만 0으로 만들어 기존 정상 통계를 전체 교체, unchanged는 바로 이어 변경 없이 갱신한다. source body를 바꾸는 증분 append 실험은 이번 범위에 포함하지 않았다.
- baseline은 실제 제품 prepareSummaries SQL에서 새 인덱스 생성문만 제거한 대조군이다. 나머지 SQL hash를 모든 실행에서 대조한다. 이전 schema/parser의 과거 측정과 직접 비교하지 않는다. 명시적 워밍업·OS cache 비우기는 수행하지 않았다.
- prepareSummaries는 명시적 교체 transaction **밖**의 집계 준비다. 로그의 transaction은 실제 BEGIN IMMEDIATE/DEFERRED부터 COMMIT/ROLLBACK까지의 시간이며, replace-sessions와 TEMP parse batch를 구분한다. 전체 refresh는 파싱·공통 집계·교체·측정 관찰 비용을 포함한다.
- work는 전체 시간에서 관찰 함수의 직접 실행 시간을 뺀 참고값이다. 관찰 쿼리가 cache·계획·메모리에 주는 간접 영향은 제거할 수 없다. 주요 비교는 같은 관찰을 수행한 전체 시간과 prepare/교체 구간이다.
- TEMP allocated는 page_count×page_size, live는 dbstat 및 할당 페이지에서 빈 페이지를 뺀 값이다. 논리적 SQLite 페이지 공간이며 실제 TEMP 파일의 디스크 쓰기량·물리 파일 크기와 같다고 보장하지 않는다. SQL 정렬 내부 scratch 공간은 이 값에 모두 포함되지 않는다.
- 관측 RSS는 구간 경계의 process 값이다. process peak RSS는 OS가 제공한 해당 process 수명 전체의 최고값이며 초기화·이전 시나리오·측정·digest 검증을 포함한다. 준비 SQL 구간만의 peak가 아니다. JS heap·SQLite 메모리와 OS cache를 같은 의미로 해석하지 않는다.
- 원시 transaction 로그는 64 KiB 이내 버퍼로 파일에 순차 기록하고 process에는 세 시나리오의 작은 요약만 보관한다. 전체 로그를 메모리에 쌓지 않는다. 실제 로그는 gzip으로 보관하며 UTF-8 JSONL로 풀어 읽을 수 있다.
- TEMP allocated는 같은 DB 연결에서 재사용 가능한 빈 페이지도 포함한다. unchanged에 이전과 같은 allocated 값이 남더라도 제목 인덱스가 다시 생성된 것은 아니다. 종료 시점 live/free와 indexBytes를 로그에서 함께 확인한다.

## 실측 결과

각 값은 3회 중앙값이다. 시간은 ms, 공간은 MiB. TEMP/RSS 관측 최대는 각 실행의 경계 표본 중 최대를 먼저 구하고 그 값의 중앙값을 적었다.

| 시나리오 | 방식 | 전체 갱신 | 관찰 제외 참고 | 집계 준비 합계 | 교체 transaction 합계 | TEMP allocated 관측 최대 | RSS 관측 최대 | process lifetime peak RSS |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| initial | baseline | 15139.454 | 12599.704 | 1454.545 | 752.694 | 10.36 | 143.39 | 143.80 |
| initial | partial-index | 15045.980 | 12562.615 | 1499.680 | 810.928 | 10.36 | 143.19 | 143.33 |
| rebuild | baseline | 14832.290 | 12396.749 | 1698.572 | 728.253 | 10.39 | 202.10 | 209.30 |
| rebuild | partial-index | 14915.821 | 12472.882 | 1684.089 | 836.785 | 10.39 | 193.05 | 193.06 |
| unchanged | baseline | 102.924 | 101.743 | 0.000 | 0.000 | 10.39 | 202.14 | 209.30 |
| unchanged | partial-index | 124.228 | 123.072 | 0.000 | 0.000 | 10.39 | 175.29 | 194.08 |

- initial/baseline: 읽은 본문 269210736 bytes, 파싱 252개, 재사용 0개, 오류 0개, 저장 요청 804개. component별 관측 최대 E=2102, T=13, R=41; 제목 인덱스 관측 최대 0 bytes.
- initial/partial-index: 읽은 본문 269210736 bytes, 파싱 252개, 재사용 0개, 오류 0개, 저장 요청 804개. component별 관측 최대 E=2102, T=13, R=41; 제목 인덱스 관측 최대 4096 bytes.
- rebuild/baseline: 읽은 본문 269210736 bytes, 파싱 252개, 재사용 0개, 오류 0개, 저장 요청 804개. component별 관측 최대 E=2102, T=13, R=41; 제목 인덱스 관측 최대 0 bytes.
- rebuild/partial-index: 읽은 본문 269210736 bytes, 파싱 252개, 재사용 0개, 오류 0개, 저장 요청 804개. component별 관측 최대 E=2102, T=13, R=41; 제목 인덱스 관측 최대 4096 bytes.
- unchanged/baseline: 읽은 본문 0 bytes, 파싱 0개, 재사용 252개, 오류 0개, 저장 요청 804개. component별 관측 최대 E=0, T=0, R=0; 제목 인덱스 관측 최대 0 bytes.
- unchanged/partial-index: 읽은 본문 0 bytes, 파싱 0개, 재사용 252개, 오류 0개, 저장 요청 804개. component별 관측 최대 E=0, T=0, R=0; 제목 인덱스 관측 최대 0 bytes.

- initial: 같은 쌍의 A−이전 전체 시간 차이 중앙값 -93.474ms, 범위 -504.266~164.420ms. 양수는 A가 더 오래 걸린 실행이다.
- rebuild: 같은 쌍의 A−이전 전체 시간 차이 중앙값 93.890ms, 범위 83.076~113.572ms. 양수는 A가 더 오래 걸린 실행이다.
- unchanged: 같은 쌍의 A−이전 전체 시간 차이 중앙값 6.176ms, 범위 2.693~36.556ms. 양수는 A가 더 오래 걸린 실행이다.

E/T/R의 최대값은 각각 구한 값이며 같은 component에서 모두 최대라는 뜻은 아니다. 긴 세션에 2,000개 요청을 넣었던 후보 비교와 실제 component 크기가 다르므로 같은 속도 개선률이나 고정 메모리 절감량을 기대하지 않는다. 3회씩의 실행과 구간 경계 RSS만으로 A의 일반적인 메모리 우위를 확정하지 않는다. 선택 근거는 사용자의 메모리 우선순위이며, 이 실측은 그 선택의 실제 비용을 확인하는 기록이다.

이번 원본에서 최초 갱신의 전체 중앙값은 15.139초→15.046초, 기존 통계 전체 재집계는 14.832초→14.916초였다. 제목 인덱스는 component당 최대 4 KiB이고 TEMP allocated 관측 최대는 두 방식이 같았다. 현재 component는 최대 41개 요청·13개 제목 후보로 탐색 범위가 작아 큰 전체 속도 개선은 확인되지 않았다. 최초 갱신의 process lifetime peak RSS 중앙값도 143.80→143.33 MiB로 비슷했다. 재집계에서 관측한 209.30→193.06 MiB는 앞선 시나리오·GC·공통 파싱·측정까지 포함하므로 제목 인덱스만의 메모리 절감량으로 해석하지 않는다.

오류가 있는 실제 파일은 제품 진단 규칙을 따르며 이전/A에서 오류 수와 진단 digest가 같은지 확인했다. 오류가 있었다면 위 숫자에 그대로 보고한다. unchanged에서는 본문 읽기·집계 준비·제목 인덱스 생성이 모두 0인지 검증했다. 성능 합격 임계값은 두지 않았다.

원시 로그에는 component별 E/T/R, 준비 시간, 실제 transaction 시간, TEMP/main 페이지 사용량, RSS/heap, SQL hash와 전체 결과 digest가 있다. 요청 제목·본문·세션 ID·개인 경로·credential은 기록하지 않는다.

구현 검증은 `npm run check`의 타입 검사·린트·226개 테스트를 통과했다. 긴 세션과 혼합 세션의 각 2,000개 요청에서 무인덱스·A·B의 전체 집계 결과와 독립 기대값을 대조했고, 제품 SQL 계획의 인덱스 사용도 확인했다. 원시 JSONL 59,551행(실제 transaction 56,784행, 집계 준비 2,748행, 갱신 18행, 측정 metadata 1행)을 다시 읽어 JSON 요약 일치·COMMIT 결과·개인 값 필드 미포함을 확인했다.

## 재실행

`npm run benchmark:transactions -- --real --pairs 3 --report docs/RequestTitleTransactions.md`

`--real` 없이 실행하면 개인 파일을 읽지 않는 30개 요청의 합성 검증이다. CI는 이 합성 실행만 검사한다. 기본 보고서는 tests/results/benchmarks에 저장한다.

[원시 JSON](benchmarks/RequestTitleTransactions.json), [transaction JSONL](benchmarks/RequestTitleTransactions.jsonl.gz), [측정 실행기](../tests/benchmarks/summary-transactions.cjs).
