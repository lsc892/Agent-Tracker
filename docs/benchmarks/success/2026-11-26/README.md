# 2026-11-26 벤치마크 · 제품 반영

[전체 벤치마크](../../README.md)

## 반영 결과

- 발견한 로그를 바로 관측하고 Codex 응답 키는 비교할 때 만든다.
- 구형 Codex의 누계 비교 서명을 ArrayBuffer에 보관한다.
- JSONL 고정 필드는 모든 줄의 바이트에서 선택한다.
- 스캔 중 응답 토큰과 구형 Codex 누계를 ArrayBuffer에 보관한다.
- 원본 관계를 스레드 ID와 보존 플래그로 저장 (`1c21c9b`).

## 보고서와 원시 자료

- [원본 탐색과 Codex 응답 키 색인의 힙 A/B](RefreshHeapAB-2026-11-26.md) — 최초·무변경·추가 갱신의 힙과 RSS, 응답 키 수, SQLite 결과를 비교한다.
- [구형 Codex 누계 비교 서명 ArrayBuffer A/B](LegacySignaturesBufferAB-2026-11-26.md) — 집계 직전 힙, 수집 피크 힙, 프로세스 RSS와 SQLite 결과를 비교한다.
- [JSONL 고정 필드 바이트 선택 A/B](ByteProjectionAB-2026-11-26.md) — 파일 Worker 힙·누적 할당, 전체 갱신 시간·RSS, 선택 행과 SQLite 결과를 비교한다.
- [응답 토큰 ArrayBuffer A/B](ThreadTokenBufferAB-2026-11-26.md) — 실로그·합성 입력의 피크 힙과 RSS, 갱신 시간 및 SQLite 집계 일치를 확인한다.
- [응답 토큰 ArrayBuffer와 자연 GC A/B](ThreadTokenGcAB-2026-11-26.md) — 동일한 빌드에서 수집 스레드·파일 Worker의 자연 GC 횟수와 멈춤을 비교한다.
- [원본 관계 저장 형식 A/B](SourceRelationStorageAB-2026-11-26.md) — 스키마 v28과 v29의 SQLite 크기, 부모 조회, 증분 갱신과 평균 조회를 같은 입력으로 비교한다.

### 추가 자료

- [LegacySignaturesBufferAB-2026-11-26.json](LegacySignaturesBufferAB-2026-11-26.json) · [LegacySignaturesHeapAB-2026-11-26.json](LegacySignaturesHeapAB-2026-11-26.json)
- [ByteProjectionAB-2026-11-26.json](ByteProjectionAB-2026-11-26.json) · [ByteProjectionHeapAB-2026-11-26.json](ByteProjectionHeapAB-2026-11-26.json)
- [ThreadTokenBufferAB-2026-11-26.json](ThreadTokenBufferAB-2026-11-26.json)
- [ThreadTokenGcAB-2026-11-26.json](ThreadTokenGcAB-2026-11-26.json)
- [SourceRelationStorageAB-2026-11-26.json](SourceRelationStorageAB-2026-11-26.json)
