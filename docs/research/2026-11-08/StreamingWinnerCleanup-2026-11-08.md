# Streaming winner 전환: 이전 저장·집계 경로 제거

2026-11-08, Asia/Seoul. 사용자가 파일 읽기·winner 비교·DTO 갱신·패자 폐기로 전체 구조를 교체하고 이전 구현을 제거하도록 승인한 범위다.

## 확인한 경계와 적용 계획

- 실제 진입점은 [scanner](../../../src/summary/scanner/index.ts)에서 메모리 집계를 호출하며, [DB facade](../../../src/summary/db/index.ts)는 최종 facts를 직접 저장한다.
- SQL staging과 영속 turn metadata의 별도 집계·의존성 계산은 실제 갱신 진입점에서 쓰이지 않는다. 테스트에서만 호출하던 `replaceSessions`와 그 TEMP 차이 계산도 제거한다.
- 최종 facts 저장은 [MemoryStore](../../../src/summary/db/memoryStore.ts) 하나로 통합하고, 조회·결제·원본 누락 보존·갱신 원자성은 유지한다.
- 스키마 18은 이전 metadata 파생 테이블만 자식부터 제거한다. 요청 ID·토큰·모델·Skill·비용·이름·manifest는 유지하며 이전 버전 DB 업그레이드는 계속 지원한다.
- 기존 `replaceSessions` 기반 조회·저장 계약 검사는 `replaceMemory`로 전환한다. 제거한 구현의 내부 SQL·중간 테이블만 검증하는 테스트와 fixture는 함께 제거한다. metadata 통합 검사의 사용자 동작은 manifest 해시·facts를 기준으로 유지한다.

## 검증 계획

타입 검사와 삭제 경로의 잔존 import를 확인하고, DB migration·저장·조회·제목·이름·모델/비용·Skill 테스트를 실행한다. 전체 `npm run check`와 로컬 JSONL 비교는 통합 담당자가 수행한다.

## 적용·검증 결과

- 적용 완료: SQL staging·turn metadata 소스, 별도 세션 저장기와 TEMP 차이 계산, 이전 제목 SQL 벤치마크 실행기·명령·내부 테스트를 제거했다. 과거 측정 보고서는 보존한다.
- [MemoryStore](../../../src/summary/db/memoryStore.ts)의 직접 저장 경로만 남겼다. 영속 계산 metadata 복제와 직렬화를 제거하고, 파일 source hash와 최종 facts·모델·Skill·비용·이름을 같은 transaction에 확정한다.
- [스키마](../../../src/summary/db/schema.ts)는 18이며 [migration](../../../src/summary/db/migrations.ts)은 이전 metadata의 자식 테이블부터 제거한다. [DB 검사](../../../tests/node/summary-db.test.ts)는 v17 데이터·ID·진단 참조·모델·Skill·결제·일별 집계 보존과 파생 테이블·인덱스 제거를 확인한다.
- [계보 검사](../../../tests/node/summary-lineage.test.ts)는 삭제한 staging 내부 테스트의 깊은 조상·순환·중복 부모 계약을 실제 JSONL 갱신으로 확인한다. [원본·갱신 계약 검사](../../../tests/node/summary-metadata.test.ts)와 [패자 폐기 검사](../../../tests/node/greedy-streaming-metadata.test.ts)는 원본 해시·진단·정규화 결과·실패 시 원자성을 확인한다.
- 현재 scanner·집계와 통합 후 TypeScript 컴파일 성공. 담당 DB·이름·모델/비용·Skill·토큰·조회/차트·원본/계보 계약 146개 전부 통과. 담당 소스·테스트 ESLint 통과. 전체 저장소 검사와 로컬 실데이터 대조 결과는 통합 기록을 따른다.

## Scanner 내부 처리 구역 정리

추가 담당 범위는 [scanner 진입점](../../../src/summary/scanner/index.ts) 하나다. 전체 알고리즘과 파일 경계는 바꾸지 않고, 성분 저장의 대기·오류·고아 요청·정상 저장을 조기 반환으로 구분한다. 선택 루트 밖 원본의 상태 확인은 독립 함수로 추출한다. 기존 성분 순서·취소 확인·오류 전파·보존·transaction·settled 시점과 파일 읽기 횟수는 유지한다. TypeScript와 관련 scanner 통합 검사를 다시 수행한다.

적용: `commitComponents`는 성분 구성·취소 확인·진행 보고만 조율하고, `commitComponent`는 대기·오류·고아 요청을 반환한 뒤 정상 저장을 수행한다. `settleDeferredComponent`가 부분 줄의 저장 경계를 유지하고, `refreshOutsideSource`가 루트 밖 원본의 존재·누락·대체 여부를 확인한다. 불필요하게 길게 펼친 tuple·객체 타입도 정리했다. TypeScript·scanner ESLint·diff 공백 검사와 통합·증분·계보·원본 이동/삭제 보존 검사 96개가 모두 통과했다.
