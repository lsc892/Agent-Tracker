# jsonl

일반·Zstd JSONL을 스트리밍으로 읽으며 줄 예산·이미지 제거·바이트 offset·취소 계약을 유지한다.

- [index.ts](index.ts) — 관측한 크기까지 일반·압축 JSONL을 읽는다. LF를 기준으로 한 행씩 디코딩하고 바이트 위치·취소·파일 핸들 수명을 관리한다.
- [line.ts](line.ts) — `JsonlLine`: 이미지 본문을 제거하고 행의 문자열 문법·바이트 예산·청크 경계 상태를 관리한다.
- [streamProjection.ts](streamProjection.ts) — 청크 경계를 넘거나 이미지가 있는 행에서 필요한 필드의 바이트만 보관하고 JSON 문법을 검사한다.
- [errors.ts](errors.ts) — `SummaryError`: JSONL 처리에서 공유하는 오류 코드와 원본 바이트 위치를 전달한다.
- [zstd.ts](zstd.ts) — `zstdChunks`·`ZstdError`·`ZstdFrames`: 압축 스트림 해제와 frame 경계·checksum·window를 검증한다.

## 관련 문서

- [LogParsingFields](../../../docs/refrences/LogParsingFields.md) — Claude·Codex JSONL 필드와 해석 규칙.
