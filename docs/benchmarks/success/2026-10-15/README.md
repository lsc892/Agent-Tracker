# 2026-10-15 벤치마크 · 제품 반영

[전체 벤치마크](../../README.md) · [같은 날짜의 미채택·철회 및 검증 한계](../../failure/2026-10-15/README.md)

## 반영 결과

- 기존 facts 위에 일별 사전 집계 채택 (`9a2762c`). 같은 보고서에 인덱스 비교 포함.

## 측정 기록

SQL 인덱스와 일별 사전 집계의 실행 계획·시간·공간 비교를 보존한다.

## 보고서와 원시 자료

- [SqlExplainBenchmark-2026-10-15.md](SqlExplainBenchmark-2026-10-15.md): 인덱스 실험과 rollup 제품 비교의 해석.
- [SqlRollupABBenchmark-2026-10-15.json](SqlRollupABBenchmark-2026-10-15.json): rollup 후보 간 비교.
- [SqlRollupProductBenchmark-2026-10-15.json](SqlRollupProductBenchmark-2026-10-15.json): 공개 제품 API의 rollup 전후 비교.
