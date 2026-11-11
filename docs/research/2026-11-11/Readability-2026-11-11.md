# 긴 파일과 반복 분기의 가독성 정리

2026-11-11, Asia/Seoul. 기능이 많고 200줄을 넘는 파일은 분리를 검토하되, 먼저 불필요한 계산·방어 코드와 복잡한 분기를 정리한다. 필수 분기는 목적을 나타내는 메소드나 switch로 표현하고, 순서에 의미가 있으면 그 이유를 설명한다.

1차 내부 정리는 서브에이전트 3개가 사용량 제한으로 작업 전에 실패하여 메인 에이전트가 순차 적용했다. 이후 사용자가 S1·S2 분리를 승인했고, 재개한 서브에이전트 2개가 저장과 JSONL을 나눠 적용했다. 메인 에이전트는 통합 diff·의존 방향·정적 검사를 검토한다. 기준은 [실행 스킬](../../../.agents/skills/refactor-readability/SKILL.md)과 [가독성 지침](../../../.agents/skills/refactor-readability/GUIDELINES.md)이다.

## 1차 검토 범위와 내부 정리

| 범위 | 검토 당시 흐름과 문제 | 같은 파일 안에 적용한 정리 |
| --- | --- | --- |
| [요청 저장 구현](../../../src/summary/db/memoryStore/index.ts) | snapshot 입력 확정·이름 공유 여부·rollup 분기가 트랜잭션 진입점에 섞여 있다. 삭제 ID를 배열로 만든 뒤 공유 판정에서 다시 복사한다. | 배열로 확정한 입력 타입을 명시하고 불필요한 재복사를 제거했다. 후속 사용자 조정에 따라 rollup은 진입점의 저장 이후에 이어 배치했다. |
| [Codex](../../../src/summary/parsers/codex.ts) | 수명주기 switch 안에 legacy 사용자 요청 경계와 완료 이벤트 구성 세부가 섞여 있다. 현재 사용량의 root 선택이 중첩 조건식이다. | 사용자 요청·완료 기록과 root 우선순위를 내부 메소드로 표현한다. |
| [Claude](../../../src/summary/parsers/claude.ts) | 시스템 종료의 stop hook·차단·duration·일반 완료 조건을 순서대로 읽어야 한다. | stop hook 처리를 분리하고, 이후 종료 종류를 switch로 표현한다. hook 결과가 먼저라는 제약을 남긴다. |
| [JSONL](../../../src/summary/jsonl/index.ts) | 파일 읽기·행 연결·JSON 객체 검증이 한 흐름에 있다. 이미지 문법 검증에는 의도적인 상태 우선순위가 있다. | JSON 객체 검증을 내부 함수로 모으고 이미지 상태 검증 순서를 설명한다. 빠른 청크 경로와 행 상태는 유지한다. |
| [스캔 저장](../../../src/summary/scanner/refresh/persistence.ts) | 성분 탐색·묶음 적격 판정·저장 실패 격리가 같은 루프 안에 있다. | 기존 탐색과 개별 저장 판정을 이름 있는 내부 함수로 옮긴다. 보류·원본 오류·고아 요청·쓰기 오류 순서와 독립 복구 경계를 보존한다. |
| [대시보드](../../../src/ui/dashboard.ts) | 메시지 분배 switch에 세션 권한 검사와 이름 조회의 자체 오류 응답이 섞여 있다. | 결제 변경과 이름 조회를 내부 메소드로 옮기고 조회 조건·상태 메시지를 읽기 쉽게 펼친다. |
| [앱](../../../src/app.ts), [quota](../../../src/quota/service.ts) | 비동기 설정 단계마다 종료를 확인하며, quota는 실행 소유권 해제와 제공자 실패 복구를 각각 담당한다. | 실제 취소·재실행·오류 경계이므로 줄 수를 줄이기 위한 병합은 하지 않는다. |

기존 [최소화 결정](AlgorithmMinimize-2026-11-11.md)을 보존한다. 외부 API·SQL·스키마·정렬·이벤트 순서·상태 갱신 시점·취소·자원 수명과 핵심 알고리즘을 바꾸지 않는다. 1차 내부 정리는 기능 동작·책임 배치를 유지했다. 후속 S1·S2의 파일별 책임 분리는 [의사결정 일지](../../AgentTracker-일지.md)에 기록한다.

## 승인된 파일 분리

S1·S2 모두 사용자의 후속 지시로 **승인·적용 완료**했다. 200줄 초과는 검토 신호이며 일괄 분리 기준이 아니다. 아래 두 책임 경계만 분리하고, DB 트랜잭션과 공유 파서 상태를 줄 수에 맞춰 추가로 흩뜨리지 않았다.

