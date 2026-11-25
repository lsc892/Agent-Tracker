# 2026-11-25 벤치마크

- [청크별 JSONL 필드 선택 A/B](StreamingJsonlProjectionAB-2026-11-25.md)에서는 일반·압축 로그의 파일 준비 시간과 피크 메모리를 빌드별 1회 비교했다.
- [SQLite 보조 인덱스 제거 A/B](SQLiteIndexRemovalAB-2026-11-25.md)에서는 실로그와 합성 10,000·100건의 갱신, 조회, DB 크기를 대조했다.
- [SQLite 일별 기본 키 날짜 우선 A/B](DailyDateClusterAB-2026-11-25.md)에서는 같은 입력에서 세션 우선과 날짜 우선의 시간, DB 크기와 실행 계획을 비교했다.
