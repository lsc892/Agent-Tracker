# 요청 값 변환과 영속 반영 분리

2026-11-11, Asia/Seoul. [통합 제안 S1](Readability-2026-11-11.md#s1-요청-값-변환과-영속-반영-분리)에 대한 사용자 승인 범위를 적용한다. 선행 내부 가독성 정리를 보존한다.

## 적용한 구조와 보존 경계

- [공개 진입점](../../../src/summary/db/memoryStore.ts#L2)의 구현을 [memoryStore/index.ts](../../../src/summary/db/memoryStore/index.ts#L56)로 옮겨 MemoryStore의 트랜잭션·원본 수명·SQL 반영 책임을 유지했다. 기존 파일에는 명시적인 `./memoryStore/index` re-export만 남겼다.
- [values.ts](../../../src/summary/db/memoryStore/values.ts#L7)에 요청·모델·Skill의 검증과 SQL 값 변환, 비교용 정렬·동등성·요청 열 비교를 상태 없는 함수로 모았다. 같은 열 순서를 비교와 쓰기에 사용하도록 열 목록도 함께 두었다.
- [types.ts](../../../src/summary/db/memoryStore/types.ts#L4)에 외부 입력 `MemoryReplacement`와 결과 `SavedSessionNames`를 두고 index에서 타입을 다시 공개했다. [DB API](../../../src/summary/db/index.ts#L13)와 [스캔 저장](../../../src/summary/scanner/refresh/persistence.ts#L4)의 기존 import 경로는 유지했다.
- 모델·Skill iterable의 소비 순서, summary → model → Skill 검증 순서, undefined/null 기본값, 모델 문자열 순서와 Skill의 SQL·localeCompare 동점 순서를 보존한다. SQL·트랜잭션·프로파일·rollup 순서도 바꾸지 않는다.
- [폴더 README](../../../src/summary/db/memoryStore/README.md)는 같은 폴더의 파일별 역할과 의존 방향을 설명한다. 클래스·알고리즘·스키마를 추가로 분리하거나 교체하지 않았다.

기본 TypeScript 컴파일은 이동 전 출력물을 지우지 않는다. 기존 `dist/src/summary/db/memoryStore.js`가 남아 폴더 index보다 먼저 선택되는 문제를 피하도록 공개 진입점을 유지한다. facade의 명시적인 `/index` 경로는 자기 파일로 다시 해석되는 순환을 방지한다.

변경 전에는 `db/memoryStore.ts` 한 파일이었다. 변경 후에는 다음처럼 기존 진입점과 역할별 구현 폴더를 함께 둔다.

```text
db/
├─ memoryStore.ts          공개 re-export
└─ memoryStore/
   ├─ index.ts             트랜잭션과 영속 반영
   ├─ types.ts             입력·결과 타입
   ├─ values.ts            검증·변환·비교
   └─ README.md            역할과 의존 방향
```

## 확인할 계약

[동일 요청 쓰기 생략·rollback](../../../tests/node/memory-incremental.test.ts#L34), [모델 합계와 model_usage 부재](../../../tests/node/costs-models.test.ts#L137), [캐시 분해 검증](../../../tests/node/token-breakdown.test.ts#L137), [원본 소실 보존](../../../tests/node/source-retention.test.ts#L29), [재연결 진단](../../../tests/node/source-reconnection.test.ts#L111)을 읽기 전용으로 검토했다. 기존 [최소화 결정](AlgorithmMinimize-storage-2026-11-11.md)의 불필요한 SELECT 제거와 세션별 보존 조회는 그대로 유지한다.

## 검증과 남은 사항

- [요청 저장 호출](../../../src/summary/db/memoryStore/index.ts#L284)이 summary → model → Skill 변환과 facts 비교를 같은 순서와 프로파일 범위에서 수행하는지 원문과 대조했다. 이동한 함수 본문은 기존 계산·검증·기본값을 유지한다.
- [모델 조회 정렬](../../../src/summary/db/memoryStore/index.ts#L289), [Skill 조회 정렬](../../../src/summary/db/memoryStore/index.ts#L295), [요청 쓰기](../../../src/summary/db/memoryStore/index.ts#L311)의 SQL·열 순서·비교 함수를 대조했다. 특히 Skill SQL의 동점 순서와 preserveCapabilities의 조회 생략을 유지했다.
- [snapshot 진입점](../../../src/summary/db/memoryStore/index.ts#L68), [rollup 선택](../../../src/summary/db/memoryStore/index.ts#L82), [이름 공유 판정](../../../src/summary/db/memoryStore/index.ts#L96)의 선행 정리를 유지했다. DB 접근·상태 수명·트랜잭션·프로파일의 새 경계를 만들지 않았다.
- 소스·참조·diff와 상대 링크를 검토했고 `git diff --check`에서 공백 오류가 없었다. 컴파일과 린트는 메인 에이전트가 전체 변경을 합쳐 확인한다.
- 최초 분리 시 구현은 index 445줄·values 112줄·types 16줄로 나뉘었다. index는 영속 반영과 같은 트랜잭션의 상태만 소유하며, 줄 수에 맞춘 추가 클래스 분리는 하지 않았다. S1은 승인 범위를 모두 적용했다.
- 기존 [벤치마크 산출물 경로 기록](../../../tests/benchmarks/algorithm-minimize-db-validation.cjs#L363) 등은 기존 source/compiled artifact 파일을 직접 가리킨다. 경로는 facade로 유지하지만 구현 폴더의 해시까지 자동으로 포함하지는 않는다. 테스트 코드 수정·실행 금지 범위에 따라 관련 벤치마크는 수정하거나 실행하지 않았다.
- 사용자 지시에 따라 테스트 코드 작성·수정, 자동 테스트·임시 재현 스크립트·벤치마크는 수행하지 않았다. 실행 결과 동등성과 실데이터 성능은 미검증이다.
- 메인 통합 검증에서 `npm run typecheck`·`npm run lint`·`git diff --check`를 통과했다. 기존 소스/타입 호출부 경로도 컴파일로 확인했다.

## 사용자 조정: 단건 메소드 병합

사용자가 분리된 파일은 유지하면서 index 내부의 지나치게 작은 메소드를 적당히 합쳐 실제 SQL과 상태 갱신을 이어서 읽을 수 있게 요청했다. 값 변환·타입·공개 진입점은 그대로 두고 다음 범위만 병합한다.

- rollup 선택은 `replaceBatch` 끝으로, 한 세션 보존 조회는 `collectRetainedUsage`의 세션 루프로 옮긴다.
- manifest 단건 저장·이전 귀속 검증을 `saveFiles`로, 세션별 누락 요청 삭제와 원본 단건 삭제를 각각 기존 반복 메소드로 합친다.
- 한 요청에서만 쓰는 모델/Skill 조회·요청 쓰기·모델/Skill 교체를 `saveSummary`에 이어 배치한다. 비교 → 변경 여부 판단 → facts/자식/비용 쓰기를 같은 메소드에서 읽게 하되 기존 프로파일과 예외 범위는 유지한다.
- 준비·영속 반영·메타데이터 수집과 저장처럼 의미 있는 단계, 여러 경계에서 쓰는 세션 검증은 유지한다. SQL·검증·정렬·iterable 소비·상태 갱신·트랜잭션 순서는 바꾸지 않는다.

적용 뒤 코드·참조·diff를 검토하고 메인에서 컴파일·린트를 통합 확인한다. 테스트 작성·수정·실행과 임시 재현 코드는 만들지 않는다.

### 병합 결과

- private 메소드는 28개에서 17개로 줄였으며 index는 445줄에서 399줄이 됐다. 공개 2개 메소드와 파일별 역할 경계는 유지한다.
- [replaceBatch](../../../src/summary/db/memoryStore/index.ts#L68)에 rollup 선택, [collectRetainedUsage](../../../src/summary/db/memoryStore/index.ts#L184)에 한 세션의 보존 조회, [saveFiles](../../../src/summary/db/memoryStore/index.ts#L209)에 이전 귀속 검사와 manifest 저장을 합쳤다. [deleteMissingSummaries](../../../src/summary/db/memoryStore/index.ts#L245)와 [removeSources](../../../src/summary/db/memoryStore/index.ts#L374)에서도 단건 전달을 없애 반복과 SQL이 함께 보이게 했다.
- [saveSummary](../../../src/summary/db/memoryStore/index.ts#L274)에는 이전 모델·Skill 조회/정렬, 변경 비교, 요청·자식 행 쓰기를 합쳤다. facts/models/capabilities의 `profile.measure` 콜백과 summaryWrites의 finally 범위를 보존했다. 신규 요청과 Skill 보존 모드의 조회 생략, 자식 삭제의 `previous !== undefined` 판정도 유지한다.
- 제거한 함수에서만 사용하던 `StoredRow`·`MemoryFile` 타입 별칭과 `SQLOutputValue` import를 함께 없앴다. SQL 문구·바인딩·검증 순서·예외·상태 갱신을 코드로 대조했다.
- 남은 짧은 [requireSession](../../../src/summary/db/memoryStore/index.ts#L146)은 여러 원본/요청 경계가 공유하는 검증이다. [saveSummaries](../../../src/summary/db/memoryStore/index.ts#L263)는 보존 root 제외와 요청 반복의 단계이고, [reconnectDiagnostics](../../../src/summary/db/memoryStore/index.ts#L367)는 독립 프로파일 단계라 유지했다. prepare/applyPrepared·메타데이터 판단은 큰 단계의 흐름을 보여 준다.
- 코드·참조·diff 검토와 `git diff --check`에서 문제를 발견하지 않았다. 이번 병합 이후 메인 통합 검증에서도 `npm run typecheck`·`npm run lint`·`git diff --check`를 통과했고 테스트 diff가 없음을 확인했다. 테스트·실데이터 동등성·성능 검증은 실행하지 않았다.
