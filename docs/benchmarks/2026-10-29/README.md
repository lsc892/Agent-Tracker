# 2026-10-29 벤치마크

증분 저장 적용 직전·직후 워크트리를 각각 빌드하고 실제 대화 사본과 합성 10만 요청의 전체 갱신·DB 저장 비용을 비교한다.

- [IncrementalRefresh-2026-10-29.md](IncrementalRefresh-2026-10-29.md): 시나리오별 결과·측정 범위·정확성 검증.
- [RefreshRollback-2026-10-29.md](RefreshRollback-2026-10-29.md): 현재 소스의 증분 저장 롤백, 실제/10,000건의 갱신 단계·INSERT/DELETE·주요 통계 조회 비교와 원인 분석, 증분 유지·복원으로 성능 권고를 정정한 후속 판단.
- [IncrementalRefresh-2026-10-29.json](IncrementalRefresh-2026-10-29.json): 반복 표본·소스 해시·읽기량·WAL·결과 해시.
- [IncrementalScale-100000-2026-10-29.md](IncrementalScale-100000-2026-10-29.md): 요청 10만 건의 세션 밀도별 전후 증감률 비교.
- [IncrementalScale-100000-100-2026-10-29.md](IncrementalScale-100000-100-2026-10-29.md): 1,000개 세션에 100건씩 배치한 전체 표본과 검증.
- [IncrementalScale-100000-10000-2026-10-29.md](IncrementalScale-100000-10000-2026-10-29.md): 10개 세션에 10,000건씩 배치한 전체 표본과 검증.
- [재현 실행기](../../../tests/benchmarks/incremental-refresh.cjs): 실제 로그 고정 사본 또는 요청 수·세션 밀도를 지정한 합성 입력으로 같은 절차를 실행한다.

[전체 날짜](../README.md)
