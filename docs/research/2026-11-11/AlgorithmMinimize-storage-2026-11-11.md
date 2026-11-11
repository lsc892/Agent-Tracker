# 저장 알고리즘 최소화

2026-11-11, Asia/Seoul. 사용자가 현재 기능을 유지한 알고리즘·쿼리 최소화를 명시적으로 요청한 범위에서 적용한다.

## 검토와 적용 방향

- [요청 저장](../../../src/summary/db/memoryStore.ts): 기존 요청을 읽은 직후 같은 ID로 비용 메타데이터를 다시 SELECT한다. 요청 조회의 LEFT JOIN으로 함께 읽어 비용 비교용 SELECT를 제거한다. 비용 행 부재와 단가 버전·결제 방식 비교는 유지한다.
- 같은 파일에서 모델 SQL ORDER BY 뒤 JavaScript 비교 정렬을 다시 수행한다. 기존 JavaScript 비교 순서를 유지하고 모델 SQL 정렬만 제거한다. Skill은 localeCompare가 다른 Unicode 표기에 동점을 낼 수 있어 기존 SQL의 동점 순서를 유지한다. Skill 보존 모드에서는 기존 Skill을 읽어도 비교·교체에 사용하지 않으므로 해당 SELECT를 생략한다. 입력 Skill 검증은 유지한다.
- 같은 세션의 누락 파일마다 삭제 보존 요청을 다시 읽는다. 세션별 한 번만 읽고 요청·root·세션 보존 집합은 유지한다.
- [세션 결제 변경](../../../src/summary/db/billing.ts): ID 페이지를 읽어 요청마다 비용 SQL을 실행하는 대신 선택 세션의 요청·모델을 한 번 GROUP BY하여 비용을 교체한다. 모델 없는 요청·NULL 추정 비용·subscription/api/unknown 의미와 같은 transaction을 유지한다.
- [Worker coverage](../../../src/summary/client/worker.ts)는 진단 목록이 필요 없는 곳에서도 목록 두 개를 조회한다. 쿼리 담당자가 분리하는 counts 전용 조회를 [DB API](../../../src/summary/db/index.ts)에 연결한다.

## 보존 경계와 검증 계획

영속 스키마·요청 ID·입력 검증·이름 저장 순서·updated_at·기존 자식 교체·rollback·실제 오류 전파는 유지한다. 테스트 코드·임시 재현 스크립트를 만들거나 테스트·벤치마크를 실행하지 않는다. 코드·참조·diff와 TypeScript 컴파일로 확인하며, 실행 시간 개선과 실데이터 정합성은 이번 작업에서 측정하지 않는다.

## 결과

위 후보를 모두 반영했다. 비용 집계 식은 단일 요청·세션 전체 쓰기에서 같은 상수를 공유한다. 모델 없는 요청의 API 비용 NULL·미상 표본 1개·구독 비용 0, 모델별 NULL 비용과 결제 선택·단가 버전 의미를 코드로 대조했다. 비용 메타데이터 LEFT JOIN은 PK로 한 행만 연결하고 추가 alias는 facts 비교 열에 포함하지 않는다.

Skill 보존 모드의 기존 요청은 자식 교체 분기에 들어가지 않으므로 이전 Skill SELECT가 필요 없으며, 신규 요청은 입력 Skill을 계속 저장한다. 보존 요청 dedup은 모든 쓰기 전에 같은 세션 조건을 읽으므로 집합 결과를 유지한다. 요청 ID·updated_at·기존 자식 교체·FK·transaction/rollback 경계도 유지한다.

쿼리 담당자가 저장 diff를 독립적으로 읽고 위 경계를 교차 검토했다. 전체 `npm run typecheck`·`npm run lint`와 `git diff --check`를 통과했다. 테스트 코드·임시 재현/검증 스크립트·실제 DB 조회·자동 테스트·벤치마크는 실행하지 않았다.

## 후속 실측

성능·정합성 측정 요청에 따라 [DB 검증](../../benchmarks/2026-11-11/AlgorithmMinimizeDbValidation-2026-11-11.json)에서 비용 독립 기대값·NULL·모델 없는 요청·사용자 선택·단가·trigger rollback·Skill 보존·동일 세션 누락·재연결을 통과했다. 합성 24요청의 동일 저장 SQL은 114→90, 보존 모드는 114→66, 세션 결제 변경은 27→2회였다.

[최종 A/B](../../benchmarks/2026-11-11/AlgorithmMinimizeAB-2026-11-11.md)의 세션 api 변경은 현재 25.75%·10,000건 35.58% 단축됐다. 반면 최초 요청 저장은 4.81–5.67% 느렸고 현재 추가 DB 저장도 3.898→4.687ms로 악화했다. SQL 감소만으로 요청 저장 성능이 개선됐다고 판단하지 않는다. 측정 중 제품을 바꾸거나 새 캐시·분기를 추가하지 않았다.
