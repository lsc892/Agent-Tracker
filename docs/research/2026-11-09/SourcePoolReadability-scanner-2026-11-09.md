# 파일 준비 결과 반영과 큐 preview 내부 정리

2026-11-09, Asia/Seoul. 담당 범위는 [스캐너](../../../src/summary/scanner/index.ts), [작업 큐](../../../src/summary/scanner/worklist.ts), [원본별 winner](../../../src/summary/aggregation/sourceWinners.ts)의 Worker 풀 도입 부분이다. [가독성 스킬](../../../.agents/skills/refactor-readability/SKILL.md)과 [보존 지침](../../../.agents/skills/refactor-readability/GUIDELINES.md)을 읽고 기존 동작을 유지하는 파일 내부 정리만 적용한다.

## 현재 흐름과 보존할 계약

- 변경 파일 batch와 부모 batch는 ID순으로 준비하며, 선행 읽기는 선택한 파일만 제한된 창에 넣는다. 실제 결과 반영은 기존 sequence·event index를 유지한다.
- 관련 큐는 영향을 받는 준비 가능 파일을 선택하고, 비파괴 preview만 Worker 선행 후보로 제공한다.
- 준비 실패는 부분 identity를 먼저 반영하고 기존 fail/cancel 경계로 전달한다. 준비 완료·빈 파일·미완성 줄과 최종 DB transaction·finally 종료 시점은 바꾸지 않는다.
- SourceWinners의 snapshot은 Map·배열을 그대로 복구하고 동점 winner 규칙을 보존한다. 이 부분은 현재 흐름이 짧고 명확하여 불필요한 추상화를 추가하지 않는다.

## 적용한 내부 정리

1. [파일 결과 반영](../../../src/summary/scanner/index.ts#L440)의 지역 결과를 preparation으로 이름 붙여 최종 file.prepared와 구분했다. 실패 시에만 쓰는 identity 콜백은 해당 오류 분기로 합쳐 파일당 불필요한 지역 함수 생성을 없앴다. setSession→connect→SummaryError의 순서를 유지했다.
2. [batch 선행 후보](../../../src/summary/scanner/index.ts#L488)를 지역 값으로 드러냈다. [관련 확장](../../../src/summary/scanner/index.ts#L601)의 공통 준비 가능·영향 세션 판정을 같은 함수 안의 지역 predicate로 재사용하며 선택 파일 검사→ready→영향 세션 검사의 단락 평가와 큐 제거·읽기 순서를 유지했다.
3. [preview](../../../src/summary/scanner/worklist.ts#L53)의 index를 heapIndex로 명명하고 자식 위치 두 개의 임시 배열 대신 같은 왼쪽→오른쪽 범위를 순회한다. 최소 힙의 추가·제거 규칙, accept 호출 위치와 횟수, limit에 도달해도 해당 노드의 자식까지 넣는 기존 처리 및 비파괴 탐색 알고리즘은 유지했다.

SourceWinners는 검토했지만 추가 분할이나 조건 변경이 필요하지 않아 수정하지 않았다. 관련 파일 선택이나 winner 계산의 알고리즘 교체는 없다.

## 제안으로 남기는 큰 변경

새 알고리즘·자료구조·클래스·파일 분리 후보는 없다. 준비 직후 Worker 종료는 수명 정책 변경이며 이번 정리에 포함하지 않는다. 최종 집계·저장이나 기존 스캐너의 다른 책임까지 리팩토링 범위를 넓히지 않는다.

## 검증과 미확인 사항

적용 전 계획을 기록하고 내부 정리 후 조건식·순회·예외·자원 정리 경계를 코드·참조·diff로 대조했다. TypeScript `tsc -p tsconfig.json --noEmit`과 `git diff --check`를 통과했다. 통합 타입·린트 검토는 메인 에이전트가 수행한다.

사용자 지시에 따라 테스트 작성·수정·자동 실행, A/B 재실행과 임시 재현 코드는 사용하지 않았다. 기존 A/B 수치는 리팩토링 전 구현의 측정값으로 보존하며 이 정리의 속도 개선율로 인용하지 않는다. 오류·취소·실시간 원본 교체 등 실행 시나리오는 새로 확인하지 않았다. 기능 동작을 바꾸지 않았으므로 이 내부 정리만을 위한 새 기능 일지 항목은 필요하지 않다.
