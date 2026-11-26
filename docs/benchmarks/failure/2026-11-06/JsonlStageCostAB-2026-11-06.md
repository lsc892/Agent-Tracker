# SQL TEMP와 파일 캐시 Map의 구간별 비용 비교

실험 기준일 2026-11-06의 후속 계측. 실행 2026-11-07 11:52:19 → 2026-11-07 12:09:18, Asia/Seoul. A는 기존 SQL TEMP 구현(80fc586), B는 현재 파일 DTO 캐시와 응답별 winner 인덱스다. 기존 DTO 대비 캐시 측정과 섞지 않고 SQL과 현재 Map을 같은 입력·같은 실행 조건에서 직접 비교했다. 제품 소스·빌드는 변경하지 않았다.

## 1. 전체 시간

준비 3쌍을 제외한 AB/BA 10쌍의 중앙값 ms다. 괄호는 (SQL−Map)/SQL의 백분율이며 양수는 Map의 개선이다.

| 항목 | 실제 1,419요청 | 합성 10,000요청 | 합성 100요청 |
| --- | ---: | ---: | ---: |
| 초회 갱신 | 15393.42 → 11605.38 (24.6%) | 5566.57 → 5010.18 (10.0%) | 76.68 → 79.30 (-3.4%) |
| 무변경 갱신 | 149.57 → 201.50 (-34.7%) | 24.77 → 24.08 (2.8%) | 6.24 → 6.04 (3.3%) |
| Claude 1건 추가 | 181.92 → 242.11 (-33.1%) | 82.55 → 88.38 (-7.1%) | 14.82 → 15.03 (-1.5%) |
| Codex 1건 추가 | 279.29 → 317.05 (-13.5%) | 85.59 → 94.92 (-10.9%) | 16.54 → 16.38 (0.9%) |
| Codex 100건 추가 | 334.94 → 365.86 (-9.2%) | 133.21 → 137.47 (-3.2%) | 61.44 → 61.15 (0.5%) |
| Codex 1,000건 추가 | 1543.01 → 1548.22 (-0.3%) | 1227.67 → 1216.83 (0.9%) | 1030.58 → 1021.50 (0.9%) |

## 2. 실제 데이터의 구간별 시간

Codex 1건 추가의 중첩을 제거한 구간별 산술평균 ms다. 평균은 구간 합을 전체와 대조하고 추가 비용을 분해하기 위해 사용했다. 전체 성능 판정의 대표값은 위 중앙값이다. reader 안의 파싱, 파싱 안의 DTO 입력/INSERT, 준비 안의 Map/서명/집계, 저장 안의 metadata commit을 각각 한 번만 집계했다. reader와 JSON 파싱 구간에는 대화뿐 아니라 session_index 이름 읽기·UPSERT도 포함된다. state DB 이름 처리는 reader 밖의 나머지 구간이다. JSON 파싱·adapter 구간에는 SQL의 청크별 BEGIN/COMMIT 또는 Map의 checkpoint 처리와 입력 연결도 포함된다. INSERT 구간은 events statement.run 실행 시간이며 값 변환과 바인딩 인자 배열 구성은 호출부 구간에 남는다. 계측 자체의 호출·시계 비용도 실행 시간에 포함된다.

| 구간 | SQL TEMP ms | 파일 캐시 Map ms | Map − SQL ms |
| --- | ---: | ---: | ---: |
| 읽기·디코딩 등(reader의 나머지) | 14.41 | 16.26 | 1.86 |
| JSON 파싱·adapter·이름 index·입력/청크 처리 | 65.56 | 77.62 | 12.07 |
| DTO 복사·정규화·동등 비교 | 0.00 | 2.12 | 2.12 |
| TEMP events INSERT 실행 | 26.35 | 3.55 | -22.80 |
| 캐시 DTO 재생 | 0.00 | 0.00 | 0.00 |
| 계보·legacy·복사 접두사 | 1.88 | 3.12 | 1.24 |
| Map 후보 관리·winner | 0.00 | 1.66 | 1.66 |
| 선택 DTO 변환·적재 준비 | 0.00 | 3.80 | 3.80 |
| 원본 서명·dirty·의존성 | 16.48 | 14.32 | -2.16 |
| 집계 SQL·준비 연결 | 2.65 | 2.38 | -0.28 |
| 영속 반영·metadata commit | 8.31 | 8.37 | 0.06 |
| 파일 조사·이름 조회·정리 등 나머지 | 145.75 | 184.23 | 38.48 |
| 전체 refresh | 281.42 | 317.47 | 36.05 |

