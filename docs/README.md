# docs

설계 기준·의사결정·개발 절차와 조사·성능 검증 기록을 둔다.

- [Performance-v0.3.0.ko.md](Performance-v0.3.0.ko.md): v0.2.0 대비 v0.3.0의 알고리즘 구간별 구조·기존 실측 개선량·실제 로그의 동등성 한계와 남은 병목을 정리한다.
- [현재 기능 의사결정 일지](AgentTracker-일지.md) — 2026-11-10부터의 결정과 검증 이력.
- [이전 일지](refrences/AgentTracker-일지.md) — 2026-10-01~11-09의 결정과 검증 이력.
- [Development.ko.md](refrences/Development.ko.md): 사용법·설정·개발·패키징 절차를 안내한다.
- [Implementation.md](refrences/Implementation.md): 초기 구현과 후속 변경의 적용·검증 기록을 보존한다.
- [CI-CD.md](refrences/CI-CD.md): 자동 검증과 릴리스 산출물 생성 절차를 설명한다.
- [QuotaBenchmark.md](refrences/QuotaBenchmark.md): Codex App Server의 시간·메모리 측정 방법을 설명한다.
- [OrcaQuotaComparison.md](refrences/OrcaQuotaComparison.md): Orca와 quota 조회·초기화 시각 처리 방식을 비교한다.
- [research/](research/README.md): 날짜별 폴더에 UI·다국어·JSONL 파싱·저장소 갱신과 조회의 조사·설계 근거를 둔다.
- [benchmarks/](benchmarks/README.md): 제품 반영 여부와 실험 날짜별로 성능 비교 보고서·원시 결과·검증용 산출물을 보존한다.
- [PerformanceReview.md](benchmarks/success/2026-10-08/PerformanceReview.md): SQLite 인덱스·JSONL 파싱·Skill 집계의 성능 검토를 기록한다.
- [JsonlParsingBranches-2026-10-09.md](benchmarks/success/2026-10-09/JsonlParsingBranches-2026-10-09.md): JSONL 파싱 방식별 비교와 선택 근거를 기록한다.
- [RequestTitleAB.md](benchmarks/success/2026-10-08/RequestTitleAB.md): 요청 제목 TEMP 인덱스와 집계 통합 방식의 A/B 검증을 기록한다.
- [RequestTitleTransactions.md](benchmarks/success/2026-10-08/RequestTitleTransactions.md): 요청 제목 집계의 실제 갱신·트랜잭션 측정을 기록한다.
- [DateStorageAB-2026-10-25.md](benchmarks/failure/2026-10-25/DateStorageAB-2026-10-25.md): 날짜 저장 순서·집계 기본 키·조회 SQL·정렬 인덱스의 A/B 결과와 정확성 제약을 기록한다.

## 관련 문서

- [설계 명세](refrences/AgentTracker.md) — 기능의 설계 기준과 정책.
- [LogParsingFields](refrences/LogParsingFields.md) — Claude·Codex JSONL 필드와 해석 규칙.
- [winner 정책](refrences/WinnerPolicy.md) — 응답 비교 키와 동점 처리, Codex 누계 검산.
- [SQLite 테이블](refrences/SQLiteTables.md) — 현재 테이블의 키와 저장·이관 규칙.
- [SQL 조회 흐름](refrences/UsageQueryFlow.md) — Webview 요청부터 SQLite 실행과 표·차트 반환까지.
