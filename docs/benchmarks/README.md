# 벤치마크

벤치마크 보고서와 원시 결과를 실험 기준일(Asia/Seoul)로 보관한다. 후속 고찰·보완 측정은 해당 실험의 날짜에 둔다.

- `success`는 제품에 채택한 변경과 관련 측정·검증이다. 이후 다른 설계로 교체된 단계는 날짜별 목차에 경위를 기록한다.
- `failure`는 미채택·철회한 후보와 제품 채택으로 이어지지 않은 실험, 정합성 검증에 실패한 비교다. 후보별 판정과 비교 범위는 날짜별 목차에서 확인할 수 있다.
- 채택 결과와 미채택 대조군을 한 문서에서 다루면 대표 결과가 속한 폴더에 보고서를 한 번만 두고 관련 자료를 연결한다.

- [파싱·조회·쓰기 병목을 줄인 과정과 철회 근거](SUMMARY.md)
- [v0.2.0 대비 v0.3.0의 알고리즘 개선](../Performance-v0.3.0.ko.md)

## 제품 반영

- [2026-11-26 원본 탐색과 Codex 응답 키 색인의 힙 A/B](success/2026-11-26/RefreshHeapAB-2026-11-26.md) — 디렉터리 순회와 Codex 응답 키 색인 변경이 갱신에서 사용하는 힙에 미치는 영향을 비교했다.
- [2026-11-26 구형 Codex 누계 비교 서명 ArrayBuffer A/B](success/2026-11-26/LegacySignaturesBufferAB-2026-11-26.md) — 집계 직전 힙과 전체 피크 힙, 프로세스 RSS 및 저장 결과를 비교했다.
- [2026-11-26 JSONL 고정 필드 바이트 선택 A/B](success/2026-11-26/ByteProjectionAB-2026-11-26.md) — 필요한 값만 디코딩하는 경로의 파일 Worker 힙·할당과 전체 갱신 시간·RSS를 비교했다.
- [2026-11-26 응답 토큰 ArrayBuffer A/B](success/2026-11-26/ThreadTokenBufferAB-2026-11-26.md) — 실로그·합성 입력의 최초 수집과 1건 추가에서 피크 힙, 외부 메모리와 프로세스 RSS를 비교했다. [자연 GC 후속 측정](success/2026-11-26/ThreadTokenGcAB-2026-11-26.md)
- [2026-11-26 임시 DB 없이 최근 30일 통계 열기 A/B](failure/2026-11-26/DirectDashboardRefreshAB-2026-11-26.md) — 같은 빌드에서 메모리 미리보기 생략이 첫 표, 최종 표, 메모리와 SQLite 크기에 미치는 영향을 비교했다. 이후 직접 갱신을 적용했다. [기능 결정 일지](../AgentTracker-일지.md)
- [2026-11-26 원본 관계 저장 형식 A/B](success/2026-11-26/SourceRelationStorageAB-2026-11-26.md) — 원본 관계를 BLOB에 저장하던 방식과 스레드 ID·보존 플래그로 저장하는 방식의 공간, 부모 조회, 갱신 비용을 비교했다. [날짜별 자료](success/2026-11-26/README.md)
- [2026-11-25 SQLite 보조 인덱스 제거 A/B](success/2026-11-25/SQLiteIndexRemovalAB-2026-11-25.md) — 일별 집계 스키마에서 보조 인덱스 6개를 제거하기 전후의 DB 크기, 갱신 및 조회를 비교했다. [날짜별 자료](success/2026-11-25/README.md)
- [2026-11-25 청크별 JSONL 필드 선택 A/B](success/2026-11-25/StreamingJsonlProjectionAB-2026-11-25.md) — 행을 조립한 뒤 필드를 고르던 방식과 읽는 중에 필요한 조각을 고르는 방식의 파싱 시간과 메모리를 비교했다.
- [2026-11-24 과거 사용량 일별 집계의 시간·공간 비교](success/2026-11-24/HistoricalSummaryAB-2026-11-24.md) — 최근 30일 통계 A/B 커밋, v0.3.1, 일별 저장 빌드의 수집·조회 시간, 메모리, SQLite 크기를 비교했다. [날짜별 자료](success/2026-11-24/README.md)
- [2026-11-24 스레드별 응답 최고값 즉시 병합 A/B](success/2026-11-24/StreamingThreadResponseAB-2026-11-24.md) — 응답 배열을 모은 뒤 처리하던 방식과 읽는 즉시 최고값을 병합하는 방식의 실로그 수집과 메모리를 비교했다.
- [2026-11-24 스레드 토큰 집계 정합성 A/B](success/2026-11-24/ResponseThreadAccountingAB-2026-11-24.md) — 스레드별 응답 토큰 집계 결과를 원본 로그에서 독립 검산하고 변경 전후 수집 시간과 메모리를 관측했다.
- [2026-11-24 JSONL 선택 파싱의 최초 수집 메모리 비교](success/2026-11-24/SelectiveJsonlMemoryAB-2026-11-24.md) — 집계에 필요한 JSONL 필드만 디코딩하기 전후에 실로그 최초 수집의 RSS와 V8 힙을 비교했다.
- [2026-11-24 파일 준비 결과의 winner 경량화 A/B](success/2026-11-24/CompactWinnerAB-2026-11-24.md) — 파일별 winner에 최종 비교·집계에 쓰는 필드만 남겼을 때 최초 수집 시간, 피크 메모리, 저장 결과를 비교했다.
- [2026-11-24 파일별 winner와 요청당 한 번의 UPSERT A/B](success/2026-11-24/FileWinnerUpsertAB-2026-11-24.md) — 전역 winner 맵을 파일별 선택과 요청당 UPSERT로 대체했을 때 최종 집계 시간과 힙이 어떻게 달라지는지 비교했다.
- [2026-11-24 파일별 수정 시각과 원본 해시 제거 A/B](success/2026-11-24/PerFileMtimeAB-2026-11-24.md) — 원본 해시를 파일별 수정 시각 판정으로 바꾼 전후의 재수집·파싱 시간, DB 크기, 이관 결과를 비교했다.
- [2026-11-24 JSONL 선택 파싱 재실험 이후의 갱신 비교](success/2026-11-24/FromSelectiveParsingAB-2026-11-24.md) — 선택 파싱 재실험 커밋과 당시 제품 빌드의 갱신·평균 조회, 피크 메모리, DB 크기를 세 입력 규모에서 비교했다.
- [2026-11-23 응답별 반영값 차분 적용 A/B](success/2026-11-23/AppliedResponseDeltaAB-2026-11-23.md) — 원본별 후보를 모두 저장하는 방식과 응답별 최종 반영값의 차이만 저장하는 방식의 갱신 비용과 DB 크기를 비교했다. [날짜별 자료](success/2026-11-23/README.md)
- [2026-11-22 선택적 winner 맵 A/B](success/2026-11-22/SelectiveWinnerMapAB-2026-11-22.md) — 모든 후보에 최종 맵을 쓰던 방식과 중복 가능한 후보에만 맵을 쓰는 방식의 수집·조회 시간과 피크 메모리를 비교했다. [날짜별 자료](success/2026-11-22/README.md)
- [2026-11-21 최근 30일 통계 첫 화면 A/B](success/2026-11-21/DashboardFirstPageAB-2026-11-21.md) — 빈 DB와 일별 집계가 있는 DB에서 최근 30일 미리보기 적용 전후의 VS Code 통계 첫 렌더링 시간을 비교했다. [날짜별 자료](success/2026-11-21/README.md)
- [2026-11-21 JSONL 행별 디코딩 제품 A/B](success/2026-11-21/JsonlLineProductAB-2026-11-21.md) — 청크 전체 디코딩과 행별 디코딩의 실로그 파싱 시간, RSS, V8 힙을 비교했다.
- [2026-11-21 JSONL 수정 시각 갱신 A/B](success/2026-11-21/MtimeRefreshAB-2026-11-21.md) — 전역 수정 시각으로 읽을 원본을 고르는 방식의 갱신 시간, 본문 읽기량, 메모리와 정합성을 비교했다.
- [2026-11-12 선택 도표에 필요한 토큰 평균 계산 A/B](success/2026-11-12/ChartMetricAB-2026-11-12.md) — 총 토큰 도표에서 구성별 평균을 생략했을 때 제공자·모델별 조회와 요청 추가 시간이 어떻게 달라지는지 비교했다. [날짜별 자료](success/2026-11-12/README.md)
- [2026-11-11 기능 보존 알고리즘 최소화 A/B](success/2026-11-11/AlgorithmMinimizeAB-2026-11-11.md) — 계보·조회·파싱·저장의 중복 작업을 줄인 전후의 실데이터 및 합성 요청 갱신·조회 성능을 비교했다. [날짜별 자료](success/2026-11-11/README.md)
- [2026-11-10 요청 저장·일별 집계 SQL 최소화 A/B](success/2026-11-10/QueryMinimizeAB-2026-11-10.md) — 신규 자식 DELETE 생략, 사용량 판정 공유, INSERT RETURNING 후보의 갱신 비용을 비교했다. [날짜별 자료](success/2026-11-10/README.md)
- [2026-11-10 원본 순회 중 통계 누적 통합](../research/2026-11-10/UnifiedStreamingStats-2026-11-10.md) — 원본 순회를 하나로 줄인 전후의 최초 수집·증분·무변경 저장과 평균 조회 정합성을 대조했다.
- [2026-11-10 최종 이름·세션 결제 설정 중복 제거 A/B](success/2026-11-10/MetadataBatchAB-2026-11-10.md) — 이름과 결제 설정을 저장 묶음별 한 번만 처리했을 때 SQL 호출 수와 저장·조회 시간을 비교했다.
- [2026-11-10 미사용 rollup 지표 제거 A/B](success/2026-11-10/RollupTrimAB-2026-11-10.md) — 미사용 집계 지표와 진단 재집계를 제거하기 전후의 갱신·평균 조회 시간, 공간, 기존 DB 전환 비용을 비교했다.
- [2026-11-10 저장 묶음의 일별 집계 일괄 갱신 A/B](success/2026-11-10/RollupBatchAB-2026-11-10.md) — 저장 묶음 끝에서 변경 세션의 최종 facts를 한 번에 집계할 때 SQL 호출 수와 저장 시간을 비교했다.
- [2026-11-10 정상 성분 묶음 저장 트랜잭션 A/B](success/2026-11-10/TransactionBatchAB-2026-11-10.md) — 정상 성분을 최대 16개·1,000요청씩 묶었을 때 COMMIT, 전체 갱신, 실패 시 롤백에 미치는 영향을 확인했다.
- [2026-11-10 성능 개선 인수인계](success/2026-11-10/PerformanceHandoff-2026-11-10.md) — 적용된 최적화, 해당 측정의 기준 빌드, 후속 비교에 남은 병목을 정리했다.
- [2026-11-09 관계 역인덱스·작업 큐 A/B](success/2026-11-09/ScanQueueAB-2026-11-09.md) — 관계 역인덱스와 작업 큐 적용 전후의 최초 수집·1건 추가·무변경 갱신을 비교했다. [날짜별 자료](success/2026-11-09/README.md)
- [2026-11-09 관계 역인덱스·작업 큐의 극단 기간 조건 A/B](success/2026-11-09/ScanQueueRawRangeAB-2026-11-09.md) — 극단적인 날짜 필터에서 원본 단위 조회를 실행한 선행 A/B의 조건과 측정값을 정리했다.
- [2026-11-09 파일 스캔 구간별 단일 측정](success/2026-11-09/ScanStages-2026-11-09.md) — 최초 수집·1건 추가·무변경 갱신에서 탐색, 원본 처리, 관련 확장, 집계, SQL 저장 시간을 나눠 측정했다.
- [2026-11-09 파일 준비 Worker 풀 A/B](success/2026-11-09/SourcePoolAB-2026-11-09.md) — 제한된 Worker 풀에 파일별 읽기·파싱·winner 준비를 분배하기 전후의 갱신과 평균 조회를 비교했다.
- [2026-11-08 부모 DTO 차분 집계 A/B](success/2026-11-08/ParentDtoDeltaAB-2026-11-08.md) — 자식 사용량을 별도 요청에서 부모 요청으로 합산할 때의 집계값을 검산하고 기존 DB 갱신을 확인했다. [날짜별 자료](success/2026-11-08/README.md)
- [2026-11-08 단일 읽기 winner A/B](success/2026-11-08/SinglePassWinnerAB-2026-11-08.md) — 원본을 두 번 읽는 방식과 한 번만 읽어 winner를 고르는 방식의 초회·증분 수집과 메모리를 비교했다.
- [2026-11-07 Manifest·파일 DTO 재사용과 메모리 집계 A/B](success/2026-11-07/JsonlMemoryIncrementalAB-2026-11-07.md) — 파일 DTO를 재사용해 메모리에서 집계하고 직접 저장하는 방식의 갱신 시간과 메모리를 비교했다. [날짜별 자료](success/2026-11-07/README.md)
- [2026-11-05 JSONL 청크 분할 A/B](success/2026-11-05/JsonlChunksAB-2026-11-05.md) — 청크 단위 디코딩·줄 분할 적용 전후의 실제 갱신, 요청 추가, 평균 조회를 비교했다. [날짜별 자료](success/2026-11-05/README.md)
- [2026-11-05 영속 turn metadata로 변경 turn만 재집계](success/2026-11-05/MetadataKeyedAB-2026-11-05.md) — 전체 파싱 후 변경 turn만 다시 저장하는 후보의 재파싱 시간, 요청 추가 회귀, DB 크기를 비교했다.
- [2026-11-05 영속 turn metadata의 SQL 의미 열 직렬화 사전 관측](success/2026-11-05/MetadataKeyedPilot-2026-11-05.md) — SQL 비교에 필요한 열만 직렬화하고 변경이 없으면 저장을 생략하는 후보를 입력 규모별 한 쌍으로 관측했다.
- [2026-11-04 TEMP 집계 묶음 A/B](success/2026-11-04/TempBatchAB-2026-11-04.md) — 연결 성분별 TEMP 집계와 32개씩 묶는 후보의 전체 재파싱·한 건 추가·평균 조회를 비교했다. [날짜별 자료](success/2026-11-04/README.md)
- [2026-11-04 TEMP 묶음 집계의 제품 반영 확인](success/2026-11-04/TempBatchProduct-2026-11-04.md) — 단일 성분을 직접 처리하고 나머지를 디스크 TEMP로 묶는 제품 빌드를 기존 빌드와 대조했다.
- [2026-11-03 전체 재파싱에서 TEMP 집계 재사용](success/2026-11-03/ReparseTempReuse-2026-11-03.md) — TEMP 집계 테이블과 인덱스를 재사용했을 때 전체 재파싱과 집계 준비 시간이 어떻게 달라지는지 비교했다. [날짜별 자료](success/2026-11-03/README.md)
- [2026-11-03 TEMP 집계 재사용 실로그 비교](success/2026-11-03/ReparseTempReuse-real-2026-11-03.md) — 실제 로그에서 TEMP 집계 재사용 전후의 갱신 표본, 정확성, 실행 조건을 기록했다.
- [2026-11-03 TEMP 집계 재사용 비교 · 세션당 100요청](success/2026-11-03/ReparseTempReuse-short-2026-11-03.md) — 1만 합성 요청을 세션당 100건으로 배치해 TEMP 집계 재사용 전후를 비교했다.
- [2026-11-03 TEMP 집계 재사용 비교 · 세션당 1,000요청](success/2026-11-03/ReparseTempReuse-long-2026-11-03.md) — 1만 합성 요청을 세션당 1,000건으로 배치해 TEMP 집계 재사용 전후를 비교했다.
- [2026-11-03 재파싱·세션 시간 인덱스 A/B 요약](success/2026-11-03/SessionTimeIndexAB-summary.md) — 채택된 TEMP 재사용과 미채택 세션 시간 인덱스의 갱신 시간·DB 공간 측정값을 함께 정리했다.
- [2026-10-31 집계 월 기본 키 철회와 저장 트랜잭션 비교](success/2026-10-31/StorageTransactions-2026-10-31.md) — 월·세션 기본 키와 일괄·묶음 저장을 교차 비교해 세션 기본 키 복원과 선택적 묶음 저장을 결정했다. [날짜별 자료](success/2026-10-31/README.md)
- [2026-10-31 현재 조회 SQL 병목 조사](success/2026-10-31/QueryProfile-2026-10-31.md) — 실제 DB 사본과 합성 입력에서 비용·토큰·요청·이름·도구·진단 조회의 SQL과 실행 계획을 계측했다.
- [2026-10-31 통계 진입·INSERT·UPDATE 비용 조사](success/2026-10-31/WriteProfile-2026-10-31.md) — 최초 적재, 재진입, 요청 추가·변경에서 INSERT, UPDATE, TEMP, COMMIT 비용을 나눠 측정했다.
- [2026-10-15 기존 SQL 집계와 일별 rollup 비교](success/2026-10-15/SqlExplainBenchmark-2026-10-15.md) — 보조 인덱스 유지·제거와 일별 사전 집계의 조회 시간, 실행 계획, 저장 공간을 비교했다. [날짜별 자료](success/2026-10-15/README.md)
- [2026-10-09 JSONL 파싱 적용 전후 브랜치 비교](success/2026-10-09/JsonlParsingBranches-2026-10-09.md) — 같은 메모리 입력에서 바이트별 처리와 LF 탐색·일반 줄 직접 파싱의 시간과 자원 사용량을 비교했다. [날짜별 자료](success/2026-10-09/README.md)
- [2026-10-08 SQLite 인덱스·JSONL 파싱·Skill 집계 검토](success/2026-10-08/PerformanceReview.md) — 초기 수집과 조회에서 인덱스, JSONL 파싱, Skill 집계가 차지하는 비용과 개선 후보를 조사했다. [날짜별 자료](success/2026-10-08/README.md)
- [2026-10-08 요청 제목 TEMP 인덱스와 집계 통합 A/B](success/2026-10-08/RequestTitleAB.md) — 요청 제목용 TEMP 인덱스와 집계 통합 후보의 시간, 결과, SQL 실행 계획을 비교했다.
- [2026-10-08 요청 제목 TEMP 인덱스의 실제 갱신 측정](success/2026-10-08/RequestTitleTransactions.md) — 실제 갱신에서 요청 제목 인덱스 적용 전후의 저장 시간과 트랜잭션별 비용을 비교했다.