원본 서명·dirty·의존성 구간의 평균 차이는 -2.16ms다. 이 구간에는 SHA만이 아니라 root 구성, JSON payload 생성, flags 조회, signature UPDATE와 의존성 전파 SQL까지 포함된다. 각 하위 연산의 기여율을 따로 측정한 값은 아니다. 나머지 구간의 차이를 Map 연산이나 GC 한 원인으로 귀속하지 않는다.

| 데이터 / Codex 1건 추가 | 파싱 DTO SQL / Map | TEMP INSERT SQL / Map | usage INSERT SQL / Map | Map winner 재계산 / 재사용 |
| --- | ---: | ---: | ---: | ---: |
| current | 672 / 672 | 672 / 672 | 289 / 289 | 1 / 288 |
| synthetic-10000 | 303 / 303 | 303 / 303 | 101 / 101 | 1 / 100 |
| synthetic-100 | 33 / 33 | 33 / 33 | 11 / 11 | 1 / 10 |

실제 1건 추가는 SQL과 Map 모두 TEMP에 672행을 INSERT한다. 기존 288개 응답 winner를 재사용해도 선택 결과 전체의 TEMP 적재가 필요하다. 이 입력은 제거되는 중복이 적으므로 SQL 적재량을 줄이는 이점이 없다. JSON.parse와 DTO의 생성·정규화·동등 비교도 변경 파일 전체에 실행된다.

## 3. 합성 입력의 구간별 시간

### 3.1 기존 10,000요청에 Codex 1건 추가

| 구간 | SQL TEMP ms | 파일 캐시 Map ms | Map − SQL ms |
| --- | ---: | ---: | ---: |
| 읽기·디코딩 등(reader의 나머지) | 0.70 | 0.76 | 0.06 |
| JSON 파싱·adapter·이름 index·입력/청크 처리 | 1.15 | 1.03 | -0.12 |
| DTO 복사·정규화·동등 비교 | 0.00 | 1.02 | 1.02 |
| TEMP events INSERT 실행 | 1.51 | 1.26 | -0.25 |
| 캐시 DTO 재생 | 0.00 | 0.00 | 0.00 |
| 계보·legacy·복사 접두사 | 1.67 | 1.78 | 0.10 |
| Map 후보 관리·winner | 0.00 | 0.41 | 0.41 |
| 선택 DTO 변환·적재 준비 | 0.00 | 0.84 | 0.84 |
| 원본 서명·dirty·의존성 | 23.64 | 23.59 | -0.06 |
| 집계 SQL·준비 연결 | 2.61 | 2.24 | -0.36 |
| 영속 반영·metadata commit | 25.46 | 31.84 | 6.38 |
| 파일 조사·이름 조회·정리 등 나머지 | 28.98 | 31.19 | 2.20 |
| 전체 refresh | 85.76 | 96.00 | 10.24 |

### 3.2 기존 100요청에 Codex 1건 추가

| 구간 | SQL TEMP ms | 파일 캐시 Map ms | Map − SQL ms |
| --- | ---: | ---: | ---: |
| 읽기·디코딩 등(reader의 나머지) | 0.51 | 0.47 | -0.04 |
| JSON 파싱·adapter·이름 index·입력/청크 처리 | 0.27 | 0.19 | -0.08 |
| DTO 복사·정규화·동등 비교 | 0.00 | 0.10 | 0.10 |
| TEMP events INSERT 실행 | 0.14 | 0.12 | -0.02 |
| 캐시 DTO 재생 | 0.00 | 0.00 | 0.00 |
| 계보·legacy·복사 접두사 | 0.55 | 0.49 | -0.06 |
| Map 후보 관리·winner | 0.00 | 0.06 | 0.06 |
| 선택 DTO 변환·적재 준비 | 0.00 | 0.13 | 0.13 |
| 원본 서명·dirty·의존성 | 1.04 | 0.96 | -0.09 |
| 집계 SQL·준비 연결 | 1.13 | 1.00 | -0.13 |
| 영속 반영·metadata commit | 4.17 | 4.11 | -0.06 |
| 파일 조사·이름 조회·정리 등 나머지 | 8.79 | 8.82 | 0.03 |
| 전체 refresh | 16.64 | 16.49 | -0.14 |

