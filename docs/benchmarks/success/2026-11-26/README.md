# 2026-11-26 벤치마크 · 제품 반영

[전체 벤치마크](../../README.md)

## 반영 결과

- JSONL 고정 필드는 모든 줄의 바이트에서 선택한다.
- 스캔 중 응답 토큰과 구형 Codex 누계를 ArrayBuffer에 보관한다.
- 원본 관계를 스레드 ID와 보존 플래그로 저장 (`1c21c9b`).

## 보고서와 원시 자료

- [JSONL 고정 필드 바이트 선택 A/B](ByteProjectionAB-2026-11-26.md) — 파일 Worker 힙·누적 할당, 전체 갱신 시간·RSS, 선택 행과 SQLite 결과를 비교한다.
- [응답 토큰 ArrayBuffer A/B](ThreadTokenBufferAB-2026-11-26.md) — 실로그·합성 입력의 피크 힙과 RSS, 갱신 시간 및 SQLite 집계 일치를 확인한다.
- [응답 토큰 ArrayBuffer와 자연 GC A/B](ThreadTokenGcAB-2026-11-26.md) — 동일한 빌드에서 수집 스레드·파일 Worker의 자연 GC 횟수와 멈춤을 비교한다.
- [원본 관계 저장 형식 A/B](SourceRelationStorageAB-2026-11-26.md) — 스키마 v28과 v29의 SQLite 크기, 부모 조회, 증분 갱신과 평균 조회를 같은 입력으로 비교한다.

### 추가 자료

- [ByteProjectionAB-2026-11-26.json](ByteProjectionAB-2026-11-26.json) · [ByteProjectionHeapAB-2026-11-26.json](ByteProjectionHeapAB-2026-11-26.json)
- [ThreadTokenBufferAB-2026-11-26.json](ThreadTokenBufferAB-2026-11-26.json)
- [ThreadTokenGcAB-2026-11-26.json](ThreadTokenGcAB-2026-11-26.json)
- [SourceRelationStorageAB-2026-11-26.json](SourceRelationStorageAB-2026-11-26.json)
