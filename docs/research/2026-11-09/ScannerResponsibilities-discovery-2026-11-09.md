# 스캔 탐색·파일 준비 책임 분리

2026-11-09, Asia/Seoul. [통합 계획](ScannerResponsibilities-2026-11-09.md)에 따른 탐색·준비 담당 기록이다. 사용자가 승인한 책임별 파일 분리와 `scanner/refresh/` 배치를 적용한다. [가독성 스킬](../../../.agents/skills/refactor-readability/SKILL.md)과 [보존 지침](../../../.agents/skills/refactor-readability/GUIDELINES.md)을 먼저 확인했다.

## 검토 범위와 현재 흐름

기존 [scanner/index.ts](../../../src/summary/scanner/index.ts)의 `walk`·`fingerprint`·`discoverSources`와 `inspectSource`·`inspectBatch`·`refreshOutsideSource`, `parseChanged` 단계를 검토했다. 탐색은 디렉터리 DFS와 manifest 경로·inode 비교로 파일 상태를 만들고, 준비는 변경 파일을 ID순으로 선택해 Worker 선행 창을 채우면서 같은 순서로 결과를 반영한다. 탐색의 파일 관측과 준비의 identity·session 변경이 한 진입점에 섞여 있어 단계의 경계를 읽기 어렵다.

## 승인된 적용 범위

- `scanner/refresh/discovery.ts`에 DFS·fingerprint·manifest 비교·소실 판정을 모은다.
- `scanner/refresh/preparation.ts`에 변경 파일 선택·배치 선행 준비·순서대로 결과 반영·스캔 밖 원본 확인을 모은다.
- 각 함수는 공통 `RefreshContext`를 받고 `ScanState`의 기존 Map·Set·DTO 참조를 사용한다. 상태 소유자의 메소드는 `state.method(...)`로 호출한다.
- 경로·inode 판정, 파일 ID, 변경 조건, sequence 증가 시점, 빈 파일·미완성 줄·실패 시 부분 identity, 취소 전파, 선행 창 크기와 결과 소비 순서는 보존한다.

추가 알고리즘·자료구조·공개 API·Worker 수명 변경은 제안하거나 적용하지 않는다. 기존 호출부를 새 함수로 연결하는 작업과 통합 타입·린트 확인은 메인이 맡는다.

## 검증 계획과 미확인 사항

적용 후 함수 본문을 원본과 정적으로 대조하고 선택·호출·상태 갱신·오류 처리 순서를 확인한다. 사용자 정책에 따라 테스트 코드·자동 테스트·A/B·재현 스크립트는 작성하거나 실행하지 않는다. 성능·GC 영향은 측정하지 않는다.

## 적용 결과

- [discovery.ts](../../../src/summary/scanner/refresh/discovery.ts#L14)에 manifest ID순 조회·DFS 탐색·경로 및 inode 일치·미관측 파일 판정을 그대로 옮겼다. `fingerprint` 항목과 변경 조건, root 오류 전파·ENOENT 예외, 관측 카운터의 갱신 위치를 원본과 정적으로 대조했다.
- [preparation.ts](../../../src/summary/scanner/refresh/preparation.ts#L8)에 기존 ID순 변경 파일 선택을 `prepareChanged`로 옮겼다. 선행 창을 채운 뒤 각 배치 항목을 순서대로 기다리는 `inspectBatch`, 시도 표시 직후의 sequence 증가, Worker 실패의 부분 identity 반영, 미완성 줄 유예·빈 파일 처리, 외부 파일 소실 판정과 취소 재전파 순서를 원본과 대조했다.
- 공통 context나 Map·Set·DTO를 복제하지 않고 기존 참조를 사용한다. `state` 메소드는 모두 receiver를 유지해 호출한다. Worker와 DB의 실행·종료 순서는 이 모듈에서 바꾸지 않았다.
- `git diff --check`에서 추적 파일의 공백 오류는 없었다. 신규 파일은 본문과 import를 직접 검토했다. 통합 컴파일·린트는 메인 담당에서 수행하며, 자동 테스트와 성능 측정은 실행하지 않았다.

남은 큰 변경 제안과 담당 범위의 미확인 계약은 없다. 실제 기능·성능 검증은 이번 정적 검토의 범위에 포함하지 않는다.
