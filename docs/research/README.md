# research

UI·다국어·JSONL 파싱·저장소 갱신과 조회의 조사 결과와 구현 선택 근거를 둔다.

- [SummaryOrganization-2026-11-08.md](SummaryOrganization-2026-11-08.md): summary 책임별 폴더 배치와 staging·metadata 분리, 호출부·Worker 경로·동작 보존 검증을 정리한다.
- [MemoryStoreReadability-2026-11-08.md](MemoryStoreReadability-2026-11-08.md): 메모리 집계 저장의 단계별 메소드·중첩 분기·책임 주석 정리와 동작 보존 검증을 기록한다.
- [JsonlParsingOptimizationPrompt-2026-11-06.md](JsonlParsingOptimizationPrompt-2026-11-06.md): 현재 구현과 중복되는 부분을 재사용하며 memchr·SIMD 바이트 위치 검색, 줄 구간 참조·선별·파일별 병렬 처리·Map 병합·SQL 배치 저장·DTO 캐시를 비교하는 테스트 프롬프트다.
- [JsonlFileIOReferences-2026-11-06.md](JsonlFileIOReferences-2026-11-06.md): 같은 작은 JSONL 파일들을 모두 읽는 조건에서 선행 읽기·metadata 일괄 조회·API 고정 비용·파일 배치·Windows I/O 환경의 최적화 후보를 조사한다.
- [AlgorithmReferences-2026-11-05.md](AlgorithmReferences-2026-11-05.md): JSONL 파싱·dirty 증분 갱신·일/월/프로젝트/세션 집계·평균·인덱싱 레퍼런스를 쉬운 설명과 예시로 정리한다.
- [JsonlChunkParsing-2026-11-05.md](JsonlChunkParsing-2026-11-05.md): 청크 단위 디코딩의 실제 이득과 한계, 선택적 묶음 처리·청크 크기·버퍼 재사용·선행 읽기·필드 선택·native 묶음 파싱·병렬화 후보를 정리한다.
- [DateStorageQueryNotes.md](DateStorageQueryNotes.md): 날짜 OR 조건과 UNION 분리·조건 특수화의 정확성·성능을 비교한다.
- [SQLiteIndexOrder-2026-10-29.md](SQLiteIndexOrder-2026-10-29.md): 복합 인덱스의 동등·범위 조건과 날짜·세션 PK 순서의 선택법을 공식 자료와 정리한다.
- [Localization.md](Localization.md): 언어 선택·공통 번역·Webview 언어 갱신 구조를 설명한다.
- [QueryReadability-2026-10-29.md](QueryReadability-2026-10-29.md): 통계 SQL의 파일별 책임·구역 정리와 동작 보존 검증을 기록한다.
- [StatusBarPopup.md](StatusBarPopup.md): 상태바 Markdown 카드와 클릭 토글 구현의 조사 근거를 설명한다.
