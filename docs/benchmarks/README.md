# benchmarks

JSONL 파싱·요청 집계·SQL 조회의 성능 비교 결과를 보존한다.

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
- [SqlWrites-2026-10-26.md](SqlWrites-2026-10-26.md): 증분 저장·일/월 기본키 배치와 세션 날짜 인덱스의 A/B 결과와 채택 근거를 설명한다.
- [SqlWrites-2026-10-26-Analysis.md](SqlWrites-2026-10-26-Analysis.md): 현재 PK 저장 구조·월별 GROUP BY와 한 달 탐색의 차이·월 우선 배치의 공간/쓰기 비용 원인을 고찰한다.
- [SqlWrites-2026-10-26.json](SqlWrites-2026-10-26.json): 같은 비교의 표본·전체 결과 해시·실행 계획·DB 공간·프로세스 메모리를 보존한다.
- [SqlRowid-2026-10-27.md](SqlRowid-2026-10-27.md): 같은 세션 키·증분 저장에서 일별 집계의 rowid 유무에 따른 시간·공간과 원인을 비교한다.
- [SqlRowid-2026-10-27.json](SqlRowid-2026-10-27.json): rowid A/B의 프로세스별 표본·전체 결과 해시·실행 계획·물리 점유를 보존한다.
- [SqlRowidAppend-2026-10-27.md](2026-10-27/SqlRowidAppend-2026-10-27.md): 최초 일괄 적재와 추가분 INSERT 시제품의 rowid A/B 결과·현재 제품과의 차이를 설명한다.
- [SqlRowidAppend-2026-10-27.json](2026-10-27/SqlRowidAppend-2026-10-27.json): 같은 비교의 교대 표본·구간별 시간·입력 바이트·공간·정합성 검증을 보존한다.
