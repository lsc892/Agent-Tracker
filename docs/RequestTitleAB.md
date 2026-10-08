# 요청 제목 TEMP 인덱스와 집계 통합 A/B 검증

측정 시각: 2026-10-08 22:05:00 (Asia/Seoul). 동일한 2000개 요청 케이스를 두 배치 구조에서 검증했다. 제품의 집계 코드는 변경하지 않았다.

## 비교한 로직

- **A — TEMP partial index**: 현재 제목 상관 서브쿼리를 유지하고 `component_events(root_id,id) WHERE is_main=1 AND request_title IS NOT NULL` 인덱스를 추가한다. 인덱스 생성 시간도 측정에 포함한다.
- **B — 기존 집계에 통합**: 현재 `roots GROUP BY`에서 `min(CASE WHEN e.is_main=1 AND e.request_title IS NOT NULL THEN e.id END)`를 함께 구한다. 기존 `events.id INTEGER PRIMARY KEY`로 JOIN해 제목을 가져온다. 별도 Map·제목 테이블·제목 인덱스를 만들지 않는다. 내부 이벤트 ID column은 사용자에게 저장하는 결과 비교에서 제외한다.

두 방식 모두 제공자·세션·요청 식별자로 범위를 구분하고, 제목이 있는 메인 이벤트 중 가장 작은 이벤트 ID를 선택한다. 현재 `prepareSummaries()` SQL을 실행 시 가져와 제목 부분만 치환한다. 원본 SQL의 구조가 달라져 치환 위치가 맞지 않으면 실패한다.

## 입력과 정확성

- 합성 입력: 각 구조 2000개 요청, 9200개 이벤트. 개인 대화·인증 정보·네트워크 호출은 사용하지 않는다.
- **long-session**: Codex의 한 긴 세션에 모든 요청을 배치한다.
- **mixed-sessions**: Claude·Codex와 여러 세션에 배치한다. 제공자 간 session ID, 세션·제공자 간 root ID를 의도적으로 중복한다.
- 각 케이스 종류는 main-title 200개, no-title 200개, subagent-only 200개, subagent-before-main 200개, null-before-title 200개, first-not-alphabetical 200개, unicode 200개, identical-titles 200개, multiple-main-files 200개, ignored-files 200개다.
- 기대 제목은 fixture에서 독립적으로 지정하고, 제목·요청 수·입출력/캐시 토큰·시작/완료 시각·상태·결제 방식을 검사한다.
- `node:test`는 각 구조 2000개 케이스에 대해 최적화하지 않은 현재 제품 SQL, A, B의 모든 집계 결과 column이 같은지도 검사한다. 총 4000개 서로 다른 배치 케이스를 비교한다.
- 벤치마크의 워밍업·측정 모든 실행에서도 기대값을 검사하고, 각 A/B 쌍의 전체 결과 SHA-256 일치를 검사했다. 실패하면 보고서를 성공 결과로 생성하지 않는다.

## 측정 방법

- Node v24.19.0, SQLite 3.53.3, win32/x64, Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz, 논리 CPU 8개.
- 구조별 A·B를 별도 Node process에 둔다. 두 process의 SQL 실행은 순차 실행한다.
- 각 방식 워밍업 4회 후 20쌍 측정한다. 쌍마다 A→B, B→A 순서를 교차한다. 측정 중 두 방식을 동시에 실행하지 않는다.
- 매 실행 새 DB 연결과 TEMP 테이블을 만든다. `temp_store=FILE`, main/TEMP cache 각 4 MiB로 제품 설정을 따른다. process JIT와 OS 캐시가 워밍업된 조건이며 최초 디스크 읽기 성능은 측정하지 않는다.
- 시간 범위: 전체 `prepareSummaries` SQL 실행. 공통 TEMP 복사·인덱스, 토큰 중복 제거, 상태·제목 집계가 포함된다. 입력 이벤트 생성, 정확성 검사, 공간 조회, JSONL 읽기·파싱, 영속 DB 교체, worker IPC, UI 렌더링은 제외한다.
- `performance.now()`로 시간을 측정하고 중앙값·P10·P90과 쌍별 차를 기록한다. P10–P90은 관측 변동 범위이며 신뢰구간이 아니다.
- TEMP live 공간은 `dbstat('temp')`의 실제 할당 페이지 합계다. 추가 live 공간은 집계 완료 후에서 입력 준비 완료 시점을 뺀 값이다. allocated는 `temp.page_count × temp.page_size`이며 재사용 가능한 빈 페이지를 포함한다.

## 시간과 TEMP 공간

시간 단위는 ms, 공간 단위는 KiB다. 전체 갱신 시간이 아니라 위에 정의한 SQL 집계 구간이다.

