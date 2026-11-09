# 부모 DTO 계보 처리 내부 정리

2026-11-08, Asia/Seoul. 사용자 요청에 따라 선택한 알고리즘과 부모 합산 동작을 보존하면서 중복 조회·임시 상태를 줄인다.

## 검토 범위와 유지할 계약

- [scanner/index.ts](../../../src/summary/scanner/index.ts#L423)의 `resolveLineage`, [resolveParentRequests](../../../src/summary/scanner/index.ts#L448), [expandRelatedSources](../../../src/summary/scanner/index.ts#L482)를 검토한다. 원본 검사·귀속 변경 연결·실패 보존·취소와 파일 처리 순서는 유지한다.
- [parentGroups.ts](../../../src/summary/aggregation/parentGroups.ts)는 직접 부모 그룹과 다단계 Union-Find·Small-to-Large를 유지한다. 부모 누락·충돌·순환의 해소 불가 판정과 중복 thread 원본도 유지한다.
- 미커밋 상태인 앞선 부모 DTO 기능 변경 위에서 작업하며 테스트·벤치마크와 다른 담당자의 파일은 수정하지 않는다.

## 적용할 내부 정리

1. `resolveLineage`는 이미 그룹의 `members`에 있는 thread별 소스를 `byThread`로 다시 색인한다. 이 중복 Map을 없애고 최상위 부모의 세션 선택을 그룹당 한 번만 계산한다. 파일별 귀속 반영 순서는 기존 후보 순서를 유지한다.
2. `resolveParentRequests`에서 자식 참조 후보·일치 후보를 부모 소스마다 배열로 만들지 않고 참조를 직접 확인한다. 기존 모호성·순환 판정은 유지한다.
3. `expandRelatedSources`의 필터 체인과 반복적인 Set→배열 복사를 줄인다. 부모 후보 우선, 그 외 affected 소스 한 개씩 준비하는 순서는 유지한다.
4. 호출부에서 읽지 않는 `ParentGroup.nested` 반환 상태를 제거한다. 실제 다단계 알고리즘의 선택 조건은 유지한다.

## 검증 계획과 제한

코드·참조·diff로 순서와 판정 보존을 검토하고 메인 에이전트가 컴파일·린트를 확인한다. 이번 요청에서는 자동 테스트·A/B·재현 스크립트를 작성하거나 실행하지 않는다. 직전 A/B 결과를 이 리팩터링의 검증으로 재사용해 통과했다고 보고하지 않는다.

## 적용 결과

- `resolveLineage`의 중복 `byThread` Map을 제거했다. 기존 `group.members`의 최상위 부모 원본을 사용하고 세션 일치 판정은 그룹당 한 번만 계산한다. 후보 파일을 도는 순서는 유지하므로 `connect` 호출 순서도 바뀌지 않는다.
- `resolveParentRequests`의 자식 참조 배열을 부모 소스 루프 밖으로 이동하고, 별도 일치 후보 배열 없이 같은 Map에서 직접 조회한다. 빈 참조 제외와 null 모호성 판정은 유지한다.
- `expandRelatedSources`는 관련 참조·준비된 thread·미처리 원본을 한 번의 파일 순회에서 모은다. 누락 부모 참조도 라운드당 한 번만 계산한다. 부모 후보 우선과 그 다음 affected 원본 하나를 읽는 순서를 유지하면서 `expanded` 상태를 없앴다.
- 루프의 마지막 라운드가 계보를 확정한 뒤 새 원본 없이 끝나므로, 종료 직후 같은 `resolveLineage`를 다시 부르던 중복 호출을 제거했다.
- 실제 판정에 사용하지 않는 `ParentGroup.nested` 반환 필드를 제거했다. `nestedRoots` 분기·경로 압축·작은 membership Map 병합은 그대로 둔다.

참조 검색과 해당 파일의 `git diff --check`를 통과했다. 컴파일·린트는 메인 에이전트에서 합친 변경을 대상으로 확인한다. 자동 테스트·벤치마크·A/B는 작성하거나 실행하지 않았다. 핵심 탐색 알고리즘 교체와 새 소스 파일·클래스 분리는 제안하지 않는다.
