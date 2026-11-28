# 2026-10-09 벤치마크 · 제품 반영

[전체 벤치마크](../../README.md)

## 반영 결과

- 일반 줄 직접 파싱과 연속 Buffer 처리 채택 (`4612995`). 뒤에 청크 단위 처리로 개선.

## 측정 기록

JSONL reader·adapter와 파싱 분기의 비교 결과를 보존한다.

## 보고서와 원시 자료

- [JsonlParsingBranches-2026-10-09.md](JsonlParsingBranches-2026-10-09.md): 같은 메모리 입력의 적용 전후 파싱 비교.
- [JsonlParsingBranches-2026-10-09.json](JsonlParsingBranches-2026-10-09.json): 파싱 표본·브랜치·소스 해시.
- [JsonlReaderTradeoff.json](JsonlReaderTradeoff.json): 앞선 reader·adapter·전체 갱신의 시간과 자원 관측.
