# 2026-11-09 벤치마크

- [SourcePoolAB-2026-11-09.md](SourcePoolAB-2026-11-09.md): 파일별 읽기·파싱·winner 준비를 제한된 Worker 풀로 분배한 전후의 현재 전체·합성 10,000요청을 준비3쌍·교대10쌍 비교한다. 구간·저장 내부·평균 조회와 정확성을 기록한다. [원시 JSON](SourcePoolAB-2026-11-09.json).
- [ScanQueueAB-2026-11-09.md](ScanQueueAB-2026-11-09.md): 관계 역인덱스·작업 큐 적용 전후의 현재 전체·합성 10,000요청을 준비3쌍·교대10쌍 비교하고 최초·1건 추가·무변경의 스캔·집계·저장 구간과 정확성을 기록한다. [원시 JSON](ScanQueueAB-2026-11-09.json).
- [ScanQueueRawRangeAB-2026-11-09.md](ScanQueueRawRangeAB-2026-11-09.md): 극단 기간 필터로 raw 조회를 실행한 선행 A/B의 실제 조건을 정정하고 [원시 결과](ScanQueueRawRangeAB-2026-11-09.json)를 보존한다. [별도 구조 진단](ScanQueueStructure-2026-11-09.json)은 반복 검색·큐 작업량 비교에만 사용한다.

- [ScanStages-2026-11-09.md](ScanStages-2026-11-09.md): 현재 1,300요청·637파일과 합성 10,000요청·100파일의 최초 수집·1건 추가·무변경 갱신을 각각 1회 측정하고 탐색·원본 처리·관련 확장·집계·SQL 저장 구간을 비교한다. [원시 JSON](ScanStages-2026-11-09.json).
