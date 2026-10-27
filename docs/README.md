# docs

설계 기준·의사결정·개발 절차와 조사·성능 검증 기록을 둔다.

- [AgentTracker.md](AgentTracker.md): 현재 기능과 데이터 처리 구조의 설계 기준을 정의한다.
- [AgentTracker-일지.md](AgentTracker-일지.md): 기능별 의사결정과 검증 이력을 보존한다.
- [Development.ko.md](Development.ko.md): 사용법·설정·개발·패키징 절차를 안내한다.
- [Implementation.md](Implementation.md): 초기 구현과 후속 변경의 적용·검증 기록을 보존한다.
- [CI-CD.md](CI-CD.md): 자동 검증과 릴리스 산출물 생성 절차를 설명한다.
- [QuotaBenchmark.md](QuotaBenchmark.md): Codex App Server의 시간·메모리 측정 방법을 설명한다.
- [OrcaQuotaComparison.md](OrcaQuotaComparison.md): Orca와 quota 조회·초기화 시각 처리 방식을 비교한다.
- [PerformanceReview.md](PerformanceReview.md): SQLite 인덱스·JSONL 파싱·Skill 집계의 성능 검토를 기록한다.
- [JsonlParsingBranches-2026-10-09.md](JsonlParsingBranches-2026-10-09.md): JSONL 파싱 방식별 비교와 선택 근거를 기록한다.
- [RequestTitleAB.md](RequestTitleAB.md): 요청 제목 TEMP 인덱스와 집계 통합 방식의 A/B 검증을 기록한다.
- [RequestTitleTransactions.md](RequestTitleTransactions.md): 요청 제목 집계의 실제 갱신·트랜잭션 측정을 기록한다.
- [SqlWrites-2026-10-26.md](benchmarks/SqlWrites-2026-10-26.md): 실제 DB와 100,000건의 증분 저장·월/일 인덱스 배치 A/B 결과를 기록한다.
- [SqlWrites-2026-10-26-Analysis.md](benchmarks/SqlWrites-2026-10-26-Analysis.md): 현재 저장 순서와 월 우선 배치의 이점·비용, 복합 인덱스와 증분 처리의 효과를 고찰한다.
- [SqlRowid-2026-10-27.md](benchmarks/SqlRowid-2026-10-27.md): 현재 증분 구현과 같은 세션 키에서 일반 rowid와 WITHOUT ROWID 집계의 조회·갱신·공간을 비교한다.
- [research/](research/README.md): UI와 다국어 지원의 조사·설계 근거를 둔다.
- [benchmarks/](benchmarks/README.md): 성능 비교 결과와 검증용 산출물을 보존한다.
