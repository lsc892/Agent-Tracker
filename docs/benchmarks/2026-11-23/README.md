# 2026-11-23

- [응답별 차분 적용 A/B](AppliedResponseDeltaAB-2026-11-23.md)는 원본별 후보를 영속 저장하던 방식과 응답별 마지막 반영값만 저장하는 방식을 비교한다. [원시 표본](AppliedResponseDeltaAB-2026-11-23.json).
- [원본별 winner 영속 저장 A/B](PersistentWinnerRefreshAB-2026-11-23.md)는 JSONL 선택 파싱 재실험 커밋과 파싱 후 기존 후보를 대조하는 구현을 비교한다. [원시 표본](PersistentWinnerRefreshAB-2026-11-23.json).
- [SQLite 임시 winner A/B](SQLiteWinnerRefreshAB-2026-11-23.md)는 같은 기준 커밋과 파싱 후보를 임시 테이블에 넣고 다시 읽던 구현을 비교한다. [원시 표본](SQLiteWinnerRefreshAB-2026-11-23.json).
