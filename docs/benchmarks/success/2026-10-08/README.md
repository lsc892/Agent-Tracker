# 2026-10-08 벤치마크 · 제품 반영

[전체 벤치마크](../../README.md)

## 반영 결과

- 초기 성능 진단을 토대로 중복 인덱스를 정리하고 조회 통계를 수집하도록 변경했다 (`717b35f`).
- 요청 제목 TEMP 부분 인덱스 채택 (`4104c55`).

## 측정 기록

SQLite 인덱스·JSONL 파싱·Skill 집계의 초기 검토와 요청 제목 비교 결과를 보존한다.

## 보고서와 원시 자료

- [PerformanceReview.md](PerformanceReview.md): 초기 성능 검토와 개선 후보.
- [PerformanceReview-2026-10-08.json](PerformanceReview-2026-10-08.json): 검토에 사용한 측정값.
- [RequestTitleAB.md](RequestTitleAB.md): 요청 제목 TEMP 인덱스와 통합 집계 A/B 보고서.
- [RequestTitleAB.json](RequestTitleAB.json): 제목 A/B 표본·SQL·실행 계획.
- [RequestTitleTransactions.md](RequestTitleTransactions.md): 실제 갱신·트랜잭션 비교 보고서.
- [RequestTitleTransactions.json](RequestTitleTransactions.json): 실제 갱신의 측정 요약.
- [RequestTitleTransactions.jsonl.gz](RequestTitleTransactions.jsonl.gz): 트랜잭션별 압축 실행 기록.
