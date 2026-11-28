# 2026-10-31 벤치마크 · 제품 반영

[전체 벤치마크](../../README.md) · [같은 날짜의 미채택·철회 및 검증 한계](../../failure/2026-10-31/README.md)

## 반영 결과

- 세션 기본 키 복원과 큰 세션의 선택적 묶음 저장 채택 (`54fcd34`).
- 채택한 저장 구조의 조회·쓰기 병목을 조사한 기준 자료.

## 측정 기록

월 PK 도입 실험과 사용자 목표를 갱신 트랜잭션 단축으로 정정한 후속 비교를 보존한다. 현재 코드는 집계 세션 PK를 복원하고 큰 세션의 선택적 묶음 비교를 유지한다.

## 보고서와 원시 자료

- [QueryProfile-2026-10-31.md](QueryProfile-2026-10-31.md): 현재 제품의 비용·토큰·요청·이름·도구·진단 SQL 중 가장 느린 조회와 실행 계획을 조사한다.
- [QueryProfile-2026-10-31.json](QueryProfile-2026-10-31.json): 설치 DB 사본과 합성 1만·10만 요청에서 측정한 SQL·계획·원시 표본.
- [QueryProfile-requests-without-costs-2026-10-31.json](QueryProfile-requests-without-costs-2026-10-31.json): 비용 제외 요청 목록의 기준·모델·토큰 정렬을 보완 측정한 결과.
- [WriteProfile-2026-10-31.md](WriteProfile-2026-10-31.md): 통계 진입의 최초 적재·재진입·요청 추가/변경에서 INSERT·UPDATE·TEMP·COMMIT 비용을 분리한다.
- [WriteProfile-2026-10-31.json](WriteProfile-2026-10-31.json): 실제 로그 사본과 합성 1만·10만 요청의 구간 표본·개별 SQL 누적/최대 실행 시간·직접 변경 행 수.
- [WriteProfile-detail-fixed-2026-10-31.json](WriteProfile-detail-fixed-2026-10-31.json): 일회성 statement를 보관하지 않도록 계측기를 보완한 10만 요청 최초 적재의 최종 상세 SQL 시간.
- [StorageTransactions-2026-10-31.md](StorageTransactions-2026-10-31.md): 갱신 목표에 맞춘 월 PK 철회와 저장 호출·쓰기 트랜잭션의 직접 비교.
- [StorageTransactions-2026-10-31.json](StorageTransactions-2026-10-31.json): 같은 PK의 일괄/묶음 저장과 같은 저장 방식의 세션/월 PK를 교차 비교한 원시 결과.
- [StorageTransactions-sources-2026-10-31.zip](StorageTransactions-sources-2026-10-31.zip): 후속 비교의 제품 소스·빌드 snapshot.
