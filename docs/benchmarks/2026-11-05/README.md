# 2026-11-05 벤치마크

JSONL 청크 단위 디코딩·줄 분할의 시간·메모리와 실제 갱신·조회 결과를 보존한다.

- [MetadataKeyedAB-2026-11-05.md](MetadataKeyedAB-2026-11-05.md): 전수 파싱 후 변경 turn만 재집계하는 최종 후보의 반복 재파싱 개선·한 건 추가 회귀·DB 공간 비용.
- [MetadataKeyedAB-2026-11-05.json](MetadataKeyedAB-2026-11-05.json): 같은 현재 1,050·1만·100건의 최종 준비 3쌍·AB/BA 10쌍 원시 결과.
- [MetadataKeyedPilot-2026-11-05.md](MetadataKeyedPilot-2026-11-05.md), [JSON](MetadataKeyedPilot-2026-11-05.json): SQL 의미 열 직렬화와 빈 변경 저장 생략 후 각 입력 1쌍의 사전 관측.

- [MetadataAB-2026-11-05.md](MetadataAB-2026-11-05.md): 파일 전수 파싱을 유지하는 영속 turn metadata의 선행 시제품 A/B와 서명 비교 비용으로 인한 성능 보류 판정.
- [MetadataAB-2026-11-05.json](MetadataAB-2026-11-05.json): 현재 1,050·합성 1만·100건의 준비 3쌍·AB/BA 10쌍, 처리량·시간·공간·정확성 원시 결과.
- [MetadataBaseline-2026-11-05.json](MetadataBaseline-2026-11-05.json): 후보 수정 전 같은 frozen snapshot에서 실행한 A 단독 사전 관측.

- [JsonlChunksAB-2026-11-05.md](JsonlChunksAB-2026-11-05.md): 변경 범위·현재 로그와 합성 데이터의 성능·정확성·트레이드오프.
- [JsonlChunksReaderAB-2026-11-05.json](JsonlChunksReaderAB-2026-11-05.json): 최종 리더의 짧은 줄·긴 줄·이미지 비교와 원시 시간·메모리 표본.
- [JsonlChunksProductAB-2026-11-05.json](JsonlChunksProductAB-2026-11-05.json): 실제 갱신·요청 한 건 추가·일/월/세션/프로젝트 평균 조회의 원시 결과.
- [JsonlChunksBufferedPilot-2026-11-05.json](JsonlChunksBufferedPilot-2026-11-05.json): 채택하지 않은 경계 줄 버퍼링 후보의 선행 측정. 최종 제품의 측정값이 아니다.
