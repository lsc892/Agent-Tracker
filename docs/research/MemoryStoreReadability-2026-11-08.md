# MemoryStore 가독성 정리 — 2026-11-08

## 범위와 기존 흐름

[MemoryStore](../../src/summary/db/memoryStore.ts)는 최종 메모리 집계를 기존 SQLite 행과 비교해 한 트랜잭션으로 반영한다. [호출부](../../src/summary/db/index.ts#L86)의 공개 API와 [트랜잭션 경계](../../src/summary/db/connection.ts#L66)는 유지한다.

기존 `apply()`에는 삭제·이동 원본 검증, 보존 요청 선정, manifest 저장, 요청·모델·Skill·비용 비교와 반영, metadata·rollup·이름 정리가 한 메소드에 섞여 있었다. 한 줄의 여러 문장과 중첩 분기가 처리 순서와 예외 경계를 가렸다.

## 적용한 내부 정리

- [apply](../../src/summary/db/memoryStore.ts#L106)는 준비·원본 저장·요청 반영·삭제/이동·metadata·rollup/이름 정리의 호출 순서를 보여 준다. 기존의 Map·Set과 트랜잭션 수명은 지역 값으로 유지했다.
- [saveFile](../../src/summary/db/memoryStore.ts#L196)은 원본 검증·저장, [saveSummary](../../src/summary/db/memoryStore.ts#L269)는 한 요청의 비교·저장, [saveMetadata](../../src/summary/db/memoryStore.ts#L401)는 확정 metadata 입력 반영을 맡는다. 세션별 metadata 삭제 직후 rollup을 갱신하던 순서도 [finishSessions](../../src/summary/db/memoryStore.ts#L449)에 유지했다.
- 개별 행 처리의 제외·동일 결과·잘못된 입력은 guard clause로 드러내고, 모델·Skill 변환과 저장 값 비교를 분리했다. 메소드와 파일 내부 함수에 책임·알고리즘의 한 줄 한국어 주석을 붙였다.
- SQL과 바인딩·호출 순서, 입력 검증 순서와 예외, 정렬, null/undefined 기본값, 동일 요청 ID·시각과 삭제/Skill 보존 규칙을 보존했다. `updated_at`의 비교 시점과 `model_usage`가 없을 때 합계 대조를 생략하는 단락 평가도 유지했다.

알고리즘·자료구조·공개 API·클래스/파일 경계의 변경 제안은 없다. 이 작업은 외부 동작을 바꾸지 않는 내부 정리이므로 설계 결정 일지의 새 기능 항목을 추가하지 않는다.

## 검증

[메모리 저장 회귀 테스트](../../tests/node/memory-incremental.test.ts#L34), [metadata 테스트](../../tests/node/summary-metadata.test.ts), [통합 테스트](../../tests/node/summary.integration.test.ts)의 기존 계약을 기준으로 검토했다.

- `npx tsc -p tsconfig.json --noEmit`: 최종 소스 통과.
- 원본과의 로컬 차등 검증: 정상 저장·동일 결과·이름·모델 null·Skill OFF·이동·삭제 보존·metadata 실패/재시도·입력 오류 27개 상태에서 SQL 실행·바인딩·예외 메시지·영속 snapshot이 일치했다. 비교한 SQL 실행은 475회다.
- 최종 `npm run check`: 타입 검사·린트·430개 테스트 통과. 실패·스킵·취소는 0건이다.
