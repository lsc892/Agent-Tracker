# 2026-11-21 벤치마크 · 제품 반영

[전체 벤치마크](../../README.md) · [같은 날짜의 미채택·철회 및 검증 한계](../../failure/2026-11-21/README.md)

## 반영 결과

- 행별 JSONL 디코딩 채택 (`45800fc`).
- 최근 30일 미리보기 기능 채택 (`b7fce1f`).
- 전역 수정 시각을 사용한 증분 갱신 채택 (`9c543bc`). 이후 파일별 수정 시각 방식으로 교체.

## 보고서와 원시 자료

- [JSONL 행별 디코딩 제품 A/B](JsonlLineProductAB-2026-11-21.md)에 수정 전후 실제 빌드의 파싱 시간과 RSS·V8 Heap을 기록했다. [원시 표본](JsonlLineProductAB-2026-11-21.json).
- [통계 첫 화면 A/B](DashboardFirstPageAB-2026-11-21.md)에 VS Code 창과 첫 통계 렌더링 시간을 기록했다. [빈 DB 원시 표본](DashboardFirstPageAB-2026-11-21.json), [일별 집계가 준비된 DB 원시 표본](DashboardFirstPageWarmAB-2026-11-21.json).
- [JSONL 수정 시각 갱신 A/B](MtimeRefreshAB-2026-11-21.md)에 시간·본문 읽기·메모리와 정합성 검증을 기록했다.
- [원시 측정 결과](MtimeRefreshAB-2026-11-21.json)에 고정 입력과 실행 빌드의 해시, 개별 시간과 메모리 표본을 보존했다.
