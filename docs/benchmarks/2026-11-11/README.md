# 2026-11-11 벤치마크

- [AlgorithmMinimizeAB-2026-11-11.md](AlgorithmMinimizeAB-2026-11-11.md): 현재 1,360·10,000·100요청의 알고리즘 최소화 전후를 준비 3쌍·교대 10쌍으로 비교한 결과와 회귀·검증 한계.
- [최종 원시 표본](AlgorithmMinimizeAB-2026-11-11.json): SQL wrapper를 설치하지 않은 갱신·조회·세션 결제 타이밍과 A/B 정합성.
- [참고 관측](AlgorithmMinimizeWrappedAB-2026-11-11.json): 비활성 SQL wrapper가 남았던 첫 실행. 최종 성능 판정에서 제외했다.
- [DB 검증](AlgorithmMinimizeDbValidation-2026-11-11.json), [파싱·계보 검증](AlgorithmMinimizeParsingValidation-2026-11-11.json), [쿼리 경계](AlgorithmMinimizeQueryBoundaryValidation-2026-11-11.json), [거래 경계](AlgorithmMinimizeTransactionValidation-2026-11-11.json), [관련 Node 테스트](AlgorithmMinimizeFocusedTests-2026-11-11.json): 독립 기대값·페이지·복구·보존과 기존 실패 대조.
- [소스·빌드·실행기 ZIP](AlgorithmMinimizeSources-2026-11-11.zip), [보관 SHA 명세](AlgorithmMinimizeSources-2026-11-11.json): 입력 로그·비공개 이름 metadata·DB 없이 고정한 A/B 구현을 보존한다.