## 미채택·철회 및 검증 한계

- [2026-11-25 SQLite 일별 기본 키 날짜 우선 A/B](failure/2026-11-25/DailyDateClusterAB-2026-11-25.md) — 날짜를 기본 키 맨 앞으로 옮겼을 때 일별 조회의 단축과 월·세션 조회의 지연을 비교했다. [날짜별 자료](failure/2026-11-25/README.md)
- [2026-11-24 최종 winner 맵 하나로 통합한 A/B](failure/2026-11-24/SingleWinnerMapAB-2026-11-24.md) — 파일별 winner 선택을 없애고 최종 맵에서 한 번만 선택했을 때 집계 시간과 피크 힙이 늘어나는지 확인했다. [날짜별 자료](failure/2026-11-24/README.md)
- [2026-11-23 SQLite v22 보조 인덱스 제거 후 조회 실험](failure/2026-11-23/DbTradeoff-IndexRemovalExplain.md) — 이전 요청 단위 스키마에서 보조 인덱스 9개를 제거한 뒤 조회 시간, 실행 계획, 회수 가능한 공간을 비교했다. [날짜별 자료](failure/2026-11-23/README.md)
- [2026-11-23 원본별 winner 영속 저장 A/B](failure/2026-11-23/PersistentWinnerRefreshAB-2026-11-23.md) — 원본별 winner를 SQLite에 남겨 변경되지 않은 관련 파일의 재파싱을 줄이는 후보의 최초·증분 갱신과 저장 공간을 비교했다.
- [2026-11-23 원본별 winner의 SQLite 임시 저장 A/B](failure/2026-11-23/SQLiteWinnerRefreshAB-2026-11-23.md) — 파싱 후보를 임시 테이블에 쓰고 다시 읽을 때 힙 절감과 갱신 비용을 비교했다.
- [2026-11-21 Codex 대기 호출의 SQLite 임시 저장](failure/2026-11-21/CodexSpawnSpillAB-2026-11-21.md) — 대기 중인 서브에이전트 호출을 맵에서 SQLite로 옮겼을 때 힙·RSS·처리 시간과 실제 로그의 전환 빈도를 확인했다. [날짜별 자료](failure/2026-11-21/README.md)
- [2026-11-20 SHA-256·XXH3-128 전수 본문 검증](failure/2026-11-20/ContentFingerprintFailure-2026-11-20.md) — 두 해시를 사용해 원본 본문 전체를 다시 검증할 때 읽기량과 갱신 비용을 비교했다. [날짜별 자료](failure/2026-11-20/README.md)
- [2026-11-19 완성 줄 위치·원본 prefix 해시 증분 A/B](failure/2026-11-19/PrefixHashAB-2026-11-19.md) — 기존 manifest 판정과 SHA-256·BLAKE3·XXH3-128 증분 후보를 요청 추가·중간 수정·무변경 조건에서 비교했다. [날짜별 자료](failure/2026-11-19/README.md)
- [2026-11-16 JSONL 알고리즘별 요청 추가·갱신 실측](failure/2026-11-16/JsonlAlgorithmsAB-2026-11-16.md) — 해시·체크포인트·블록 검증 후보 11개의 요청 추가·갱신 시간, 메모리, 중간 수정 정합성을 비교했다. [날짜별 자료](failure/2026-11-16/README.md)
- [2026-11-10 선택 JSON 파싱·winner 비교 재사용 A/B](failure/2026-11-10/SelectiveWinnerAB-2026-11-10.md) — 선택 파싱과 비교 결과 재사용을 적용해 집계값이 일치했지만 실제 로그 최초 수집이 느려진 사례를 기록했다. [날짜별 자료](failure/2026-11-10/README.md)
- [2026-11-10 v0.2.0과 당시 dev의 알고리즘 구간 A/B](failure/2026-11-10/VersionStagesAB-2026-11-10.md) — 두 버전의 수집·재파싱·추가·평균 조회를 비교했으며, 실제 입력은 요청 수가 달라 성능 판정에서 제외했다.
- [2026-11-08 두 번 읽는 스트리밍 winner A/B](failure/2026-11-08/StreamingWinnerAB-2026-11-08.md) — 전체 DTO 캐시와 원본을 두 번 읽어 패자 DTO를 버리는 후보의 초회·증분 갱신, 힙, 정합성을 비교했다. [날짜별 자료](failure/2026-11-08/README.md)
- [2026-11-08 DTO greedy와 배열 대조군 A/B](failure/2026-11-08/DtoGreedyAB-2026-11-08.md) — 전체 원본을 보존하는 배열과 검사 전 패자 폐기 후보를 비교하고 삭제 시 승자를 놓치는 반례를 확인했다.
- [2026-11-07 winner DTO 최소 보관 A/B](failure/2026-11-07/JsonlGreedyMinimalAB-2026-11-07.md) — 패자 후보를 버리고 예외 시 다시 파싱하는 방식의 시간·메모리와 복구 비용을 비교했다. [날짜별 자료](failure/2026-11-07/README.md)
- [2026-11-07 읽는 즉시 winner를 선택하는 방식의 정합성](failure/2026-11-07/JsonlOnlineGreedyCorrectness-2026-11-07.md) — 실제 580개 파일에서 유효성 검사와 최종 귀속 확인을 생략했을 때 집계가 달라지는 조건을 확인했다.
- [2026-11-06 JSONL 파싱·중복 제거 A/B](failure/2026-11-06/JsonlParsingOptimizationAB-2026-11-06.md) — 청크에서 줄 구간 참조, 전체 Buffer, Map winner 선택 후보의 시간·메모리와 오류 처리를 비교했다. [날짜별 자료](failure/2026-11-06/README.md)
- [2026-11-06 파싱 DTO의 메모리 Map 중복 제거 A/B](failure/2026-11-06/JsonlMapIngestionAB-2026-11-06.md) — 전체 DTO를 보관한 뒤 메모리에서 중복을 제거해 SQL에 넣는 후보와 이름 갱신용 SQL 묶음의 영향을 조사했다.
- [2026-11-06 Greedy Map과 기존 SQL 집계의 정합성 A/B](failure/2026-11-06/JsonlGreedyMapAB-2026-11-06.md) — 보정 전 승자 DTO만 보존한 방식의 집계값과 비용을 확인하고 전체 DTO로 복원한 근거를 기록했다.
- [2026-11-06 파일 DTO 캐시와 응답별 후보 교체 A/B](failure/2026-11-06/JsonlSourceCacheAB-2026-11-06.md) — 같은 DB 연결과 다시 연 연결에서 후속 갱신 및 변경 없는 관련 파일의 캐시 효과를 비교했다.
- [2026-11-06 SQL TEMP와 파일 캐시 Map의 구간별 비용](failure/2026-11-06/JsonlStageCostAB-2026-11-06.md) — 원본 읽기·DTO·SQL 적재·winner·서명·저장별 시간과 힙·TEMP 공간을 분리해 비교했다.
- [2026-11-05 영속 turn metadata의 서명 비교 시제품](failure/2026-11-05/MetadataAB-2026-11-05.md) — turn 의미 서명을 저장해 변경분만 재계산하는 시제품에서 반복 서명 비교가 증분 갱신에 미친 영향을 확인했다. [날짜별 자료](failure/2026-11-05/README.md)
- [2026-11-03 요청 비용 JOIN 한 번 제거 A/B](failure/2026-11-03/InlineCostAB-2026-11-03.md) — 요청별 비용을 본체에 합친 구조와 비용 테이블을 분리한 구조의 조회·요청 추가·DB 크기를 비교했다. [날짜별 자료](failure/2026-11-03/README.md)
- [2026-11-03 세션 시간 인덱스 하나의 갱신·공간 A/B](failure/2026-11-03/SessionTimeIndexAB-2026-11-03.md) — 세션 시간 인덱스를 하나 더 두었을 때 추가·변경 트랜잭션과 DB 공간에 드는 비용을 비교했다.
- [2026-11-03 단순 인덱스 후보와 배포 판단](failure/2026-11-03/SimpleIndexAB-2026-11-03.md) — 세션 시간 인덱스와 최초 시각 SQL 조정 후보의 조회 개선을 쓰기 지연·공간 증가와 대조했다.
- [2026-10-31 월 기본 키와 큰 세션 묶음의 제품 비교](failure/2026-10-31/StorageProduct-2026-10-31.md) — 월 기본 키와 세션·월 목록, 큰 세션 묶음 기준을 바꿔 조회·저장 시간과 DB·TEMP·WAL 공간을 비교했다. [날짜별 자료](failure/2026-10-31/README.md)
- [2026-10-31 일별 집계와 인덱스 전용 저장소 A/B](failure/2026-10-31/DbTradeoff-index-only-focused.md) — 일별 집계 대신 인덱스로 대상 세션을 찾고 교체하는 후보의 조회·증분·저장 공간을 비교했다.
- [2026-10-29 요청별 증분 저장 전후 실로그 비교](failure/2026-10-29/IncrementalRefresh-2026-10-29.md) — 실제 로그에서 요청별 차이 저장 전후의 전체 갱신과 DB 저장 시간을 시나리오별로 비교했다. [날짜별 자료](failure/2026-10-29/README.md)
- [2026-10-29 증분 저장 전후 합성 10만 요청 비교 · 세션당 100건](failure/2026-10-29/IncrementalScale-100000-100-2026-10-29.md) — 1,000개 세션에서 최초 적재, 재파싱, 추가·변경 시나리오의 전체 갱신과 저장 시간을 비교했다.
- [2026-10-29 증분 저장 전후 합성 10만 요청 비교 · 세션당 1만 건](failure/2026-10-29/IncrementalScale-100000-10000-2026-10-29.md) — 10개 대형 세션에서 요청별 차이 저장이 전체 갱신과 SQL 저장 시간에 미친 영향을 비교했다.
- [2026-10-29 합성 10만 요청의 세션 밀도별 증분 저장 비교](failure/2026-10-29/IncrementalScale-100000-2026-10-29.md) — 총 요청 수를 고정하고 세션당 요청 수를 달리했을 때 시나리오별 증감률을 대조했다.
- [2026-10-29 manifest 갱신·증분 저장 롤백 비교](failure/2026-10-29/RefreshRollback-2026-10-29.md) — 당시 저장 경로와 롤백 후보를 실제·합성 입력에서 대조하고 갱신 단계, SQL 작업, 주요 조회 비용을 분리했다.
- [2026-10-29 저장·조회 방식의 시간·공간 비교](failure/2026-10-29/StorageAB-2026-10-29.md) — 날짜·월 기본 키, 보조 인덱스, SQL 묶음, 파싱 재사용이 갱신·조회와 DB 크기에 미치는 영향을 비교했다.
- [2026-10-27 세션 기준 일별 집계의 rowid A/B](failure/2026-10-27/SqlRowid-2026-10-27.md) — 같은 복합 키와 보조 인덱스에서 rowid 유무에 따른 기존 갱신·조회 시간과 저장 공간을 비교했다. [날짜별 자료](failure/2026-10-27/README.md)
- [2026-10-27 최초 일괄 적재·추가분 INSERT의 rowid A/B](failure/2026-10-27/SqlRowidAppend-2026-10-27.md) — 최초 적재 경로와 추가분만 INSERT하는 시제품에서 rowid 구조의 시간·공간 차이를 확인했다.
- [2026-10-26 DB 저장 방식별 시간·공간 A/B](failure/2026-10-26/SqlWrites-2026-10-26.md) — 증분 저장, 월·일 우선 기본 키, 세션 날짜 인덱스 후보의 갱신·조회와 저장 공간을 비교했다. [날짜별 자료](failure/2026-10-26/README.md)
- [2026-10-26 월 우선 기본 키 실험 후속 분석](failure/2026-10-26/SqlWrites-2026-10-26-Analysis.md) — 월별 배치로 기대한 개선이 작았던 이유를 SQL 실행 계획, 쓰기 시간, 공간 변화로 분석했다.
- [2026-10-25 날짜 저장 순서·인덱스·SQL A/B](failure/2026-10-25/DateStorageAB-2026-10-25.md) — 날짜순 저장과 집계 기본 키·표현식 인덱스의 비용을 비교하고 SQLite에서 날짜 조건에 따라 행이 누락되는 사례를 확인했다. [날짜별 자료](failure/2026-10-25/README.md)
- [2026-10-25 날짜 조건 SQL 후보 실험](../research/2026-10-25/DateStorageQueryNotes.md) — 날짜 범위와 시각 미상 행을 처리하는 OR 조건을 UNION으로 분리하거나 질의별로 특수화했을 때 실행 계획과 시간을 비교했다.
- [2026-10-15 날짜·프로젝트 보조 인덱스 제거 실험](failure/2026-10-15/README.md) — 보조 인덱스를 유지하거나 제거한 집계 쿼리의 시간과 실행 계획을 비교한 원시 결과와 공동 보고서를 연결한다.

