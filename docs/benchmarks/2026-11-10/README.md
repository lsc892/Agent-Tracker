# 2026-11-10 벤치마크

- [v0.2.0 → 최신 dev 구간 A/B](VersionStagesAB-2026-11-10.md): 실제·10,000·100요청의 수집·재파싱·요청 추가와 알고리즘 구간·평균 토큰 조회를 예열 3쌍·교대 10쌍 비교했다. 실제 입력은 A 1,075요청 → B 809요청으로 결과 동등성이 실패해 참고 관측값으로 남겼고, 동일 결과의 성능 판정은 합성 두 규모만 통과했다. 이 버전 비교의 결과·입력 정보·진단은 Markdown 로그에 보존하고 실험 실행기·원시 JSON·소스 ZIP·워크트리는 사용자 요청에 따라 정리했다.

- [MetadataBatchAB-2026-11-10.md](MetadataBatchAB-2026-11-10.md): 현재 805요청·합성 10,000요청에서 최종 이름·세션 결제 설정 중복 제거를 각 1회 비교한다. 키별 UPSERT·설정 SELECT·후단 이름 UPDATE 횟수와 저장·조회·실패 경계를 기록한다. [A/B JSON](MetadataBatchAB-2026-11-10.json), [검증 요약](MetadataBatchValidation-2026-11-10.json), [transaction 검증](MetadataBatchTransactionValidation-2026-11-10.json).

- [RollupTrimAB-2026-11-10.md](RollupTrimAB-2026-11-10.md): 이 노트북의 현재 798요청·합성 10,000요청으로 미사용 집계 지표 제거 전후를 각 1회 비교한다. 갱신·평균 조회·공간·기존 DB 전환 비용과 정리 전에도 재현되는 테스트 실패를 기록한다. [A/B JSON](RollupTrimAB-2026-11-10.json), [전환 측정](RollupTrimUpgrade-2026-11-10.json), [검증 요약](RollupTrimValidation-2026-11-10.json).

- [PerformanceHandoff-2026-11-10.md](PerformanceHandoff-2026-11-10.md): 다른 세션의 시작점. 적용·커밋 상태, 최종 B의 남은 병목·미구현 후보·관련 코드, 다음 A/B의 기준 구현과 로컬 입력 사본의 전달 범위를 정리한다.
- [RollupBatchAB-2026-11-10.md](RollupBatchAB-2026-11-10.md): 저장 묶음의 최종 facts에서 변경 세션을 한 번에 rollup한 전후를 현재 1,346요청·합성 10,000요청으로 준비 3쌍·교대 10쌍 비교한다. SQL 호출 수·PK 접근 계획·rollup/저장/전체 갱신·평균 조회와 반복 snapshot·롤백·취소·캐시 경계를 기록한다. [A/B JSON](RollupBatchAB-2026-11-10.json), [실행계획](RollupBatchPlans-2026-11-10.json), [rollup 검증](RollupBatchValidation-2026-11-10.json), [transaction 검증](RollupBatchTransactionValidation-2026-11-10.json), [소스·빌드 ZIP](RollupBatchAB-sources-2026-11-10.zip), [파일별 SHA](RollupBatchAB-sources-2026-11-10.json).
- [TransactionBatchAB-2026-11-10.md](TransactionBatchAB-2026-11-10.md): 현재 1,341요청과 합성 10,000요청의 트랜잭션 상위 두 구간을 확인하고 정상 성분 최대 16개·1,000요청의 묶음 저장을 준비 3쌍·교대 10쌍 비교한다. COMMIT·전체 저장·전체 갱신·제공자/모델 평균 조회와 거래당 유지 시간, 실패·취소·보존·재연결 검증을 기록한다. [원시 JSON](TransactionBatchAB-2026-11-10.json), [정확성 JSON](TransactionBatchValidation-2026-11-10.json), [소스·빌드 ZIP](TransactionBatchAB-sources-2026-11-10.zip), [파일별 SHA](TransactionBatchAB-sources-2026-11-10.json).
