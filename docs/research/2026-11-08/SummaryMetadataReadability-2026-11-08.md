# SummaryMetadata 책임 분리 — 2026-11-08

## 범위와 보존 계약

사용자가 요청한 `summary` 책임별 폴더 구성과 `metadata.ts`의 스크립트 분리를 적용했다. 기존 [SummaryMetadata 공개 API](../../../src/summary/metadata/index.ts#L13)는 유지하고, 의미 서명·dirty 의존성·확정 snapshot·TEMP 수명을 별도 책임으로 나눴다.

기존 `prepare()`는 현재 요청 범위 생성, 파일 root 수집, 세션·요청 서명 갱신, 변경 요청 존재 판정과 의존성 확장을 한 흐름에 담고 있었다. `commit()`은 확정 요청·모델·Skill snapshot과 의존 키의 영속화를 함께 수행했다.

- SQL 문장·바인딩·실행 순서, root 정렬과 해시 바이트·버전, 트랜잭션·예외 경계를 보존한다.
- 파일 root 캐시는 서명 구성요소가 단독 소유하고 `release()`/`close()`에서 같은 시점에 해제한다.
- 현재 의존 키는 dirty 요청이 있을 때만 교체하고, 확정 snapshot을 저장한 뒤 같은 순서로 영속화한다.
- 알고리즘·자료구조·공개 API 변경은 포함하지 않는다.

## 적용 구조

- [index.ts](../../../src/summary/metadata/index.ts#L28): 요청 범위 초기화 → 서명 비교 → 변경 존재 확인 → 의존성 확장 순서를 조율하고 TEMP 표의 생성·정리를 소유한다.
- [signatures.ts](../../../src/summary/metadata/signatures.ts#L23): 파일 root 캐시를 단독 소유하고 원본 순서·이름·품질 flag를 동일한 해시 입력 순서로 반영한다.
- [dependencies.ts](../../../src/summary/metadata/dependencies.ts#L6): dirty 요청이 있을 때만 현재 의존 키를 교체하며 TEMP 적재·공유 연결 확장·확정 의존 키 저장을 담당한다.
- [snapshots.ts](../../../src/summary/metadata/snapshots.ts#L43): 현재 성분의 확정 요청·모델·Skill을 기존 순서로 교체하고 변경 없는 결과를 지연 조회한다.
- [types.ts](../../../src/summary/metadata/types.ts): 공유 식별자·원본 root·의존 키와 dirty 저장 범위를 정의한다.

파일 생성·분리는 이번 사용자 요청에서 승인된 범위다. 추가 알고리즘·자료구조 변경 제안은 없다. [폴더 README](../../../src/summary/metadata/README.md)에 각 파일의 책임과 수명을 정리했다.

## 검증 상태

- metadata의 TypeScript 5개 파일을 독립 transpile해 문법 진단 0건을 확인했다. 이 결과는 import 해석·타입 검사나 기능 검증을 대신하지 않는다.
- 기존 SQL·바인딩 순서, 세션·root 정렬, `greedy-root-v1:` 해시 입력, dirty가 없는 갱신에서 현재 의존 키를 유지하는 시점과 `release()`/`close()`의 해제 순서를 원본과 대조했다.
- 전체 이동 후 `npm run check`의 타입 검사·린트·430개 테스트가 통과했다. 분리 전/후 SQL 경로의 1/35세션·Skill ON/OFF·최초/무변경/변경/metadata 실패/재시도 20상태에서도 서명·dirty 키·SQL 순서/바인딩·예외·모든 영속 결과가 일치했다. [통합 검증](SummaryOrganization-2026-11-08.md#검증)에 전체 범위를 기록했다.
