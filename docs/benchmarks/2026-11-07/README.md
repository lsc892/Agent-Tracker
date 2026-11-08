# 2026-11-07 벤치마크

파일 DTO 재사용·메모리 집계·직접 영속 저장 실험의 원본 보고서와 측정값을 보존한다. 후속 검증과 10만 요청 메모리 측정은 2026-11-08에 수행됐다. 보고서 B안은 2026-11-08에 `dev` 기본 갱신으로 채택했다. 보고서의 워크트리·소스 식별자와 수치는 측정 당시 기록이다.

- [A/B 보고서](JsonlMemoryIncrementalAB-2026-11-07.md): 실제·1만·100요청과 다중 원본의 갱신 시간, DTO 재사용, 알고리즘과 메모리 비용.
- [주 비교 원시 JSON](JsonlMemoryIncrementalAB-2026-11-07.json): 준비 3쌍·AB/BA 10쌍과 진단·SQL seed 전환·DB 재개방 결과.
- [다중 원본 원시 JSON](JsonlMemoryIncrementalMultiSourceAB-2026-11-07.json): 변경 없는 16 MiB 형제 파일을 둔 합성 1만 요청의 결과.
- [최종 검증](JsonlMemoryIncrementalVerification-2026-11-07.json): 워크트리의 430개 테스트·요청별 정합성·소스 및 빌드 식별자.
- [10만 요청 메모리](JsonlMemory100kMemory-2026-11-08.json): 별도 Node 프로세스 3회에서 기록한 RSS·heap과 입력 검증.
