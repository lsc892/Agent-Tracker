# 2026-11-03 벤치마크 · 미채택·철회 및 검증 한계

[전체 벤치마크](../../README.md) · [같은 날짜의 제품 반영 결과](../../success/2026-11-03/README.md)

## 반영 결과

- 요청과 비용을 합치는 JOIN 절감 후보는 추가·최초 저장 회귀로 철회.
- 세션 시간 보조 인덱스 및 시각 SQL 조정은 당시 미채택.

## 보고서와 원시 자료

- [세션 시간 인덱스와 재파싱 TEMP 재사용 결과 요약](../../success/2026-11-03/SessionTimeIndexAB-summary.md).
- [SimpleIndexAB-2026-11-03.md](SimpleIndexAB-2026-11-03.md): DB 성능의 배포 적합성 판단과 인덱스 하나·작은 SQL 조정 후보의 조회/저장/공간 비교.
- [SimpleIndexAB-2026-11-03.json](SimpleIndexAB-2026-11-03.json): 단순 보조 인덱스 후보의 원시 표본·실행 계획·SQL·정확성·소스 해시.
- [SessionTimeIndexAB-2026-11-03.md](SessionTimeIndexAB-2026-11-03.md): 세션 시간 인덱스 하나만 추가했을 때 전체 갱신·쓰기 트랜잭션·DB/WAL 크기와 최초 생성 비용의 후속 A/B.
- [SessionTimeIndexAB-2026-11-03.json](SessionTimeIndexAB-2026-11-03.json): 실제 로그·합성 1만 요청의 갱신별 원시 시간·트랜잭션·공간·정확성 해시.
- [InlineCostAB-2026-11-03.md](InlineCostAB-2026-11-03.md): 핵심 세 지표, 실제·10,000건의 조회/저장·파일 공간·전환 비용과 최종 선택.
- [InlineCostAB-2026-11-03.json](InlineCostAB-2026-11-03.json): 원시 표본·SQL·실행 계획·정확성·공간·소스 해시.
