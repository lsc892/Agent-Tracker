# 파일 준비 Worker 풀 가독성 정리

> 후속: [갱신 책임별 폴더 분리](ScannerResponsibilities-2026-11-09.md)를 적용했다. 이 기록의 index 내부 함수 위치는 당시 코드 기준이며 현재 단계는 scanner/refresh/에서 확인한다.

2026-11-09, Asia/Seoul. 사용자는 현재 Worker 풀 구현을 유지하면서 알고리즘을 간결하게 정리하고 서브에이전트가 리팩토링한 결과를 커밋하도록 요청했다. 실행 기준은 [가독성 스킬](../../../.agents/skills/refactor-readability/SKILL.md)과 [보존 지침](../../../.agents/skills/refactor-readability/GUIDELINES.md)이다.

## 범위와 담당

- [풀 담당 기록](SourcePoolReadability-pool-2026-11-09.md): Worker 배정·완료·실패·종료와 파일별 준비·진행 알림을 기존 파일 안에서 정리한다.
- [스캐너 담당 기록](SourcePoolReadability-scanner-2026-11-09.md): 선행 읽기·논리 결과 반영·큐 preview·winner snapshot 복구에서 불필요한 분기와 읽기 문맥을 줄인다.

핵심 탐색·집계 알고리즘, 최소 힙 자료구조, 공개 호출 계약과 소스 파일 배치는 유지한다. 최대 4개 Worker·선행 2배·1 MiB 시작 기준, 단일 파일의 순차 처리, 논리 sequence·파일 내 index, 오류·취소·삭제 보존과 기존 finally 종료 시점도 유지한다. 준비 직후 Worker 종료·새 스케줄러·추가 저장 캐시는 적용하지 않는다.

## 통합 검토와 검증

- 풀 담당은 정책값을 상수화하고 긴 시작 조건을 조기 반환으로 풀었다. 기존 클래스의 Worker 생성·메시지 수신을 구분해 dispatch에서 배정 순서가 읽히게 했다. 진행 바이트와 시각의 이름·단위, 파일 준비 콜백 표현도 정리했다.
- 스캐너 담당은 실패 identity의 지역 콜백을 오류 분기에 합치고 준비 결과와 최종 상태의 이름을 구분했다. 관련 후보의 중복 판정을 한곳에서 읽게 하고 preview 자식 순회에서 임시 배열을 제거했다.
- 메인 에이전트는 A/B에 사용한 고정 B 사본과 5개 소스의 diff를 대조했다. 시작 조건의 단락 평가, Worker 생성의 try 범위, 파일 ID 확인→바이트 전달→Promise 완료→slot 비움→재배정 순서, sequence·오류 identity 반영과 preview의 왼쪽→오른쪽 탐색을 확인했다. 기존 최소 힙·winner 계산·DB 저장과 finally 종료 경계는 유지한다.
- `npm run typecheck`, `npm run lint`, `git diff --check`와 문서 참조 검토를 통과했다. 새 알고리즘·자료구조·클래스·파일 배치 변경의 제안은 남기지 않았다.

사용자 정책에 따라 이번 리팩토링에서 테스트 코드를 작성·수정하거나 자동 테스트·A/B·재현 스크립트를 실행하지 않는다. 기존 [Worker 풀 A/B](../../benchmarks/2026-11-09/SourcePoolAB-2026-11-09.md)는 리팩토링 전 고정 후보 B의 수치이며 최신 소스의 재측정 결과로 바꾸지 않는다. 기능 동작을 보존하는 내부 정리는 별도 기능 의사결정 항목을 추가하지 않는다.