| 후보 | 승인·적용 상태 | 적용 순서 |
| --- | --- | --- |
| [S1: 요청 값 변환 분리](#s1-요청-값-변환과-영속-반영-분리) | 승인·적용 완료 | 값 변환의 순수 함수 경계 확정 → 기존 모듈 경로를 보존하며 폴더로 이동 → 의존 방향·검증 순서 검토 |
| [S2: JSONL 행 상태 분리](#s2-jsonl-행-상태와-파일-읽기-분리) | 승인·적용 완료 | 공유 오류 타입 분리 → JsonlLine 이동 → index의 기존 export·호출부 검토 |

두 후보는 서로 독립적이다. 적용 시에도 사용자 지시 없이 테스트를 추가·수정·실행하지 않으며, 우선 타입 검사·린트·참조와 diff로 확인한다. 실행 검증이 필요한 범위는 별도 요청 전까지 미검증으로 표시한다.

### S1. 요청 값 변환과 영속 반영 분리

- 대상: [memoryStore.ts](../../../src/summary/db/memoryStore.ts). 요청·모델·도구 검증/SQL 값 변환은 DB 접근 없이 수행할 수 있고, 트랜잭션·이름·원본 수명과 변경 이유가 다르다.
- 분리 전: `db/memoryStore.ts` 하나가 입력 계약·값 변환·영속 반영을 담당했다.
- 적용 후: [memoryStore/index.ts](../../../src/summary/db/memoryStore/index.ts)는 MemoryStore와 트랜잭션, [values.ts](../../../src/summary/db/memoryStore/values.ts)는 검증·정렬·값 변환·facts 비교, [types.ts](../../../src/summary/db/memoryStore/types.ts)는 외부 입력/결과 타입을 담당한다. 관련 파일을 한 폴더에 두고 `index.ts`가 기존 외부 export를 유지한다.
- 호환 경계: 기존 [memoryStore.ts](../../../src/summary/db/memoryStore.ts)는 명시적인 `./memoryStore/index` re-export만 유지한다. 기본 tsc가 이동 전 출력 파일을 지우지 않는 환경에서도 기존 JS 파일이 새 구현을 가리키며, 기존 호출부 경로도 그대로 해석된다. 별도 빌드 정책이나 테스트를 변경하지 않았다.
- 호출부: [DB API](../../../src/summary/db/index.ts), [스캔 저장](../../../src/summary/scanner/refresh/persistence.ts)과 해당 모듈을 직접 import하는 기존 테스트. 기존 `memoryStore` 모듈 경로를 유지하고 타입 의존이 역전되지 않게 한다.
- 보존한 경계: 검증 순서·undefined/null·모델/도구 정렬의 동점 규칙과 프로파일 범위를 유지했다. 원본·세션 상태는 트랜잭션을 맡는 MemoryStore에 남겼다. [S1 담당 기록](Readability-memoryStore-split-2026-11-11.md).

### S2. JSONL 행 상태와 파일 읽기 분리

- 대상: [JSONL](../../../src/summary/jsonl/index.ts). `JsonlLine`은 이미지 문자열·이스케이프·행 예산을, `readJsonl`은 파일·압축·콜백·offset 수명을 담당한다.
- 분리 전: `jsonl/index.ts`가 오류 타입·행 상태·파일 읽기를 담당하며 같은 폴더에 `zstd.ts`가 있었다.
- 적용 후: [jsonl/index.ts](../../../src/summary/jsonl/index.ts)는 공개 readJsonl·오류 재export, [line.ts](../../../src/summary/jsonl/line.ts)는 JsonlLine, [errors.ts](../../../src/summary/jsonl/errors.ts)는 공유 SummaryError를 맡는다. 기존 [zstd.ts](../../../src/summary/jsonl/zstd.ts)는 유지한다. 이미 기능 폴더가 있으므로 추가 하위 폴더는 만들지 않았다.
- 호출부: [원본 읽기](../../../src/summary/scanner/sourceReader.ts)와 기존 `../jsonl` 호출부는 그대로 둔다. line 모듈이 index를 역참조하는 순환 의존을 만들지 않는다.
- 보존한 경계: 이미지 폐기 바이트의 문법 검증·부분 UTF-8·마지막 줄 유예·예산·취소·압축·close의 예외 우선순위를 유지했다. 오류 클래스는 errors.ts의 단일 정의를 공유하여 instanceof 경계도 보존한다. [S2 담당 기록](Readability-jsonl-split-2026-11-11.md).

### 유지할 파일

Codex·Claude는 같은 파서 상태의 수명이 요청 경계와 연결되어 있다. 앱·quota·대시보드도 수명과 비동기 실행 상태를 공유한다. 이번에는 내부 메소드로 목적을 드러낸 뒤 별도 상태 객체/클래스를 늘리지 않는다. 스캔 저장도 기존 refresh 폴더 안의 역할이 명확하므로 새 폴더나 묶음 상태 클래스를 추가하지 않는다.

## 검증 계획

호출부와 기존 테스트는 읽기 전용으로 계약을 확인한다. 사용자 지시에 따라 테스트 코드를 작성·수정하거나 자동 테스트·임시 재현 스크립트·벤치마크를 실행하지 않는다. 테스트를 포함하는 `npm run check` 대신 타입 검사·린트·`git diff --check`로 확인한다. 실행 결과 동등성이나 성능 개선을 실측했다고 주장하지 않는다.

## 적용·검증 결과

| 적용 위치 | 반영 내용과 보존한 계약 |
| --- | --- |
| [저장 진입점](../../../src/summary/db/memoryStore/index.ts#L68), [같은 진입점의 rollup](../../../src/summary/db/memoryStore/index.ts#L82), [이름 공유 판정](../../../src/summary/db/memoryStore/index.ts#L96) | `BatchReplacement`로 이미 배열이 된 입력을 명시하고 삭제 ID 재복사를 제거했다. 변경 세션이 없으면 프로파일링도 생략하고, 단일 snapshot/묶음의 선택과 COMMIT 전 rollup 순서는 유지한다. |
| [Codex root 선택](../../../src/summary/parsers/codex.ts#L141), [수명주기 분배](../../../src/summary/parsers/codex.ts#L188), [사용자 요청](../../../src/summary/parsers/codex.ts#L225), [완료](../../../src/summary/parsers/codex.ts#L239) | 중첩 조건식과 switch 내부 세부를 메소드로 옮겼다. 명시 root → rootless 자식 자신의 turn → 기존 root의 우선순위, 요청 상태 초기화, 완료 시각·duration·flags와 이벤트 순서를 유지한다. `forkMissing` 필드도 다른 상태 필드 옆에 배치했다. |
| [Claude 시스템 수명주기](../../../src/summary/parsers/claude.ts#L182), [stop hook](../../../src/summary/parsers/claude.ts#L210) | hook 결과 처리를 내부 메소드로 분리하고 일반 완료 종류는 switch로 표현했다. hook → 차단 검사 → 정확한 duration → 일반 완료 순서와 API 실패 우선순위를 보존한다. |
| [JSON 객체 검증](../../../src/summary/jsonl/index.ts#L10), [이미지 상태](../../../src/summary/jsonl/line.ts#L116) | JSON 문법/최상위 형식 검증을 순수 내부 함수로 모았다. 콜백 전 rows 증가와 오류 offset을 유지하며, 바이트 상태의 필수 해석 순서를 주석으로 설명했다. 파일·압축·processBatch의 별도 오류/해제 경계는 유지한다. |
| [연결 성분 탐색](../../../src/summary/scanner/refresh/persistence.ts#L92), [개별 저장 판정](../../../src/summary/scanner/refresh/persistence.ts#L105), [성분 저장](../../../src/summary/scanner/refresh/persistence.ts#L111) | 기존 너비 우선 탐색과 특수 성분 판정을 내부 함수로 옮겼다. 보류·원본 오류·고아 요청·실제 쓰기의 우선순위를 설명했다. 성분 순서·16성분/1,000요청 한도·yield/취소 지점·묶음 rollback 후 개별 복구와 settled/affected 갱신 시점은 유지한다. 미사용 destructuring도 제거했다. |
| [화면 메시지 분배](../../../src/ui/dashboard.ts#L100), [선택 세션 결제 변경](../../../src/ui/dashboard.ts#L123), [이름 조회](../../../src/ui/dashboard.ts#L131) | switch는 명령 분배를 맡고 선택 세션 검사·이름 조회의 독립 오류 응답은 각 메소드로 옮겼다. 기존 DashboardMessage 타입을 재사용하며, 상태 메시지·조회 조건을 펼쳤다. 준비 상태·제공자/세션 일치·응답 패널 동일성 검사와 스캔 없는 DB 조회 계약은 유지한다. |

외부 호출부는 [DB API](../../../src/summary/db/index.ts#L83), [갱신 조율](../../../src/summary/scanner/refresh/index.ts#L70), [원본 읽기](../../../src/summary/scanner/sourceReader.ts), [앱](../../../src/app.ts)에서 검토했다. 기존 [요청 저장/rollback](../../../tests/node/memory-incremental.test.ts#L34), [파서](../../../tests/node/parsers.test.ts#L45), [JSONL](../../../tests/node/jsonl.test.ts#L18), [화면 명령](../../../tests/node/extension.test.ts#L326)의 관련 계약과 diff를 읽기 전용으로 대조했다.

- `npm run typecheck` 통과: TypeScript 컴파일 검사와 6언어·331개 번역 키 확인.
- `npm run lint` 통과: 소스·기존 테스트·도구의 정적 분석.
- `git diff --check` 통과. 테스트 코드·임시 재현 스크립트·자동 테스트·벤치마크는 작성·수정·실행하지 않았다.
- 1차 내부 정리 6개 파일에 더해 S1·S2의 값/타입·행/오류 모듈과 역할 README를 반영했다. 앱과 quota는 검토 결과 기존 비동기 종료·실행 소유권·실패 복구 경계가 필요하여 그대로 유지했다. 추가 알고리즘 교체와 성능 개선량은 주장하지 않는다.
- [S1](#s1-요청-값-변환과-영속-반영-분리)·[S2](#s2-jsonl-행-상태와-파일-읽기-분리)의 승인 범위를 모두 적용했다. 미승인·보류 상태의 소스 변경은 없다.

## 후속 파일 분리의 통합 검증

- `npm run typecheck`·`npm run lint`·`git diff --check`를 통과했다. 타입 검사는 기존 호출부의 모듈·타입 연결과 6언어·331개 번역 키를 포함한다.
- `memoryStore.ts → memoryStore/index → values/types`, `jsonl/index → line → errors`의 의존 방향을 검토했다. 순환 역참조·오류 클래스 중복 정의가 없다. 기존 API의 module specifier를 바꾸지 않았다.
- summary → model → Skill 값 검증, 같은 열 목록을 쓰는 facts 비교·저장, 모델/Skill 정렬과 프로파일 범위를 대조했다. JSONL 행·오류 클래스는 export/import를 제외한 본문을 유지하며 readJsonl의 청크·행·offset·콜백·압축·close 순서도 유지했다.
- 역할 README·현재 설계 명세·의사결정 일지와 이 문서의 소스 링크를 실제 배치에 맞췄다. 테스트 코드 diff는 없고 자동 테스트·임시 재현 스크립트·실데이터 비교·벤치마크는 실행하지 않았다. 실행 결과 동등성과 성능 개선량은 실측하지 않았다.
- 기존 벤치마크의 파일 해시 기록은 공개 `memoryStore.ts` 경로를 유지하지만 새 구현 폴더를 자동으로 포함하지 않는다. 사용자 지시로 해당 테스트/벤치마크 코드는 수정하지 않았다. 자세한 범위는 [S1 기록](Readability-memoryStore-split-2026-11-11.md)에 남겼다.

## 작은 메소드 통합

사용자는 memoryStore/index.ts의 메소드가 지나치게 작아 흐름을 따라가기 어렵다고 지적하고 적당히 합치도록 요청했다. 입력 준비·묶음 반영·요청 한 건 저장처럼 독립적인 단계는 유지하고, 같은 단계의 검증·조회·갱신은 해당 메소드에서 이어서 읽도록 묶는다. 파일별 검증/값 변환·타입 경계와 공개 진입점은 유지한다.

단건 원본 저장·이전 원본 검증은 [원본 목록 저장](../../../src/summary/db/memoryStore/index.ts#L209)에, 세션 한 건의 누락 요청 삭제는 [전체 삭제 단계](../../../src/summary/db/memoryStore/index.ts#L245)에, 보존 요청 조회는 [보존 집합 수집](../../../src/summary/db/memoryStore/index.ts#L184)에 합쳤다. 요청의 기존 모델·Skill 조회와 facts·자식 저장도 [요청 한 건의 비교·반영](../../../src/summary/db/memoryStore/index.ts#L274) 안에 두었다. rollup은 replaceBatch 끝에, 단건 원본 삭제는 removeSources 안에 합쳤다.

비공개 메소드는 28개에서 17개로 줄었다. 보존 root를 제외하는 목록 순회인 saveSummaries와 독립 프로파일 단계인 reconnectDiagnostics는 유지했다. 짧은 메소드 수를 줄이는 것 자체보다 실제 SQL과 상태 변경의 순서가 보이는지를 기준으로 삼았다. 기존 검증·정렬·조회 생략·프로파일·예외·트랜잭션 경계는 유지했다.

통합 타입 검사·린트·diff 검사를 통과했다. 기존 요청이 없을 때와 Skill 보존 모드의 SELECT 생략, 신규 요청의 자식 DELETE 생략, summaryWrites의 finally를 코드와 참조로 대조했다. 테스트 코드 변경과 자동 테스트·임시 재현 코드는 작성하거나 실행하지 않았다. 파일별 역할·공개 API·기능 구조는 바뀌지 않아 기능 의사결정 일지에 새 항목은 추가하지 않았다.
