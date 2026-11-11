# 2026-11-10 조사·정리

- [UnifiedStreamingStats-2026-11-10.md](UnifiedStreamingStats-2026-11-10.md): 원본 순회 중 요청 상태·최신 check·도구 중복·winner를 누적하고 metadata 재생·정렬·반복 정규화를 제거했다. 현재 823요청·합성 10,000요청의 저장·진단·평균 정합성을 대조했다.

- [MetadataBatch-2026-11-10.md](MetadataBatch-2026-11-10.md): 최종 프로젝트·세션 이름을 키별로 모아 저장하고 세션 결제 설정 조회와 후단 이름 갱신의 반복을 줄이는 알고리즘.

- [RollupTrim-2026-11-10.md](RollupTrim-2026-11-10.md): 사용하지 않는 공통 집계 지표와 모델별 최소 시각 제거, 기존 DB 전환과 기능 보존 근거.

- [QueryIndexTableReferences-2026-11-10.md](QueryIndexTableReferences-2026-11-10.md): Home Assistant·TimescaleDB·pg_ivm·GitLab의 쿼리·복합 인덱스·테이블·증분 집계 사례와 현재 적용 범위·추가 후보를 대조한다.

- [FixedFeatureQueryDesign-2026-11-10.md](FixedFeatureQueryDesign-2026-11-10.md): 현재 기능을 고정하고 중복 집계·coverage·상세 조회·비교 SQL을 줄이는 쿼리, 관계 요약·비용 daily와 기간 인덱스의 목표 구조를 제안한다.
