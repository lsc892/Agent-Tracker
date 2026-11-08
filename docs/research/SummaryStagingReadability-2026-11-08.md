# SummaryStaging 책임 분리 — 2026-11-08

## 범위와 승인

사용자가 같은 책임의 코드를 폴더로 묶고 `staging.ts`와 `metadata.ts`의 스크립트 분리·가독성 개선을 명시적으로 요청했다. 이 문서는 staging 담당의 분리 근거와 적용 상태를 기록한다.

기존 `SummaryStaging`은 TEMP 스키마, 원본·세션 관리, 이벤트 버퍼, 계보 탐색, SQL 집계와 저장 DTO 변환을 한 파일에 묶고 있었다. 공개 API와 SQL·트랜잭션·순회 순서를 유지하면서 `staging/` 안의 책임별 구현으로 이동한다.

## 적용한 구조

- [index.ts](../../src/summary/staging/index.ts): 공개 API와 원본 → 이벤트 → 계보 → 집계 → 해제의 조율.
- [types.ts](../../src/summary/staging/types.ts): `StagedFile`·`PreparedTurn`의 공유 타입.
- [schema.ts](../../src/summary/staging/schema.ts): TEMP 표 생성·정리.
- [sources.ts](../../src/summary/staging/sources.ts): 원본 관측·귀속·이동 후보와 파일 페이지 조회.
- [events.ts](../../src/summary/staging/events.ts): 파싱 청크의 원자적 버퍼, 플래그·복사 검증과 SQL 적재.
- [lineage.ts](../../src/summary/staging/lineage.ts): TEMP 방문 상태·스택을 사용하는 기존 부모 우선 탐색.
- [components.ts](../../src/summary/staging/components.ts): 연결 성분의 선택·실패 확인·성공 후 TEMP 입력 정리.
- [summaries.ts](../../src/summary/staging/summaries.ts): 32 seed 집계 재사용, SQL 준비와 저장 DTO·모델·Skill 변환.

기존 [memoryEvents.ts](../../src/summary/staging/memoryEvents.ts)·[eventValues.ts](../../src/summary/staging/eventValues.ts)·[names.ts](../../src/summary/staging/names.ts)의 폴더 이동은 주 에이전트가 담당했다. metadata의 분리도 별도 담당이 수행하며 공유 `PreparedTurn`은 `staging/types.ts`에서 읽는다. 전체 책임은 [폴더 README](../../src/summary/staging/README.md)에서 찾을 수 있다.

## 보존할 계약과 검증

기존 외부 import `summary/staging`과 `SummaryStaging`의 공개 메소드 및 계측용 `loadEvents`·`prepareSummaries`·`batchEvents`를 유지한다. SQL 문장·바인딩·호출 순서, 청크 실패 복구, 동점 순서와 계보·복사 제외 의미는 바꾸지 않는다. 새 알고리즘·스키마·캐시는 추가하지 않는다.

긴 계보 순회는 작업 공간 준비·SQL 준비·미해결 경로 해소·귀속 반영으로 나눴다. 집계 준비도 재사용 판정·추가 seed 조회·묶음 확장·변경 이벤트/승자/최종 요청 SQL 구성으로 구분했다. 저장 DTO 조립과 품질 경고 선택은 준비 요청·확정 캐시의 공통 변환으로 모았으며 수집하지 않은 Skill은 기존처럼 생략한다.

- 타입 검사 `npx tsc -p tsconfig.json --noEmit`가 통과했다.
- 최초/재사용 × component/summary_batch의 네 준비 조합에서 생성한 전체 집계 SQL이 원본과 바이트 단위로 일치함을 확인했다. 기존 제목 실험의 SQL 부분 치환 계약도 유지한다.
- 원본·이벤트·계보·집계 상태와 트랜잭션의 소유권·호출 순서를 검토했다. [staging 회귀 테스트](../../tests/node/summary-staging.test.ts), [제목 fixture](../../tests/fixtures/request-title-ab.ts)를 포함한 최종 `npm run check`의 타입 검사·린트·430개 테스트가 통과했다.
- 분리 전/후 SQL 경로를 1/35세션·Skill ON/OFF·최초/무변경/변경/metadata 실패/재시도 20상태로 비교해 SQL 순서·바인딩·서명·요청과 모든 영속 결과가 일치했다. 상태: 적용·통합 검증 완료. [통합 기록](SummaryOrganization-2026-11-08.md#검증)에 전체 범위를 정리했다.