### 3.3 실제 데이터의 초회 갱신

| 구간 | SQL TEMP ms | 파일 캐시 Map ms | Map − SQL ms |
| --- | ---: | ---: | ---: |
| 읽기·디코딩 등(reader의 나머지) | 2152.46 | 2136.78 | -15.68 |
| JSON 파싱·adapter·이름 index·입력/청크 처리 | 4771.41 | 3972.34 | -799.08 |
| DTO 복사·정규화·동등 비교 | 0.00 | 91.83 | 91.83 |
| TEMP events INSERT 실행 | 2249.55 | 178.42 | -2071.13 |
| 캐시 DTO 재생 | 0.00 | 0.00 | 0.00 |
| 계보·legacy·복사 접두사 | 241.85 | 39.27 | -202.57 |
| Map 후보 관리·winner | 0.00 | 68.16 | 68.16 |
| 선택 DTO 변환·적재 준비 | 0.00 | 39.52 | 39.52 |
| 원본 서명·dirty·의존성 | 900.82 | 563.90 | -336.93 |
| 집계 SQL·준비 연결 | 383.49 | 300.74 | -82.75 |
| 영속 반영·metadata commit | 2743.26 | 2154.66 | -588.60 |
| 파일 조사·이름 조회·정리 등 나머지 | 2051.71 | 2132.31 | 80.59 |
| 전체 refresh | 15494.82 | 11678.18 | -3816.64 |

전체 시나리오의 세부 exclusiveMs와 호출 수는 [원시 JSON](./JsonlStageCostAB-2026-11-06.json)에 보존했다. 초회에는 모든 요청이 dirty이므로 기존 SQL도 전체 winner 계산을 수행한다. 후속 갱신에서는 dirty 범위가 작아져 SQL과 Map의 처리 순서 차이가 중요해진다.

## 4. 알고리즘상 차이

기존 SQL은 파싱 이벤트를 events TEMP에 바로 넣고 metadata 서명으로 dirty 요청을 먼저 판정한 뒤 component_events를 그 요청들로 좁혀 ROW_NUMBER winner와 집계를 수행한다. INSERT는 청크별 transaction으로 묶으며 행마다 COMMIT하지 않는다. temp_store=FILE이더라도 SQLite page cache를 사용하므로 모든 INSERT가 물리 디스크 쓰기를 기다린다고 해석하면 안 된다.

현재 Map은 파싱 DTO를 복사·정규화하고 이전 DTO와 값을 비교한 뒤 참조를 재사용한다. 영향 DTO 전체로 현재 행 배열·파일별 후보·응답 그룹을 다시 확인하고 dirty bucket의 winner만 재선정한다. 선택 이벤트를 TEMP에 넣은 다음 metadata 서명으로 dirty 요청을 판정한다. 따라서 dirty 범위를 좁히기 전에 영향 DTO 전체의 Map 처리·선택 결과 적재를 수행한다. 이는 SQL의 dirty 후보만 정렬하는 경로와 작업 범위가 다르다.

특히 metadata의 구현이 다르다. SQL은 root별 인덱스 조회로 SQLite json_array 문자열을 한 행씩 받아 SHA에 넣는다. Map은 원본 DTO 전체를 eventValues 배열과 JSON.stringify payload로 변환해 rawTurns에 보관하고 root별 순번 정렬 뒤 SHA에 넣는다. 서명 결과는 같아도 Map에는 문자열·배열·후보 객체 할당과 더 큰 JS 작업 집합이 생긴다. GC 부담 가능성은 있으나 이번 계측은 GC 시간을 분리하지 않았다.

