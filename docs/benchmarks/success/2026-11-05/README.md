# 2026-11-05 벤치마크 · 제품 반영

[전체 벤치마크](../../README.md) · [같은 날짜의 미채택·철회 및 검증 한계](../../failure/2026-11-05/README.md)

## 반영 결과

- JSONL 청크 단위 디코딩·줄 분할 채택 (`9e88d1d`).
- 영속 turn metadata의 최종 후보 채택 (`80fc586`). 11월 7~8일 메모리 집계로 교체.

## 측정 기록

JSONL 청크 단위 디코딩·줄 분할의 시간·메모리와 실제 갱신·조회 결과를 보존한다.

## 보고서와 원시 자료

- [MetadataKeyedAB-2026-11-05.md](MetadataKeyedAB-2026-11-05.md): 전수 파싱 후 변경 turn만 재집계하는 최종 후보의 반복 재파싱 개선·한 건 추가 회귀·DB 공간 비용.
- [MetadataKeyedAB-2026-11-05.json](MetadataKeyedAB-2026-11-05.json): 같은 현재 1,050·1만·100건의 최종 준비 3쌍·AB/BA 10쌍 원시 결과.
- [MetadataKeyedPilot-2026-11-05.md](MetadataKeyedPilot-2026-11-05.md), [JSON](MetadataKeyedPilot-2026-11-05.json): SQL 의미 열 직렬화와 빈 변경 저장 생략 후 각 입력 1쌍의 사전 관측.
- [JsonlChunksAB-2026-11-05.md](JsonlChunksAB-2026-11-05.md): 변경 범위·현재 로그와 합성 데이터의 성능·정확성·트레이드오프.
- [JsonlChunksReaderAB-2026-11-05.json](JsonlChunksReaderAB-2026-11-05.json): 최종 리더의 짧은 줄·긴 줄·이미지 비교와 원시 시간·메모리 표본.
- [JsonlChunksProductAB-2026-11-05.json](JsonlChunksProductAB-2026-11-05.json): 실제 갱신·요청 한 건 추가·일/월/세션/프로젝트 평균 조회의 원시 결과.
