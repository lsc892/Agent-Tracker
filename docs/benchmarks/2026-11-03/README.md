# 2026-11-03

요청별 비용을 본체에 합쳐 JOIN을 한 번 줄인 후보와 기존 비용 분리 구조를 비교했다. 조회·요청 한 건 추가·DB 용량의 이득과 비용을 확인한 뒤 기존 분리 방식을 유지한다.

전체 재파싱·통계 갱신의 대기를 줄이는 후속 변경은 TEMP 집계 표·인덱스를 갱신 안에서 재사용하며 실제 로그와 두 가지 합성 세션 분포로 비교한다.

- [ReparseTempReuse-2026-11-03.md](ReparseTempReuse-2026-11-03.md): 전체 재파싱 지연과 집계 준비 구간의 변경 전후 요약·채택 근거.
- [SessionTimeIndexAB-summary.md](SessionTimeIndexAB-summary.md): 재파싱 개선과 인덱스 실험의 변경 전후 값·증감률·DB 추가량을 한눈에 보는 Markdown 요약.
- [ReparseTempReuse-real-2026-11-03.md](ReparseTempReuse-real-2026-11-03.md): 실제 로그의 전후 표본·정확성·재현 조건.
- [ReparseTempReuse-short-2026-11-03.md](ReparseTempReuse-short-2026-11-03.md): 1만 요청·100요청/세션 비교.
- [ReparseTempReuse-long-2026-11-03.md](ReparseTempReuse-long-2026-11-03.md): 1만 요청·1,000요청/세션 비교.
- [SimpleIndexAB-2026-11-03.md](SimpleIndexAB-2026-11-03.md): DB 성능의 배포 적합성 판단과 인덱스 하나·작은 SQL 조정 후보의 조회/저장/공간 비교.
- [SimpleIndexAB-2026-11-03.json](SimpleIndexAB-2026-11-03.json): 단순 보조 인덱스 후보의 원시 표본·실행 계획·SQL·정확성·소스 해시.
- [SessionTimeIndexAB-2026-11-03.md](SessionTimeIndexAB-2026-11-03.md): 세션 시간 인덱스 하나만 추가했을 때 전체 갱신·쓰기 트랜잭션·DB/WAL 크기와 최초 생성 비용의 후속 A/B.
- [SessionTimeIndexAB-2026-11-03.json](SessionTimeIndexAB-2026-11-03.json): 실제 로그·합성 1만 요청의 갱신별 원시 시간·트랜잭션·공간·정확성 해시.
- [InlineCostAB-2026-11-03.md](InlineCostAB-2026-11-03.md): 핵심 세 지표, 실제·10,000건의 조회/저장·파일 공간·전환 비용과 최종 선택.
- [InlineCostAB-2026-11-03.json](InlineCostAB-2026-11-03.json): 원시 표본·SQL·실행 계획·정확성·공간·소스 해시.
