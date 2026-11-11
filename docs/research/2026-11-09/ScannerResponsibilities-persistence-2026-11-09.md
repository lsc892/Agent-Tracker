# 스캔 갱신 저장 책임 분리

2026-11-09, Asia/Seoul. [통합 작업 범위](ScannerResponsibilities-2026-11-09.md)에 따라 기존 [scanner/index.ts](../../../src/summary/scanner/index.ts)의 저장 함수를 `scanner/refresh/persistence.ts`로 옮긴다. 사용자가 책임별 파일 분리와 상위 `refresh/` 폴더 구성을 승인했다. 기준은 [가독성 스킬](../../../.agents/skills/refactor-readability/SKILL.md)과 [보존 지침](../../../.agents/skills/refactor-readability/GUIDELINES.md)이다.

## 현재 흐름과 경계

기존 `commitComponents`는 영향받은 세션을 정렬하고 관계 그래프의 연결 묶음을 BFS로 구한 뒤, 파일·요약·고아 행을 묶음별로 저장한다. `commitComponent`는 미완성 줄 유예, 원본 오류, 소실 원본, 고아 요청을 판정하고 기존 DB transaction에 최종 변경분을 전달한다. `finishScan`은 세션 없는 파일과 소실된 빈 파일, 세션 이름, 관측 기록과 실패 진단을 마무리한다.

이 함수들은 파일 탐색·준비·관계 확장과 같은 긴 함수에 중첩되어 있었다. 저장 책임만 모듈로 옮기고 `RefreshContext`와 `ScanState`의 기존 참조를 공유한다. 공개할 함수는 `commitComponents`, `finishScan`, `recordFailure`이며 나머지는 모듈 내부에 둔다. 기존 공개 scanner API와 호출 순서는 메인 담당자가 연결한다.

## 적용 범위와 보존할 계약

- `commitComponents`, `commitComponent`, `settleDeferredComponent`, `finishScan`, `finalFile`, `recordFailure`, `preserveMissingSources` 본문을 이동한다.
- `OrderedGroups` 구성, seed 정렬, BFS 순회, yield·취소 확인·진행 보고 시점, 영향 세션 제거 순서를 보존한다.
- sibling 오류 전파와 실패 집계, 미완성 줄 transaction, 삭제 보존, orphan 판정, 재연결 필터, SQL과 DB 호출 순서를 보존한다.
- context·Map·Set·DTO를 단계별로 복제하지 않고 기존 참조에 접근한다. Worker 종료 정책·SQL·schema·집계 알고리즘을 변경하지 않는다.

새 알고리즘이나 추가 구조 변경 제안은 없다. 소유 파일은 이 기록과 새 `persistence.ts`뿐이다.

## 검증 계획과 미확인 사항

적용 후 원본의 대응 함수와 새 모듈을 정적으로 대조하고 import·예외 경계·호출 인자·SQL·참조 공유를 확인한다. 사용자 정책에 따라 테스트 코드와 자동 테스트·A/B·재현 스크립트를 작성·수정·실행하지 않는다. 통합 타입·린트 확인은 메인 담당자가 수행한다. GC·처리 시간 변화는 이 작업에서 측정하지 않는다.

## 적용 결과

[persistence.ts](../../../src/summary/scanner/refresh/persistence.ts)의 [연결 묶음 저장](../../../src/summary/scanner/refresh/persistence.ts#L10), [스캔 저장 마무리](../../../src/summary/scanner/refresh/persistence.ts#L97), [실패 진단](../../../src/summary/scanner/refresh/persistence.ts#L131)을 구현했다. 기존 중첩 함수 7개를 이동하고 context 인자, 공유 상태 접근, `key`의 `sessionKey` 이름만 연결했다. 상태 메소드는 `state.fail(...)`로 호출해 인스턴스 바인딩을 유지한다.

원본 `scanner/index.ts`의 대응 함수와 본문을 정적으로 대조했다. 연결 묶음 순회·취소·진행 보고, deferred·오류·orphan 분기 순서, 실패 횟수를 올리지 않는 sibling 오류 전파, transaction 경계·SQL·DB 인자와 호출 순서, 파일 메타데이터의 null 병합 규칙을 보존했다. 새로운 전체 순회·중간 컬렉션·context 복제는 추가하지 않았다. 추가 알고리즘이나 승인 대기 제안은 없다.

이 담당 범위에서 테스트·벤치마크·타입·린트는 실행하지 않았다. 통합 호출부 연결과 타입·린트 결과는 메인 작업 기록에서 확인한다. 실행 성능과 GC 변화는 미측정이다.
