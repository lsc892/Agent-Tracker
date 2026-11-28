# 2026-11-07 벤치마크 · 미채택·철회 및 검증 한계

[전체 벤치마크](../../README.md) · [같은 날짜의 제품 반영 결과](../../success/2026-11-07/README.md)

## 반영 결과

- 패자 영구 폐기·즉시 winner 선택은 정합성 또는 재파싱 비용으로 미채택.

## 보고서와 원시 자료

- [Greedy 최소 보관 A/B](JsonlGreedyMinimalAB-2026-11-07.md): 패자 후보를 보관하지 않고 예외 재파싱으로 복구한 후보의 시간·메모리와 한계.
- [Greedy 원시 결과](JsonlGreedyMinimalAB-2026-11-07.json), [Greedy 검증](JsonlGreedyMinimalVerification-2026-11-07.json).
- [읽는 즉시 winner만 남기는 정합성 실험](JsonlOnlineGreedyCorrectness-2026-11-07.md): 실제 580개 파일에서 유효성·최종 귀속을 생략했을 때의 차이와 통제 결과.
- [즉시 선택 원시 결과](JsonlOnlineGreedyCorrectness-2026-11-07.json), [즉시 선택 검증](JsonlOnlineGreedyVerification-2026-11-07.json).