| 배치 구조 | 방식 | 시간 중앙값 | 시간 P10–P90 | 추가 TEMP live | 전체 TEMP live | TEMP allocated |
|---|---|---:|---:|---:|---:|---:|
| long-session | A: TEMP partial index | 127.102 | 114.356–235.394 | 1932.0 | 3548.0 | 3548.0 |
| long-session | B: 기존 집계에 통합 | 121.463 | 111.033–163.296 | 1888.0 | 3504.0 | 3504.0 |
| mixed-sessions | A: TEMP partial index | 139.588 | 134.918–165.434 | 1972.0 | 3644.0 | 3644.0 |
| mixed-sessions | B: 기존 집계에 통합 | 120.045 | 116.923–163.739 | 1932.0 | 3604.0 | 3604.0 |

- **long-session**: B의 중앙값은 A보다 4.4% 짧았다. 같은 쌍의 A−B 시간 차 중앙값은 13.093ms, P10–P90은 -7.624–70.017ms였다. B의 집계 후 TEMP live 공간은 44 KiB 절약됐다.
- **mixed-sessions**: B의 중앙값은 A보다 14.0% 짧았다. 같은 쌍의 A−B 시간 차 중앙값은 19.615ms, P10–P90은 -11.177–41.903ms였다. B의 집계 후 TEMP live 공간은 40 KiB 절약됐다.

## Process 메모리

단위는 MiB다. SQL 직후 RSS는 같은 시점의 process 전체 사용량 중앙값이다. 최대 RSS는 해당 방식의 격리 process가 워밍업·모든 측정·fixture 준비·결과 검증을 포함해 기록한 최대값이다. SQL 작업만의 최대 메모리나 JS 객체만의 메모리로 해석하지 않는다.

| 배치 구조 | 방식 | SQL 직후 RSS 중앙값 | process 최대 RSS |
|---|---|---:|---:|
| long-session | partial-index | 73.7 | 79.4 |
| long-session | combined-aggregate | 84.0 | 89.5 |
| mixed-sessions | partial-index | 74.1 | 80.0 |
| mixed-sessions | combined-aggregate | 83.9 | 93.0 |

## 해석과 한계

이번 실행에서 `npm run check`의 타입 검사·lint·223개 테스트가 통과했다. 추가한 두 테스트는 각 배치 구조의 2,000개 케이스를 현재 제품 SQL과 A/B 후보에 대조했다. 벤치마크는 구조별·방식별 워밍업 4회와 측정 20회를 포함한 총 96회 실행에서 결과가 모두 일치했다.

**SQL 실행 시간과 집계 후 TEMP 저장 공간을 기준으로 보면 이번 표본은 B가 유리했다.** 시간 중앙값은 긴 세션에서 5.639ms, 여러 세션에서 19.543ms 짧았고, TEMP live 공간은 각각 44 KiB·40 KiB 작았다. 다만 쌍별 시간 차의 P10–P90에는 음수도 포함되므로 매 실행 B가 더 빠르다는 결과는 아니다.

**프로세스 메모리를 최소화하는 기준에서는 이 결과가 다르다.** B의 SQL 직후 RSS 중앙값은 A보다 긴 세션에서 약 10.3 MiB, 여러 세션에서 약 9.8 MiB 높았다. 최대 RSS도 B가 높았다. 이 값에는 런타임·SQLite 할당과 검증용 객체가 포함되므로 증가분 전체를 제목 처리의 필요 메모리로 단정할 수 없다. TEMP 페이지가 줄어든 것을 전체 메모리 감소로 해석하지 않는다.

위 비교는 현재 SQL과 이 합성 데이터에서의 측정 결과다. 두 배치 구조의 결과를 함께 보고 선택한다. 제품 적용 전에는 JSONL 파싱·fork 중복 제거·영속 저장까지 포함한 기존 통합 테스트도 통과해야 한다.

집계 후 TEMP 할당은 정렬 도중 잠깐 생성된 임시 구조의 최대 공간을 측정하지 않는다. RSS에는 Node와 SQLite, fixture·결과 객체가 함께 포함된다. 단일 데이터 크기의 측정만으로 점근적 공간복잡도나 모든 실제 세션에서의 우월성을 증명할 수 없다. 실제 전체 갱신의 다른 단계는 그대로이므로 이 비율을 전체 갱신에 적용하지 않는다.

## 재실행

`npm run benchmark:titles -- --cases 2000 --pairs 20 --warmups 4`

정확성 테스트는 `npm run check`에 포함된다. 시간에 고정된 합격선을 두지 않는다. 기본 Markdown·원시 JSON은 `tests/results/benchmarks/request-titles.md`, `tests/results/benchmarks/request-titles.json`에 저장된다. `--report docs/RequestTitleAB.md`를 추가하면 Markdown과 인접한 `benchmarks/RequestTitleAB.json`에도 보관한다. 원시 JSON에는 개별 시간·공간, SQL hash, 실행 계획이 들어간다.

원시 기록: [측정 JSON](benchmarks/RequestTitleAB.json).

코드: [fixture와 두 SQL](../tests/fixtures/request-title-ab.ts), [정확성 테스트](../tests/node/request-title-ab.test.ts), [A/B 실행기](../tests/benchmarks/request-titles.cjs).
