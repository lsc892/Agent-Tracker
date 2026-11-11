# 2026-10-25 벤치마크

날짜 저장 순서·집계 기본 키·조회 SQL·정렬 인덱스의 비교 결과와 SQLite 결과 누락 재현을 보존한다.

- [날짜 저장 A/B 보고서](../../DateStorageAB-2026-10-25.md): 실험 조건·후보별 측정값·정확성 제약과 선택 근거.
- [날짜 조건 SQL 상세 분석](../../research/2026-10-25/DateStorageQueryNotes.md): OR 조건·UNION 분리·조건 특수화의 비교.

- [DateStorageProfile-2026-10-25.json](DateStorageProfile-2026-10-25.json): 설치 DB를 읽기 전용으로 조사한 행 수·페이지·인덱스 할당량을 보존한다.
- [DateStorageRaw-2026-10-25.json](DateStorageRaw-2026-10-25.json): 날짜순 입력과 요청 날짜 인덱스 후보의 조회·쓰기·저장 공간을 비교한다.
- [DateStorageRollup-2026-10-25.json](DateStorageRollup-2026-10-25.json): 일별 집계 기본 키 순서와 세션 보완 인덱스의 결과를 비교한다.
- [DateStorageQuery-2026-10-25.json](DateStorageQuery-2026-10-25.json): 날짜 OR 조건의 UNION 분리·특수화 결과를 보존한다.
- [DateStorageOrder-2026-10-25.json](DateStorageOrder-2026-10-25.json): 실제 요청 정렬과 일치하는 표현식 인덱스의 비용·효과를 비교한다.
- [DateStorageSqliteRepro-2026-10-25.json](DateStorageSqliteRepro-2026-10-25.json): 날짜 선두 PK와 OR 계획에서 관측한 결과 누락의 최소 재현을 보존한다.
- [DateStorageSqliteReproVSCode-2026-10-25.json](DateStorageSqliteReproVSCode-2026-10-25.json): 설치 VS Code의 SQLite 3.53.4에서도 같은 결과 누락이 발생하는지 대조한다.

보존된 실행기의 기본 출력 경로는 당시 위치를 사용한다. 재실행할 때 `--output=docs/benchmarks/2026-10-25/<파일명>.json`으로 보관 위치를 지정한다.

[전체 날짜](../README.md)
