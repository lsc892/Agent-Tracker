# jsonl

일반·Zstd JSONL을 스트리밍으로 읽으며 줄 예산·이미지 제거·바이트 offset·취소 계약을 유지한다.

- [index.ts](index.ts) — `readJsonl`·`SummaryError`·`JsonlLine`: JSONL 읽기와 오류 위치, 줄 크기·이미지 본문 처리를 맡는다.
- [zstd.ts](zstd.ts) — `zstdChunks`·`ZstdError`·`ZstdFrames`: 압축 스트림 해제와 frame 경계·checksum·window를 검증한다.
