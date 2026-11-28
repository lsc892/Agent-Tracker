# 2026-11-08 벤치마크 · 제품 반영

[전체 벤치마크](../../README.md) · [같은 날짜의 미채택·철회 및 검증 한계](../../failure/2026-11-08/README.md)

## 반영 결과

- 부모 DTO 차분과 자식 독립 요청 제거 채택 (`2ec4323`).
- 원본 단일 읽기 winner 집계 채택 (`e1b6e5e`).
- 채택·미채택을 함께 기록한 워크트리 보관 명세.

## 보고서와 원시 자료

- [부모 DTO 차분 집계 A/B](ParentDtoDeltaAB-2026-11-08.md): 현재 실제 JSONL 620파일만 준비 1쌍·교대 3쌍으로 비교한다. 자식 독립 요청 제거와 부모 합산에 따른 값 변화를 별도 oracle로 검증하고, 기존 DB의 parser 16→17 갱신도 대조한다.
- [부모 DTO 원시 표본](ParentDtoDeltaAB-2026-11-08.json), [귀속·업데이트 검증](ParentDtoDeltaVerification-2026-11-08.json), [실제 계보 조사](ParentDtoLineage-2026-11-08.json).
- [단일 읽기 winner A/B](SinglePassWinnerAB-2026-11-08.md): 두 번 읽던 직전 구현과 원본 한 번 읽기·winner DTO 갱신·패자 폐기를 수행하는 구현을 같은 1,518·1만·100요청으로 비교한다. 패자 모델을 별도 표시하지 않는 사용자 결정도 기록한다.
- [단일 읽기 원시 표본](SinglePassWinnerAB-2026-11-08.json): 고정 빌드·입력, 교대 10쌍의 시간·heap·본문 읽기·정확성 검증 결과.
- [단일 읽기 검증](SinglePassWinnerVerification-2026-11-08.json): 415개 테스트·패자 모델 기준·입력 복원·소스 식별·실행 명령을 기록한다.
- [워크트리 보관 명세](WorktreeArchive-2026-11-08.json): 실험 워크트리에서 보존한 파일의 원본·보관본 SHA-256과 중복 보고서 선택 근거.
