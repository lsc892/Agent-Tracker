# 2026-11-23 벤치마크 · 미채택·철회 및 검증 한계

[전체 벤치마크](../../README.md) · [같은 날짜의 제품 반영 결과](../../success/2026-11-23/README.md)

## 반영 결과

- 임시 테이블에 원본별 winner를 저장한 제품 작업 빌드. 같은 갱신의 쓰기·복원 비용 때문에 후속 구현에서 대체.
- 원본별 winner의 영속 저장은 v22 작업 빌드까지 구현. 최종 `76f8ea7`에는 후보 표 대신 응답별 마지막 반영값 적용.
- v22 보조 인덱스 9개를 제거한 조회 실험은 당시 제품에 반영하지 않았다. 후속 스키마에서 별도 검증한 [보조 인덱스 6개 제거](../../success/2026-11-25/SQLiteIndexRemovalAB-2026-11-25.md)가 채택됐다.

## 보고서와 원시 자료

- [v22 인덱스 제거 조회 실험](DbTradeoff-IndexRemovalExplain.md) · [원시 표본과 실행 계획](DbTradeoff-IndexRemovalExplain.json).
- [원본별 winner 영속 저장 A/B](PersistentWinnerRefreshAB-2026-11-23.md)는 JSONL 선택 파싱 재실험 커밋과 파싱 후 기존 후보를 대조하는 구현을 비교한다. [원시 표본](PersistentWinnerRefreshAB-2026-11-23.json).
- [SQLite 임시 winner A/B](SQLiteWinnerRefreshAB-2026-11-23.md)는 같은 기준 커밋과 파싱 후보를 임시 테이블에 넣고 다시 읽던 구현을 비교한다. [원시 표본](SQLiteWinnerRefreshAB-2026-11-23.json).
