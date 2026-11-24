# 2026-11-24 벤치마크

- [최근 30일 통계 A/B 커밋과 v0.3.1 대비 시간·공간 비교](HistoricalSummaryAB-2026-11-24.md) — 세 빌드의 실데이터·합성 입력 갱신, 평균 조회, 힙·RSS, 새 SQLite 파일과 기존 DB 이관 시 크기를 대조했다.
- [읽는 즉시 응답별 최고값을 고르는 스레드 집계 A/B](StreamingThreadResponseAB-2026-11-24.md) — 실로그 703파일에서 직전 응답 배열 방식과 최고값 즉시 병합 방식의 수집·메모리·집계 결과를 대조했다.
- [스레드 토큰 집계 정합성 A/B](ResponseThreadAccountingAB-2026-11-24.md) — 실제 로그 703파일의 전후 수집, 원본 독립 검산과 시간·메모리 관측을 기록했다.
- [JSONL 선택 파싱의 최초 수집 메모리 비교](SelectiveJsonlMemoryAB-2026-11-24.md) — 실로그 700파일을 새 프로세스에서 10쌍 수집해 프로세스 RSS와 메인 힙을 비교하고, 별도로 파일 Worker의 GC 표본을 확인했다.
- [파일 준비 결과의 winner 경량화 A/B](CompactWinnerAB-2026-11-24.md) — 현재 JSONL 698파일의 최초 수집을 1쌍 비교해 시간·피크 메모리·SQLite 결과를 확인했다.
- [최종 winner Map 하나로 통합한 A/B](SingleWinnerMapAB-2026-11-24.md) — 현재 로컬 1,473요청에서 전체 재수집·1건 추가·무변경 갱신을 3쌍 비교했다.
- [파일별 winner와 요청당 한 번의 UPSERT A/B](FileWinnerUpsertAB-2026-11-24.md) — 같은 입력을 3쌍 비교해 전역 winner Map 대비 최종 집계 시간과 관측 힙을 확인했다.
- [파일별 수정 시각과 원본 해시 제거 A/B](PerFileMtimeAB-2026-11-24.md) — 같은 입력으로 3쌍 비교해 재수집·파일 파싱·DB 공간 변화와 이전 DB 이관을 확인했다.
- [JSONL 선택 파싱 재실험 커밋과 현재 갱신 비교](FromSelectiveParsingAB-2026-11-24.md) — 기준 `bd5364a`와 현재를 실데이터·합성 1만 건·100건에서 비교하고, 갱신·평균 조회 시간, 피크 메모리, SQLite 크기와 알고리즘 복잡도를 기록했다.
