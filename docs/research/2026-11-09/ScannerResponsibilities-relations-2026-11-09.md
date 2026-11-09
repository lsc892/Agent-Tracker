# 스캔 관계 해소와 집계 전달 책임 분리

2026-11-09, Asia/Seoul. [통합 작업 계획](ScannerResponsibilities-2026-11-09.md)의 사용자 승인 범위에 따라 관계 해소와 집계 전달을 scanner/refresh/ 아래 두 모듈로 옮긴다. [가독성 스킬](../../../.agents/skills/refactor-readability/SKILL.md)과 [보존 지침](../../../.agents/skills/refactor-readability/GUIDELINES.md)을 기준으로 한다.

## 검토한 흐름과 분리 경계

분리 전 [scanner/index.ts](../../../src/summary/scanner/index.ts)에 함께 있던 enqueueParents·resolveLineage·resolveParentRequests·expandRelatedSources·reconnectSources는 관계 그래프와 추가 파일 준비 범위를 확정한다. collectWinners와 sourceFlags는 준비된 winner를 최종 집계기에 전달한다. 두 책임이 갱신 전체를 조율하는 함수 안에 함께 있어 변경 위치와 실행 순서를 찾기 어려웠다.

- [relations.ts](../../../src/summary/scanner/refresh/relations.ts#L9): 새 부모 참조의 후보 탐색, 계보 해소, 부모 요청 귀속, 관계 작업 큐 소비, 원본 이동 검증을 담당한다.
- [aggregation.ts](../../../src/summary/scanner/refresh/aggregation.ts#L6): 파일 준비 sequence와 이벤트 index를 유지하며 StreamingAggregation에 전달하고 파일 진단 flag를 구성한다.
- 호출부는 refresh/index.ts의 단계 조율이며, 기존 공개 scanner API는 유지한다. 환경은 [RefreshContext](../../../src/summary/scanner/refresh/context.ts), Map·Set·큐와 상태 갱신 불변조건은 [ScanState](../../../src/summary/scanner/refresh/state.ts)를 공유한다.

## 보존할 계약과 적용 계획

기존 함수 본문을 책임에 맞게 이동하고 context 참조를 명시한다. Map·DTO·context를 복제하거나 새로운 상태 소유자를 만들지 않는다. lineageDirty는 state 속성에서 직접 읽고 갱신하며 상태 메소드는 state의 멤버로 호출한다.

부모 batch의 ID 순서, 관련 큐의 최소 ID, 새 미해결 참조별 substring 후보 탐색, fileOrder 기반 계보와 부모 요청 해소, 취소·실패 경계, snapshot 검증과 바이트 계측을 보존한다. 집계는 sequence 정렬, 이벤트 index, 단독 subagent의 turn 처리, sessionName·evidence·flag 전달과 finish 시점을 보존한다.

별도 알고리즘 교체나 추가 파일 분리는 제안하지 않는다. Worker 수명과 DB 저장 정책도 이 담당 범위에서 바꾸지 않는다.

## 검증 계획과 미확인 사항

추출한 함수와 원본을 대조하여 순회·정렬·조건식·상태 변경·예외 전파·비동기 호출 순서와 import 의존을 정적으로 검토한다. 사용자 정책에 따라 테스트 코드·자동 테스트·A/B·재현 스크립트는 작성하거나 실행하지 않는다. 통합 타입 검사와 린트는 메인 담당자가 수행한다. 성능·GC 변화는 측정하지 않는다.

## 적용 결과

작업 MD 작성 후 승인된 두 모듈을 생성했다. 관계 확장 → 계보 해소·새 부모 큐 등록 → 부모 batch 우선 준비 → 관련 원본 최소 ID 준비의 순서를 유지했다. [부모 요청 귀속](../../../src/summary/scanner/refresh/relations.ts#L86)은 memo·순환 감지·root 후보 합의와 missing-parent 실패를 그대로 사용한다. [원본 이동 검증](../../../src/summary/scanner/refresh/relations.ts#L123)은 원본의 조건식·후보 순서·실패 시 중단 범위를 보존하면서 guard clause로 중첩을 줄였다. `size_bytes > 0`의 부정을 그대로 사용하여 NaN을 포함한 조건식 의미도 바꾸지 않았다.

원본 함수와 정적으로 대조하여 fileOrder·부모 ID batch·관련 큐·sequence·이벤트 index, snapshot 바이트 계측, 취소 전파와 집계 finish 순서가 유지됨을 확인했다. 기존 identity 복사와 임시 집계 배열은 그대로이며 새 context·Map·DTO 복제를 추가하지 않았다. state 메소드를 멤버 호출하고 lineageDirty를 state에서 직접 갱신하는 것도 확인했다. import는 relations → preparation → state·기존 원본 처리 모듈 방향으로 연결되며 관계 모듈을 역참조하지 않는다.

자동 테스트·A/B·타입 검사·린트는 이 담당자가 실행하지 않았다. 통합 타입·린트 검토는 메인 담당자에게 전달했다. 남은 알고리즘 변경 제안은 없다.