원시 JSON·압축 로그의 측정값과 기록 당시 경로·소스 해시는 보존했다. [워크트리 보관 명세](success/2026-11-08/WorktreeArchive-2026-11-08.json)에는 당시 보관본의 해시와 중복 보고서 선택 근거가 있다.

## 보존 실행기에서 결과 경로 지정

로컬 재실행 산출물은 `tests/results/benchmarks/`에 둔다. 실행기가 `--output` 또는 위치 인자를 받으면 새 로컬 경로를 지정한다. 원시 입력이 필요한 실행기는 아래 경로를 사용한다.

| 실행기 | 경로 지정 |
| --- | --- |
| [index-only-focused.cjs](../../tests/benchmarks/index-only-focused.cjs) | `--previous=docs/benchmarks/failure/2026-10-31/DbTradeoff-index-only.json`과 `--output=<새 JSON>`을 준다. |
| [prefix-hash-report.cjs](../../tests/benchmarks/prefix-hash-report.cjs) | [보존 JSON](failure/2026-11-19/PrefixHashAB-2026-11-19.json)을 첫 위치 인자로 준다. |
| [jsonl-parsing-branches.cjs](../../tests/benchmarks/jsonl-parsing-branches.cjs) | [선행 결과](success/2026-10-09/JsonlReaderTradeoff.json)를 입력으로 읽는 경로에 CLI 옵션이 없다. 아카이브 재배치 전의 별도 체크아웃에서 실행한다. |
| [jsonl-reader.cjs](../../tests/benchmarks/jsonl-reader.cjs) | 기본 비교는 종전 위치에 JSON을 쓰고, `--confirm-refresh`는 같은 JSON을 읽어 갱신한다. 별도 체크아웃에서 실행한다. |
| [sql-rollup-validation.cjs](../../tests/benchmarks/sql-rollup-validation.cjs) | `--append`는 종전 위치의 JSON을 읽어 갱신한다. 표준 출력으로만 결과가 필요하면 `--append`를 생략한다. |
