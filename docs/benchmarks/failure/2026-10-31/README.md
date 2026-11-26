# 2026-10-31 벤치마크 · 미채택·철회 및 검증 한계

[전체 벤치마크](../../README.md) · [같은 날짜의 제품 반영 결과](../../success/2026-10-31/README.md)

## 반영 결과

- 월 기본 키와 세션·월 목록 구현은 후속 쓰기 비교 후 철회.
- 일별 집계를 제거하는 인덱스 중심 대안은 제품 미반영.

## 보고서와 원시 자료

- [StorageProduct-2026-10-31.md](StorageProduct-2026-10-31.md): 케이스별 시간·영속 공간·TEMP·WAL 트레이드오프와 구현 선택 근거.
- [StorageProduct-final-2026-10-31.json](StorageProduct-final-2026-10-31.json): 최종 schema v15·세션/월 목록·1,000건 기준 선택적 묶음 비교의 완전한 제품 측정.
- [StorageProduct-sources-2026-10-31.zip](StorageProduct-sources-2026-10-31.zip): 전후 제품 소스·빌드 snapshot. DB 사본·원본 로그는 포함하지 않는다.
- [StorageProduct-month-2026-10-31.json](StorageProduct-month-2026-10-31.json): 최초 월 PK 적용의 제품 대조.
- [StorageProduct-hybrid-2026-10-31.json](StorageProduct-hybrid-2026-10-31.json): 최초 월 PK와 300건 기준 묶음 비교. 세션 갱신 전체 스캔 회귀를 확인한 진단 결과.
- [StorageProduct-candidate300-2026-10-31.json](StorageProduct-candidate300-2026-10-31.json): 월 prefix 삭제 보완 후 300건 임계값 후보를 평가한 결과.
- [StorageProduct-preDirectory-2026-10-31.json](StorageProduct-preDirectory-2026-10-31.json): 1,000건 임계값을 적용했지만 세션·월 목록을 도입하기 전 결과. 세션 조회 회귀의 진단 근거.
- [StorageProduct-directoryV1-2026-10-31.json](StorageProduct-directoryV1-2026-10-31.json): 세션 조회를 보완했지만 월 목록 갱신의 IN 조건이 넓은 범위를 읽던 중간 결과. 최종 구현은 작은 월 키부터 PK를 탐색한다.

### 추가 자료

- [DbTradeoff-index-only-focused.md](DbTradeoff-index-only-focused.md)
- [DbTradeoff-index-only-focused-month.json](DbTradeoff-index-only-focused-month.json)
- [DbTradeoff-index-only-focused-staging-plan.json](DbTradeoff-index-only-focused-staging-plan.json)
- [DbTradeoff-index-only-focused.json](DbTradeoff-index-only-focused.json)
- [DbTradeoff-index-only.json](DbTradeoff-index-only.json)
