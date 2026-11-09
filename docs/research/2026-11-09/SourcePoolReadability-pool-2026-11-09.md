# 파일 준비 Worker 풀 내부 정리

2026-11-09, Asia/Seoul. 사용자 요청에 따라 기존 Worker 풀의 알고리즘·호출 계약을 보존하면서 내부 흐름을 정리한다. 기준은 [가독성 실행 스킬](../../../.agents/skills/refactor-readability/SKILL.md)과 [보존 지침](../../../.agents/skills/refactor-readability/GUIDELINES.md)이다.

## 검토 범위와 보존할 흐름

- [sourcePool.ts](../../../src/summary/scanner/sourcePool.ts#L39)의 선행 준비·논리 읽기·Worker 배정·완료·실패·종료를 검토했다. 빈 slot에 작업 배정 → 필요하면 Worker 추가 → 완료 Promise 전달 → 다음 배정의 순서를 유지한다.
- [sourceWorker.ts](../../../src/summary/scanner/sourceWorker.ts#L14)는 파일 하나의 준비와 약 100ms 간격 진행 바이트 전달을 맡는다.
- [sourcePreparation.ts](../../../src/summary/scanner/sourcePreparation.ts#L24)는 읽기·파싱·winner 선택 후 성공 결과 또는 부분 identity가 있는 오류 결과를 반환한다.
- 호출부는 [스캐너](../../../src/summary/scanner/index.ts), 준비 reader는 [sourceReader.ts](../../../src/summary/scanner/sourceReader.ts), 결과 소비 계측은 [기존 A/B 실행기](../../../tests/benchmarks/scan-source-pool-ab.cjs)다. 해당 호출부·실행기는 이 작업에서 수정하지 않는다.

## 바로 적용할 내부 정리

1. 최대 Worker 수·선행 배수·시작 최소 바이트·진행 전달 간격을 의미 있는 상수로 표시한다.
2. 긴 선행 준비 guard와 동시성 기본값 계산을 읽기 쉬운 단계로 풀되 기존 단락 평가·조건을 유지한다.
3. dispatch에서 Worker 생성과 메시지 수신을 같은 클래스의 비공개 메소드로 구분한다. idle slot 배정·생성 try/catch·결과 ID 확인·바이트 알림·Promise 완료·다음 배정 순서는 그대로 둔다.
4. 준비·진행 상태의 시간·바이트 변수와 콜백 표현을 명확히 한다. 단순 전달용 메소드나 새 클래스·소스 파일은 추가하지 않는다.

## 별도 제안과 미확인 사항

Worker 조기 종료·자료구조 교체·파일 분리·스케줄링 변경은 이번 내부 정리에 포함하지 않는다. 특히 종료는 기존 finally에서 수행한다. 최대 4개 Worker·선행 2배·후보 1 MiB 미만 또는 단일 파일의 순차 처리, 긴급 작업의 우선 배정, 파일 ID 매칭, 오류·취소·부분 identity 계약을 보존한다.

## 검증 계획

코드·호출부·diff 검토와 TypeScript 컴파일로 확인한다. 사용자 정책에 따라 테스트 코드·자동 테스트·벤치마크·임시 재현 스크립트는 작성·수정·실행하지 않는다. 통합 타입 검사·린트는 메인 에이전트가 수행한다.

## 적용 결과

- [정책 상수와 시작 조건](../../../src/summary/scanner/sourcePool.ts#L7)은 기존 값과 단락 평가 순서를 유지하면서 이름으로 의미를 표시했다. concurrency의 기본 CPU 조회도 기존 nullish 분기에서만 실행한다.
- [dispatch](../../../src/summary/scanner/sourcePool.ts#L90)는 기존 slot에 배정하고 필요한 Worker를 시작하는 순서를 보여 준다. [startWorker](../../../src/summary/scanner/sourcePool.ts#L102)는 생성·이벤트 등록·첫 배정을, [receive](../../../src/summary/scanner/sourcePool.ts#L115)는 ID 확인·진행 전달·결과 완료·재배정을 맡는다. 생성부터 첫 assign까지의 오류는 기존 dispatch의 try/catch에서 동일하게 처리한다.
- read/enqueue/jobs/slots 이름과 구조를 유지해 기존 A/B 계측의 참조 계약을 보존했다. Promise를 resolve한 뒤 slot을 비우고 즉시 dispatch하는 동기 호출 순서도 유지했다.
- Worker의 readBytes·reportedBytes·lastReportAtMs와 PROGRESS_INTERVAL_MS가 진행 상태의 의미와 단위를 드러내게 했다. 바이트 누적·알림·reported 갱신·시계 갱신 순서와 마지막 남은 바이트 전달을 유지했다.
- 파일 준비 함수에서는 시작 시각·winner·바이트·부분 identity 선언과 콜백을 펼쳐 보였다. 성공/실패 결과 형식, 예외 변환 범위와 부분 identity 전달은 바꾸지 않았다.

`node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`이 통과했다. 고정 B 사본과 변경 diff를 검토해 큐 자료구조·반복 순서·실패 복구·종료 시점이 유지되는 것을 확인했다. 별도 알고리즘 교체·아키텍처 분리 제안은 추가하지 않았다. 실제 실행·새 A/B·GC·취소·오류 경로는 이번 리팩토링에서 실행 검증하지 않았다.
