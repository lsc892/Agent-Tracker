# 2026-11-05 벤치마크 · 미채택·철회 및 검증 한계

[전체 벤치마크](../../README.md) · [같은 날짜의 제품 반영 결과](../../success/2026-11-05/README.md)

## 반영 결과

- 경계 줄 버퍼링 시제품 미채택.
- 영속 turn metadata 최초 시제품 B1은 재파싱 회귀로 보류. 후속 B2 채택.

## 보고서와 원시 자료

- [MetadataAB-2026-11-05.md](MetadataAB-2026-11-05.md): 파일 전수 파싱을 유지하는 영속 turn metadata의 선행 시제품 A/B와 서명 비교 비용으로 인한 성능 보류 판정.
- [MetadataAB-2026-11-05.json](MetadataAB-2026-11-05.json): 현재 1,050·합성 1만·100건의 준비 3쌍·AB/BA 10쌍, 처리량·시간·공간·정확성 원시 결과.
- [MetadataBaseline-2026-11-05.json](MetadataBaseline-2026-11-05.json): 후보 수정 전 같은 frozen snapshot에서 실행한 A 단독 사전 관측.
- [JsonlChunksBufferedPilot-2026-11-05.json](JsonlChunksBufferedPilot-2026-11-05.json): 채택하지 않은 경계 줄 버퍼링 후보의 선행 측정. 최종 제품의 측정값이 아니다.
