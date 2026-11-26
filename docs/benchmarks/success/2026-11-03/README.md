# 2026-11-03 벤치마크 · 제품 반영

[전체 벤치마크](../../README.md) · [같은 날짜의 미채택·철회 및 검증 한계](../../failure/2026-11-03/README.md)

## 반영 결과

- 재파싱의 TEMP 집계 표와 인덱스 재사용 채택 (`8eba32d`). 요약에는 미채택 인덱스 대조도 포함.

## 측정 기록

요청별 비용을 본체에 합쳐 JOIN을 한 번 줄인 후보와 기존 비용 분리 구조를 비교했다. 조회·요청 한 건 추가·DB 용량의 이득과 비용을 확인한 뒤 기존 분리 방식을 유지한다.

전체 재파싱·통계 갱신의 대기를 줄이는 후속 변경은 TEMP 집계 표·인덱스를 갱신 안에서 재사용하며 실제 로그와 두 가지 합성 세션 분포로 비교한다.

## 보고서와 원시 자료

- [ReparseTempReuse-2026-11-03.md](ReparseTempReuse-2026-11-03.md): 전체 재파싱 지연과 집계 준비 구간의 변경 전후 요약·채택 근거.
- [SessionTimeIndexAB-summary.md](SessionTimeIndexAB-summary.md): 재파싱 개선과 인덱스 실험의 변경 전후 값·증감률·DB 추가량을 한눈에 보는 Markdown 요약.
- [ReparseTempReuse-real-2026-11-03.md](ReparseTempReuse-real-2026-11-03.md): 실제 로그의 전후 표본·정확성·재현 조건.
- [ReparseTempReuse-short-2026-11-03.md](ReparseTempReuse-short-2026-11-03.md): 1만 요청·100요청/세션 비교.
- [ReparseTempReuse-long-2026-11-03.md](ReparseTempReuse-long-2026-11-03.md): 1만 요청·1,000요청/세션 비교.

### 추가 자료

- [ReparseTempReuse-long-2026-11-03.json](ReparseTempReuse-long-2026-11-03.json)
- [ReparseTempReuse-real-2026-11-03.json](ReparseTempReuse-real-2026-11-03.json)
- [ReparseTempReuse-short-2026-11-03.json](ReparseTempReuse-short-2026-11-03.json)
