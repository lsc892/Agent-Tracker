# 2026-11-06 벤치마크

JSONL 파싱·DTO 적재·파일 캐시·구간별 비용을 비교한 실험 기록이다. 같은 실험의 2026-11-07 후속 분석도 함께 보관한다. 아래 수치는 당시 구현의 결과이며 현재 `dev`의 동작은 [메모리 최종 집계 A/B](../2026-11-07/JsonlMemoryIncrementalAB-2026-11-07.md)를 따른다.

실험 워크트리는 2026-11-08에 정리했다. 보고서·원시 JSON·검증 기록을 보존하며 과거 실행 명령과 소스·빌드 해시는 측정 당시 식별자다. 채택하지 않은 실험 구현·실행기·로컬 캐시와 입력 사본은 보관하지 않는다. [보관 파일과 해시](../WorktreeArchive-2026-11-08.json)에서 원본과 보관본을 대조할 수 있다.

- [JSONL 파싱·중복 제거 A/B](JsonlParsingOptimizationAB-2026-11-06.md): 청크 줄 구간 참조, 전체 Buffer와 Map 승자 선택의 시간·메모리·오류 계약 및 채택 판단.
- [실제 갱신 원시 결과](JsonlParsingRefreshAB-2026-11-06.json), [R1 읽기](JsonlParsingReaderR1AB-2026-11-06.json), [R2 읽기](JsonlParsingReaderR2AB-2026-11-06.json), [R1→R2 비교](JsonlParsingReaderR1R2AB-2026-11-06.json), [Map 중복 제거](JsonlParsingDedupAB-2026-11-06.json), [R2 오류 계약](JsonlParsingReaderR2Validation-2026-11-06.json), [검증 기록](JsonlParsingVerification-2026-11-06.json).
- [메모리 Map 적재 A/B](JsonlMapIngestionAB-2026-11-06.md): 전체 DTO를 보관한 뒤 중복을 제거해 SQL에 적재한 최초 후보. 이름 metadata SQL transaction의 후속 원인 분석을 포함한다.
- [Map 원시 결과](JsonlMapIngestionAB-2026-11-06.json), [Map 검증](JsonlMapIngestionVerification-2026-11-06.json), [최초 DTO 복원 검증](JsonlDtoRestoreVerification-2026-11-06.json).
- [Greedy Map A/B와 철회 이유](JsonlGreedyMapAB-2026-11-06.md): 보정 전 승자 DTO만 남긴 후보의 정합성·비용과 최초 DTO 방식으로 복원한 근거.
- [Greedy 원시 결과](JsonlGreedyMapAB-2026-11-06.json), [Greedy 검증](JsonlGreedyMapVerification-2026-11-06.json).
- [파일 DTO·응답 후보 재사용 A/B](JsonlSourceCacheAB-2026-11-06.md): 같은 연결의 후속 갱신, DB 재개방과 변경 없는 형제 파일의 캐시 효과.
- [파일 캐시 원시 결과](JsonlSourceCacheAB-2026-11-06.json), [다중 원본 결과](JsonlSourceCacheMultiSourceAB-2026-11-06.json), [캐시 검증](JsonlSourceCacheVerification-2026-11-06.json).
- [SQL TEMP와 파일 캐시 Map의 구간별 비용](JsonlStageCostAB-2026-11-06.md): 읽기·DTO·INSERT·winner·서명·저장의 시간과 heap·TEMP 공간 비교.
- [구간별 원시 결과](JsonlStageCostAB-2026-11-06.json), [구간별 검증](JsonlStageCostVerification-2026-11-06.json).
- [이름 SQL batch 진단](JsonlNameBatchDiagnostic-2026-11-06.json), [빈 스캔 통제](JsonlNameBatchEmptyScanControl-2026-11-06.json), [메모리 통제](JsonlNameBatchMemoryControl-2026-11-06.json), [기존 DB 스캔 통제](JsonlNameBatchPopulatedScanControl-2026-11-06.json): 이름 metadata의 SQL transaction 유무와 파싱 계측 영향을 분리한 기록.
