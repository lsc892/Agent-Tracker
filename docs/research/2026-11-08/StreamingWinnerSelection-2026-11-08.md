# 스트림 winner 집계 구조 교체

2026-11-08, Asia/Seoul. 사용자가 파일 읽기 → 같은 그룹 winner 비교 → 더 좋은 후보로 DTO 갱신 → 패자 폐기로 전체 집계 구조를 교체하고 중복된 옛 구현을 제거하도록 승인했다.

## 결정과 경계

기존 [메모리 집계](../../../src/summary/aggregation/memoryAggregate.ts)는 파일의 모든 usage DTO를 보관한 뒤 유효성·응답 winner를 선택했다. 새 경로는 파일별 첫 파싱에서 포맷·복사 접두사·Claude request 보정을 판단할 근거만 수집하고 두 번째 파싱에서 유효한 usage를 그룹 winner와 즉시 비교한다. winner 교체는 같은 DTO를 갱신하고 패자는 저장하지 않는다. 원본 이벤트 DTO 캐시는 제거한다.

첫 단계의 근거에는 root·진단 flag·명시 request ID·도구 ID와 legacy 순서의 해시만 있다. 패자의 전체 토큰 벡터나 본문은 보관하지 않는다. 복사 접두사의 최대 후보가 무효가 된 뒤 더 작은 유효 후보가 남는 경우에도 예외 복구 알고리즘 없이 같은 선택 흐름을 사용한다. 파일을 두 번 읽는 비용과 변경된 세션의 관련 형제 파일 재읽기를 받아들인다. 변경 없는 스캔은 원본을 읽지 않는다.

현재 로컬 JSONL의 이전 포맷 지원은 유지한다. 제거 대상은 지원 데이터 포맷이 아니라 원본 DTO 캐시와 SQL staging·metadata 등 중복 구현이다.

## 역할과 호출

- [sourceEvidence.ts](../../../src/summary/aggregation/sourceEvidence.ts): 첫 파싱 근거와 확정된 파일 귀속을 바탕으로 current/legacy·복사 접두사·request 보정 계획을 만든다.
- [winners.ts](../../../src/summary/aggregation/winners.ts): 그룹의 winner DTO 한 개를 보유하며 input+output이 더 크거나 동점에서 원본 순서가 늦은 후보로 갱신한다.
- [turns.ts](../../../src/summary/aggregation/turns.ts): 요청 시각·진단·모델·도구와 최종 winner의 토큰을 조회용 요청으로 만든다.
- [memoryAggregate.ts](../../../src/summary/aggregation/memoryAggregate.ts): 두 번째 파싱 이벤트를 유효성 검사 → winner 선택 또는 요청 상태 반영으로 연결한다. 단일 구현만 둔다.
- scanner는 첫 파싱의 `SourceEvidence.add(event,index)`와 두 번째 파싱의 `StreamingAggregation.add(fileId,event,index)`를 호출하고 `finish()`의 최종 결과만 저장한다.

수정 전 보존할 계약은 [독립 SQL oracle](../../../tests/node/memory-aggregate.test.ts)과 [증분 동작](../../../tests/node/memory-incremental.test.ts)에서 확인했다. 요청 root와 최소 offset은 패자라도 보존하고, 관측한 진단 flag는 포맷·복사 제외 전 수집한다. Claude request 모호성·문자열 정규화·큰 정수 비교·동점 순서·수명주기 순서·모델/도구 집계·중단 요청 제외를 유지한다.

## 검증

독립 SQL oracle 5개 테스트(32개 난수 seed 포함)와 새 스트리밍 계약 5개 테스트가 통과했다. 동일 winner DTO 객체 재사용, 동점의 전체 토큰 벡터 교체, 선택 범위를 넘는 큰 정수 합계, 패자 root·최소 offset·진단 유지, 복사 접두사의 중복 도구 제외, 늦게 확인된 current 포맷과 request 보정을 검증했다. 타입 검사도 통과했다.

전체 원본 배열을 받던 `aggregateMemory` API는 제품에서 제거했다. 독립 oracle에 필요한 배열 입력은 [테스트 전용 adapter](../../../tests/fixtures/streaming-aggregate.ts)가 같은 `SourceEvidence`·`StreamingAggregation`을 호출한다. 별도의 winner 알고리즘이나 제품 호환 경로는 없다.

통합 `npm run check`의 타입·린트·413개 테스트가 통과했다. 로컬 고정 JSONL의 전체 요청·모델·도구·비용·이름·진단·조회 값도 기존과 일치했다. [통합 결과](StreamingWinnerScanner-2026-11-08.md)와 [실제 입력 검증](StreamingWinnerVerification-2026-11-08.md)을 함께 확인한다.
