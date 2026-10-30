# 2026-10-31

월 PK 도입 실험과 사용자 목표를 갱신 트랜잭션 단축으로 정정한 후속 비교를 보존한다. 현재 코드는 집계 세션 PK를 복원하고 큰 세션의 선택적 묶음 비교를 유지한다.

- [StorageTransactions-2026-10-31.md](StorageTransactions-2026-10-31.md): 갱신 목표에 맞춘 월 PK 철회와 저장 호출·쓰기 트랜잭션의 직접 비교.
- [StorageTransactions-2026-10-31.json](StorageTransactions-2026-10-31.json): 같은 PK의 일괄/묶음 저장과 같은 저장 방식의 세션/월 PK를 교차 비교한 원시 결과.
- [StorageTransactions-sources-2026-10-31.zip](StorageTransactions-sources-2026-10-31.zip): 후속 비교의 제품 소스·빌드 snapshot.

- [StorageProduct-2026-10-31.md](StorageProduct-2026-10-31.md): 케이스별 시간·영속 공간·TEMP·WAL 트레이드오프와 구현 선택 근거.
- [StorageProduct-final-2026-10-31.json](StorageProduct-final-2026-10-31.json): 최종 schema v15·세션/월 목록·1,000건 기준 선택적 묶음 비교의 완전한 제품 측정.
- [StorageProduct-sources-2026-10-31.zip](StorageProduct-sources-2026-10-31.zip): 전후 제품 소스·빌드 snapshot. DB 사본·원본 로그는 포함하지 않는다.
- [StorageProduct-month-2026-10-31.json](StorageProduct-month-2026-10-31.json): 최초 월 PK 적용의 제품 대조.
- [StorageProduct-hybrid-2026-10-31.json](StorageProduct-hybrid-2026-10-31.json): 최초 월 PK와 300건 기준 묶음 비교. 세션 갱신 전체 스캔 회귀를 확인한 진단 결과.
- [StorageProduct-candidate300-2026-10-31.json](StorageProduct-candidate300-2026-10-31.json): 월 prefix 삭제 보완 후 300건 임계값 후보를 평가한 결과.
- [StorageProduct-preDirectory-2026-10-31.json](StorageProduct-preDirectory-2026-10-31.json): 1,000건 임계값을 적용했지만 세션·월 목록을 도입하기 전 결과. 세션 조회 회귀의 진단 근거.
- [StorageProduct-directoryV1-2026-10-31.json](StorageProduct-directoryV1-2026-10-31.json): 세션 조회를 보완했지만 월 목록 갱신의 IN 조건이 넓은 범위를 읽던 중간 결과. 최종 구현은 작은 월 키부터 PK를 탐색한다.
