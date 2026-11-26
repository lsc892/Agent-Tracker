# 2026-11-25 벤치마크 · 제품 반영

[전체 벤치마크](../../README.md) · [같은 날짜의 미채택·철회 및 검증 한계](../../failure/2026-11-25/README.md)

## 반영 결과

- 긴 JSONL 행의 청크별 필드 선택 채택 (`20eb14e`).
- SQLite 보조 인덱스 6개 제거 채택 (`a9b1290`).

## 보고서와 원시 자료

- [청크별 JSONL 필드 선택 A/B](StreamingJsonlProjectionAB-2026-11-25.md)에서는 일반·압축 로그의 파일 준비 시간과 피크 메모리를 빌드별 1회 비교했다.
- [SQLite 보조 인덱스 제거 A/B](SQLiteIndexRemovalAB-2026-11-25.md)에서는 실로그와 합성 10,000·100건의 갱신, 조회, DB 크기를 대조했다.
- [선행 v22 조회 실험](../../failure/2026-11-23/DbTradeoff-IndexRemovalExplain.md)은 보조 인덱스 9개 제거를 비교했고 당시 제품에 반영하지 않았다.

### 추가 자료

- [SQLiteIndexRemovalAB-2026-11-25.json](SQLiteIndexRemovalAB-2026-11-25.json)
- [StreamingJsonlProjectionAB-2026-11-25.json](StreamingJsonlProjectionAB-2026-11-25.json)
