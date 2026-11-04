# 2026-11-03

요청별 비용을 본체에 합쳐 JOIN을 한 번 줄인 후보와 기존 비용 분리 구조를 비교했다. 조회·요청 한 건 추가·DB 용량의 이득과 비용을 확인한 뒤 기존 분리 방식을 유지한다.

- [SimpleIndexAB-2026-11-03.md](SimpleIndexAB-2026-11-03.md): DB 성능의 배포 적합성 판단과 인덱스 하나·작은 SQL 조정 후보의 조회/저장/공간 비교.
- [SimpleIndexAB-2026-11-03.json](SimpleIndexAB-2026-11-03.json): 단순 보조 인덱스 후보의 원시 표본·실행 계획·SQL·정확성·소스 해시.
- [InlineCostAB-2026-11-03.md](InlineCostAB-2026-11-03.md): 핵심 세 지표, 실제·10,000건의 조회/저장·파일 공간·전환 비용과 최종 선택.
- [InlineCostAB-2026-11-03.json](InlineCostAB-2026-11-03.json): 원시 표본·SQL·실행 계획·정확성·공간·소스 해시.
