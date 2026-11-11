# 2026-11-09 조사 자료

- [ScannerResponsibilities-2026-11-09.md](ScannerResponsibilities-2026-11-09.md): 긴 scanner 진입점의 상태·탐색·준비·관계·집계·저장 책임을 refresh 하위 폴더로 분리하고 처리 순서와 참조 공유를 보존한 기록이다.
- [SourcePoolReadability-2026-11-09.md](SourcePoolReadability-2026-11-09.md): 두 서브에이전트가 Worker 배정·완료·실패와 스캐너의 논리 결과 반영을 기존 파일 안에서 정리한 통합 기록이다.
- [SourcePoolOrderAudit-2026-11-09.md](SourcePoolOrderAudit-2026-11-09.md): Worker 완료 순서와 논리 반영·저장 순서를 추적하고 기존 A/B 20쌍의 원시 결과·보존 DB를 읽기 전용으로 대조한다. 순서 오류의 근거와 조기 종료 후보의 분석 한계를 구분한다. [분석 JSON](SourcePoolOrderAudit-2026-11-09.json).
- [DtoLifetimePlan-2026-11-09.md](DtoLifetimePlan-2026-11-09.md): 읽지 않은 파일의 상태 재저장을 줄이고 DTO 수명·반복 검색 비용을 줄이는 알고리즘을 제안한다.
- [ScanAlgorithms-2026-11-09.md](ScanAlgorithms-2026-11-09.md): 작업 큐·관계 색인·변경 파일 추적·제한된 동시성과 append checkpoint의 공식 레퍼런스·정확성 제약을 정리한다. [후속 1회 구간 측정](../../benchmarks/2026-11-09/ScanStages-2026-11-09.md)에서 현재·10,000요청의 실제 비용을 확인했고, 역인덱스·작업 큐 구현은 [반복 A/B](../../benchmarks/2026-11-09/ScanQueueAB-2026-11-09.md)로 비교했다. watcher·metadata 동시성·checkpoint는 보류했다.
- [ScanStorageProfile-2026-11-09.json](ScanStorageProfile-2026-11-09.json): 스캔·SQL 저장 구간별 원시 계측 결과를 보존한다.
- [ScanStorageProfile-2026-11-09.md](ScanStorageProfile-2026-11-09.md): 실데이터 스캔·SQL 저장 구간별 계측과 적용 범위·개선 우선순위를 정리한다.
- [SqlAggregationReferences-2026-11-09.md](SqlAggregationReferences-2026-11-09.md): 평균의 SUM/COUNT 상태·SQLite 복합 인덱스·WITHOUT ROWID clustering·변경 버킷 재집계를 조사한다.