코드 근거: SQL 기준 staging.ts:395–425와 metadata.ts:39–49,84–96. 현재 src/summary/staging.ts:336–347,387–389; metadata.ts:44–75,100–140; memoryEvents.ts:43–61; winnerIndex.ts:33–99,114–139. SQL 실행 계획에서는 component_events_turn/events_response 인덱스와 window ORDER BY의 TEMP B-TREE를 확인했다. Claude의 누락 request ID 보정은 별도 상관 조회를 포함한다.

### 4.1 이름 SQL의 transaction batch가 사라진 부작용

최초 DTO 전환 때 SummaryStaging.batchEvents를 SQL BEGIN/COMMIT에서 메모리 checkpoint로 바꿨다. 이 함수는 scanner의 DTO 파싱뿐 아니라 names.ts:28의 session_index 읽기와 :48의 state DB 제목 100행 처리에도 공용으로 쓰인다. 이름 수집은 같은 연결의 session_names TEMP에 UPSERT하므로 현재 Map에서는 각 statement가 독립 암묵 transaction이 된다. 외부 main transaction은 없고 refresh 잠금은 별도 연결이다. 이는 Map 자료구조의 특성이 아닌 구현 부작용이며 최초 DTO와 현재 캐시 모두 갖고 있다.

이를 분리하기 위해 같은 고정 snapshot seed의 파일 DB 사본을 만들고 전체 무변경 refresh를 준비 3회 뒤 변형별 10회 측정했다. 파일 조사·이름 읽기·계보·정리까지 정상 흐름을 유지했다. SQL, 현재 Map, 이름 수집 callback에만 SQL BEGIN/COMMIT을 복원한 MapBatchedNames를 교대로 실행했다. 제품 소스·빌드는 바꾸지 않았으며 세 변형의 제목·우선순위 전체 hash와 영속 요청 수·토큰이 같다. 실제 connection.isTransaction으로 transaction 내부 실행 여부를 확인했다.

| 무변경 흐름 원인 분리 | 이름 수집 중앙값 ms | 전체 refresh 중앙값 ms | title UPSERT 수 | 명시 transaction 안의 UPSERT 수 | batch callback 수 |
| --- | ---: | ---: | ---: | ---: | ---: |
| SQL | 7.52 | 141.89 | 756 | 756 | 7 |
| Map | 60.99 | 192.78 | 756 | 0 | 7 |
| MapBatchedNames | 7.98 | 137.73 | 756 | 756 | 7 |

Map의 이름 수집만 SQL batch로 묶으면 이름 수집이 약 61→8ms로 줄고 무변경 refresh도 약 193→138ms로 줄었다. 이름 N개를 넣는 Big-O는 비슷하지만 transaction 경계 수가 7개 묶음에서 756개 statement 단위로 늘어난 구현 부작용이다. 이 결과로 Map 자료구조 자체가 전체 지연의 주범이라는 해석을 정정한다. 이 별도 무변경 실험의 시간을 다른 append 표본에서 빼서 보정 성능을 만들지 않는다. TEMP 쓰기의 개별 transaction을 매행 물리 fsync로 해석하지 않는다. 공간은 이름 TEMP O(N)과 state 조회 100행으로 거의 같다. 실패 시 SQL batch rollback이 사라지는 계약 문제도 있으나 이번 정상 입력 비교에서는 실패 복구 동작을 추가 검증하지 않았다. 제품 수정은 수행하지 않았고 batch 복원은 원인 분리 실험에서만 적용했다. [이름 수집 원인 분리 JSON](./JsonlNameBatchDiagnostic-2026-11-06.json)에 결과를 보존했다.

