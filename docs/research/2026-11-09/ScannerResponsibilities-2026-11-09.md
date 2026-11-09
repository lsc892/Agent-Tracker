# 스캔 갱신의 책임별 폴더 분리

2026-11-09, Asia/Seoul. 사용자는 scanner/index.ts를 SRP에 맞춰 책임별로 나누고, 관련 스크립트가 상위 폴더 아래에 모이도록 요청했다. 이 구조 변경은 사용자 요청으로 승인된 범위이며 기존 알고리즘·순서·오류·취소·DB 반영 정책을 보존한다. 기준은 [가독성 스킬](../../../.agents/skills/refactor-readability/SKILL.md)과 [보존 지침](../../../.agents/skills/refactor-readability/GUIDELINES.md)이다.

## 적용한 구조

기존 [scanner/index.ts](../../../src/summary/scanner/index.ts)는 공개 API를 재노출하고 실제 갱신은 [scanner/refresh/](../../../src/summary/scanner/refresh/README.md) 아래에서 조율한다. 적용한 경로는 다음과 같다.

```text
scanner/
  index.ts                 공개 refreshSummary·PARSER_VERSION
  refresh/
    index.ts               실행 순서·잠금·진행 상태·취소·종료
    state.ts               파일 상태·역인덱스·큐와 갱신 불변조건
    context.ts             모듈들이 참조하는 갱신 계약
    discovery.ts           디렉터리 탐색·manifest 비교·소실 판정
    preparation.ts         Worker 준비 결과를 기존 순서로 반영
    relations.ts           관계 확장·부모 귀속·원본 이동 검증
    aggregation.ts         준비된 winner를 최종 집계로 전달
    persistence.ts         연결 묶음 저장·실패/삭제 보존·관측 기록
```

기존 sourcePool·sourceWorker·sourceReader·worklist·lock·names의 위치와 API는 유지한다. 관련 호출부는 scanner의 기존 공개 API를 계속 사용한다. 파일 준비 풀의 계측 참조 경로도 유지한다. 하나의 갱신 context와 하나의 상태 소유자를 만들고 기존 Map·Set·DTO 참조를 공유하며, 단계별 context 복제·행/파일별 상태 컨테이너 복제는 추가하지 않는다.

## 담당과 보존할 계약

- 메인: state/context·공개 진입점·실행 조율·통합 문서·타입/린트 검토.
- [탐색·준비 담당](ScannerResponsibilities-discovery-2026-11-09.md): discovery/preparation과 호출 순서 대조.
- [관계·집계 담당](ScannerResponsibilities-relations-2026-11-09.md): relations/aggregation과 계보·이동 검증·winner 전달 대조.
- [저장 담당](ScannerResponsibilities-persistence-2026-11-09.md): persistence와 transaction·유예·실패/삭제 보존 대조.

파일 ID·부모 배치·sequence·이벤트 index·최소 힙·선행 창·동점 winner, 미완성 줄 유예·부분 identity·소실 보존·선택 root 경계·취소·finally 종료·DB transaction과 계측 단계 키를 보존한다. 이전 코드의 함수 본문을 책임에 맞춰 이동하고 새로운 탐색·집계 알고리즘이나 조기 Worker 종료는 적용하지 않는다.

## 검증

`npm run typecheck`, `npm run lint`, `git diff --check`를 통과했다. 원본과 이동한 함수의 코드 구조를 대조할 때 context 전달·참조 접근·메소드 receiver를 정규화한 28개 본문이 일치했다. 별도 차이가 있는 finishScan의 상태 참조 구조분해와 reconnectSources의 guard clause는 직접 대조해 호출·조건 평가·실패 중단 순서를 확인했다. 이 대조는 코드의 정적 검토이며 실제 입력을 실행한 테스트가 아니다.

원래 660줄의 공개 진입점은 1줄로, 실제 실행 조율은 91줄로 나뉘었다. 문서·타입·import가 추가되므로 전체 줄 수 감소를 목표나 성능 근거로 사용하지 않는다. 상태 변경은 ScanState에 집중하고, 단계들은 한 context와 기존 자료의 참조를 전달받는다. Worker 수·선행 창과 기존 sourcePool/reader 경로, 공개 API·PARSER_VERSION 값은 유지한다.

사용자 정책에 따라 테스트 코드와 자동 테스트·A/B·재현 스크립트는 작성·수정·실행하지 않았다. GC·시간·메모리 효과는 새로 측정하지 않으며 기존 A/B는 당시 고정 빌드의 결과로 보존한다. 오류·취소·실시간 파일 교체의 실행 검증은 수행하지 않았다. 남은 알고리즘 변경·추가 파일 분리 제안은 없다.
