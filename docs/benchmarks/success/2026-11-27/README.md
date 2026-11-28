# 2026-11-27 벤치마크 · 제품 반영

[전체 벤치마크](../../README.md)

- [턴 누계 직접 검산과 일별 삭제 키 A/B](TurnCheckAndDailyDeleteAB-2026-11-27.md) — 최초 수집의 피크 힙과 일별 저장 시간을 줄였다.
- [대화·응답 키 직렬화 절감 A/B](AggregationCandidateKeysAB-2026-11-27.md) — 실로그 최초 수집의 피크 힙과 메모리 집계 시간을 줄였다.
- [JSONL 긴 줄 연속 복사와 버퍼 재사용 A/B](JsonlRowBufferReuseAB-2026-11-27.md) · [원시 표본](JsonlRowBufferReuseAB-2026-11-27.json)
- [Codex 행 접두사와 응답 winner A/B](PrefixWinnerAB-2026-11-27.md) — 실로그·합성 입력의 정합성, 갱신 시간, 평균 조회와 V8 힙을 비교했다.