이름 수집만 따로 떼어 수행한 통제 실험에서는 연결·준비 상태가 달라 SQL 약 6ms·Map 약 7ms였다. 그 차이로 전체 refresh 지연을 설명하지 않고 파일 조사 흐름을 유지한 위 실험으로 다시 확인했다. [메모리 DB 통제](./JsonlNameBatchMemoryControl-2026-11-06.json), [파일 DB·빈 scan 통제](./JsonlNameBatchEmptyScanControl-2026-11-06.json), [파일 DB·scan 채움 통제](./JsonlNameBatchPopulatedScanControl-2026-11-06.json)의 원시 값도 보존한다. 연결 상태별 세부 SQLite 내부 비용은 추가 분리하지 않았다.

## 5. 시간·공간복잡도

B_a는 영향 원본 전체 byte, B_c는 실제로 다시 읽는 변경/캐시 미보유 파일 전체 byte다. E_a는 영향 이벤트, E_d는 dirty 요청 이벤트, S_a는 선택된 TEMP 이벤트, E_c는 갱신 사이 전체 보관 DTO 수다. P_a/P_c는 각각 서명용 직렬화 총량/장기 DTO payload 크기, W_Δ는 무효화한 응답 후보 수, F/F_c는 조사 파일/장기 인덱스 파일 수다. 문자열 길이와 SQLite 조인·의존성 비용은 따로 고려한다.

| 단계 | 기존 SQL 시간 | 현재 캐시 Map 시간 | 공간 차이 |
| --- | --- | --- | --- |
| 파일 읽기·파싱 | O(B_a) | O(B_c), 캐시 DTO 재생 O(E_a) | reader 자체는 양쪽 모두 청크·한 줄 예산. Map은 전체 원본 DTO를 장기 보관 |
| 최초 이벤트 입력 | 대략 O(E_a log E_a): events B-tree 인덱스 4개 유지 | 변경 DTO 복사·문자열 정규화·동등 비교, DTO 수와 필드 크기에 비례 | SQL은 TEMP 데이터·인덱스, Map은 원본 객체·래퍼·flags·참조 배열 |
| winner | 일반 Codex 정렬 O(E_d log E_d), Claude 보정 별도 | 기대 O(E_a+F+F_c+W_Δ), 파일 순서 정렬 별도 | Map은 usage 후보와 응답 그룹을 장기 보관, 변경 파일 후보 배열 임시 생성 |
| 원본 서명 | root별 인덱스 조회·SQL JSON 생성·P_a 해시, 관련 SQL | P_a 직렬화·해시 + root별 Σ n_r log n_r 정렬 + 관련 SQL | SQL은 한 행씩 JS에 전달, Map은 추가 JS payload 문자열 O(P_a)·배열 O(E_a) |
| 선택 결과 TEMP 적재 | 앞서 수행 | 대략 O(S_a log S_a) | Map도 TEMP 데이터·인덱스 O(S_a) 필요 |
| 이름 metadata | 이름 N개 UPSERT, transaction은 청크/100행 단위 | 같은 N개 UPSERT, transaction은 statement 단위 | 이름 TEMP O(N)과 state 100행 page는 동일. transaction 경계 상수 비용 증가 |
| dirty 집계·저장 | 변경 요청과 의존성·대상 세션 rollup에 따른 SQL | 같은 dirty/영속 저장 계약 | 공통 DB 비용. 신규 요청 수만으로 전체 복잡도 표현 불가 |

Map의 장기 공간은 DTO 본문 O(P_c)와 O(E_c+사용량 후보 참조+F_c)다. 갱신 중에는 O(P_a+E_a+변경 usage 후보)의 추가 JS 객체·문자열과 TEMP 사본이 겹친다. DTO 본문은 cache와 winner 인덱스가 참조를 공유하므로 두 배 복제라고 계산하지 않는다. SQL은 전체 DTO/payload 문자열을 JS에 장기 보관하지 않으며 TEMP의 논리 공간은 이벤트·인덱스·dirty 작업량에 비례한다. native SQLite RAM과 TEMP 디스크를 JS heap과 구분해야 한다. main/temp page cache 각 기본 4096KiB 설정은 전체 native RAM의 엄격한 상한이 아니다.

legacy 부모 탐색에는 Map의 active.find로 파일 수에 대한 O(F_a²) 경로와 같은 부모 이벤트를 반복 필터하는 비용도 있다. 최초 DTO와 현재 캐시가 공유하는 코드이며 이번 퇴행의 주원인으로 단정하지 않는다.

