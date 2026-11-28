# jsonl

일반·Zstd JSONL을 스트리밍으로 읽으며 줄 예산·이미지 제거·바이트 offset·취소 계약을 유지한다.

- [index.ts](index.ts) — 관측한 크기까지 일반·압축 JSONL을 읽고 LF에서 행을 확정한다. 통계에서 청크 경계를 넘는 줄은 파일별 버퍼에 모아 문자열로 파싱한다.
- [line.ts](line.ts) — `JsonlLine`은 이미지 본문을 제거하고 행의 바이트 예산을 확인한다. `JsonlLineBuffer`는 문자열로 조립할 줄의 버퍼를 파일 안에서 재사용한다.
- [streamProjection.ts](streamProjection.ts) — 고정 필드 행의 바이트 문법을 검사하고 선택한 값만 축소 행으로 모은다.
- [errors.ts](errors.ts) — `SummaryError`: JSONL 처리에서 공유하는 오류 코드와 원본 바이트 위치를 전달한다.
- [zstd.ts](zstd.ts) — `zstdChunks`·`ZstdError`·`ZstdFrames`: 압축 스트림 해제와 frame 경계·checksum·window를 검증한다.

## 관련 문서

- [LogParsingFields](../../../docs/refrences/LogParsingFields.md) — Claude·Codex JSONL 필드와 해석 규칙.
