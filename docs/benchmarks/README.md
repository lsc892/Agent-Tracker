# benchmarks

JSONL 파싱·요청 집계·SQL 조회의 성능 비교 결과를 보존한다.

- [DateStorageProfile-2026-10-25.json](DateStorageProfile-2026-10-25.json): 설치 DB를 읽기 전용으로 조사한 행 수·페이지·인덱스 할당량을 보존한다.
- [DateStorageRaw-2026-10-25.json](DateStorageRaw-2026-10-25.json): 날짜순 입력과 요청 날짜 인덱스 후보의 조회·쓰기·저장 공간을 비교한다.
- [DateStorageRollup-2026-10-25.json](DateStorageRollup-2026-10-25.json): 일별 집계 기본 키 순서와 세션 보완 인덱스의 결과를 비교한다.
- [DateStorageQuery-2026-10-25.json](DateStorageQuery-2026-10-25.json): 날짜 OR 조건의 UNION 분리·특수화 결과를 보존한다.
- [DateStorageOrder-2026-10-25.json](DateStorageOrder-2026-10-25.json): 실제 요청 정렬과 일치하는 표현식 인덱스의 비용·효과를 비교한다.
- [DateStorageSqliteRepro-2026-10-25.json](DateStorageSqliteRepro-2026-10-25.json): 날짜 선두 PK와 OR 계획에서 관측한 결과 누락의 최소 재현을 보존한다.
- [DateStorageSqliteReproVSCode-2026-10-25.json](DateStorageSqliteReproVSCode-2026-10-25.json): 설치 VS Code의 SQLite 3.53.4에서도 같은 결과 누락이 발생하는지 대조한다.

- [JsonlParsingBranches-2026-10-09.json](JsonlParsingBranches-2026-10-09.json): JSONL 파싱 방식별 비교 수치를 보존한다.
- [JsonlReaderTradeoff.json](JsonlReaderTradeoff.json): JSONL 읽기 방식의 성능·자원 사용 비교를 보존한다.
- [PerformanceReview-2026-10-08.json](PerformanceReview-2026-10-08.json): 인덱스·파싱·집계 성능 검토의 측정값을 보존한다.
- [RequestTitleAB.json](RequestTitleAB.json): 요청 제목 집계 A/B 검증의 결과를 보존한다.
- [RequestTitleTransactions.json](RequestTitleTransactions.json): 실제 요청 제목 갱신·트랜잭션의 측정값을 보존한다.
- [RequestTitleTransactions.jsonl.gz](RequestTitleTransactions.jsonl.gz): 요청 제목 갱신 측정의 압축 실행 로그를 보존한다.
- [SqlExplainBenchmark-2026-10-15.md](SqlExplainBenchmark-2026-10-15.md): 기존 SQL과 일별 rollup 비교의 해석과 선택 근거를 설명한다.
- [SqlExplainBenchmark-2026-10-15.json](SqlExplainBenchmark-2026-10-15.json): SQL 조회 계획과 실행 성능 측정값을 보존한다.
- [SqlRollupABBenchmark-2026-10-15.json](SqlRollupABBenchmark-2026-10-15.json): rollup 후보 간 A/B 측정값을 보존한다.
- [SqlRollupProductBenchmark-2026-10-15.json](SqlRollupProductBenchmark-2026-10-15.json): 제품 rollup 적용 전후의 조회·갱신 비용을 보존한다.