| 데이터 / Codex 1건 추가 | 진단 refresh 직후 heap MiB SQL / Map | metadata 종료 경계 heap MiB SQL / Map | 프로세스 HWM RSS 중앙값 MiB SQL / Map |
| --- | ---: | ---: | ---: |
| current | 25.59 / 116.26 | 25.39 / 115.89 | 224.50 / 281.01 |
| synthetic-10000 | 11.15 / 47.38 | 10.82 / 46.43 | 249.55 / 244.08 |
| synthetic-100 | 10.31 / 10.08 | 10.17 / 9.91 | 62.80 / 64.32 |

heap은 변형별 한 번의 진단 실행에서 관측한 값이다. 강제 GC를 하지 않아 cache만의 retained 크기나 정확한 peak를 뜻하지 않는다. metadata 종료 경계도 그 시점의 전체 프로세스 JS heap이며 문자열만의 크기가 아니다. HWM RSS는 이전 갱신·정합성 조회·복원·모듈 로드를 포함한다. TEMP 디스크 high-water와 native SQLite 별도 할당량은 이번에 추가 측정하지 않았다.

## 6. 검증과 재실행

각 variant/pair는 새 process·빈 DB에서 초회 갱신하고 같은 DB 연결을 유지한다. 추가 시나리오마다 persistent main table과 원본 사본 tail/mtime를 복원한다. 복원·추가 생성·검증은 timing에서 제외한다. main.data_version이 변하지 않는 동일 연결 복원으로 B의 DTO cache를 유지한다. OS cache를 flush하거나 GC를 강제하지 않았다. 일반 fixture의 추가 갱신은 양쪽 모두 파일 하나를 읽으며 변경 파일 전체 재파싱 조건을 유지한다.

정합성 396개 측정/진단 상태와 66개 cold reopen 상태에서 요청 수·토큰·요청별 facts·평균·진단·원본 metadata SHA·의존성이 일치했다. 원본 SQL/rollup 전 페이지, 독립 JS 그룹 평균, FK/integrity와 입력 전체 hash 복원을 확인했다. 준비 실행의 대조도 runner 내부에서 통과했다. 제품 소스·빌드는 이전 보고서의 SQL A/파일 cache B와 정확히 일치한다.

npm run check의 타입 검사·린트·426개 테스트가 통과했다. 새 계측 wrapper는 node --check와 100요청 smoke에서 exclusive 시계 합·INSERT 카운터·A/B 정합성을 확인한 뒤 고정했다.

재실행: node tests/benchmarks/jsonl-stage-cost-ab.cjs --before=<고정SQL빌드> --after=<고정캐시빌드> --workspace=<고정사본> --output=<새JSON>. 기존 jsonl-source-cache-ab.cjs의 입력·복원·검증·AB/BA 실행을 재사용하고 이 wrapper를 worker에 preload해 exclusive phase clocks를 추가한다. source/build/기존 runner/계측 wrapper SHA를 원시 JSON에 보존했다. wrapper의 이벤트별 시계 호출 때문에 계측 없는 이전 보고서 절대값과 직접 합치지 않는다.

판정: Map 조회의 평균 O(1)만으로 전체 갱신 시간을 판단할 수 없다. 현재 구현은 dirty 판정 전의 전체 영향 DTO 작업, 원본 서명 재구성, 선택 결과 TEMP 적재 비용을 지불한다. 중복이 적은 후속 갱신은 INSERT 행 수 절약이 없고 기존 SQL은 dirty 이벤트만 winner를 계산한다. 실제 소량 갱신의 Map winner 비용 자체는 작으며, 원본 서명도 이번 실제 입력에서는 더 빠르다. 이름 SQL의 transaction batch가 사라진 부작용은 별도 원인 분리 실험으로 확인했다. 모든 구간 차이를 후보 Map 또는 메모리 할당 하나로 설명하지 않는다. 제품 알고리즘 수정은 이번 비교 범위에 포함하지 않았다.
