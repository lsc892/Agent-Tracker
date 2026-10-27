# benchmarks

벤치마크 보고서와 원시 결과를 실험 기준일(Asia/Seoul)의 `YYYY-MM-DD` 폴더에 보존한다. 같은 실험의 후속 고찰·보완 측정은 기준 실험과 함께 둔다.

- [2026-10-27](2026-10-27/README.md): 현재 제품 저장 경로와 추가분 INSERT 시제품의 rowid A/B.
- [2026-10-26](2026-10-26/README.md): 증분 저장·월/일 기본키 배치·세션 날짜 인덱스 비교와 후속 고찰.
- [2026-10-15](2026-10-15/README.md): SQL 실행 계획·인덱스·일별 rollup 후보와 제품 경로 비교.
- [2026-10-09](2026-10-09/README.md): JSONL reader·adapter 및 파싱 분기 비교.
- [2026-10-08](2026-10-08/README.md): 초기 성능 검토와 요청 제목 인덱스·트랜잭션 비교.

원시 JSON·압축 로그의 측정값과 당시 경로·소스 해시는 변경하지 않는다. 실행기와 다른 문서의 참조는 현재 보관 경로를 사용한다. 로컬 재실행·smoke 산출물은 기존 `tests/results/benchmarks/`에 둔다.
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
