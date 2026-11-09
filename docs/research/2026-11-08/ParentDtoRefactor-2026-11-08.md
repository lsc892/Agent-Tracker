# 부모 DTO 집계 최소화 리팩터링

2026-11-08, Asia/Seoul. 부모 DTO 차분 합산을 적용한 작업 상태에서 중복 자료·순회·임시 컬렉션을 정리했다. 사용자에게 보이는 집계 규칙과 수집·귀속·저장 경계는 유지한다.

## 유지한 알고리즘

- 응답 그룹의 Map 최대값 선택과 동점의 늦은 순번, 같은 winner DTO의 교체 전 차감·교체 후 가산.
- 직접 자식의 부모 요청 합산과 다단계 계보의 Union-Find·Small-to-Large. 부모 누락·충돌·순환 판정도 유지한다.
- legacy 복사 이력·current 우선·Claude request 보정과 부모 요청 기준 중단 제외. 나중에 도착할 수 있는 check를 위한 토큰 합계도 유지한다.

## 줄인 부분

| 위치 | 적용 내용 |
| --- | --- |
| [scanner/index.ts](../../../src/summary/scanner/index.ts) | 이미 만든 그룹의 membership을 재사용해 별도 thread 색인을 제거하고 부모 세션 판정을 그룹당 한 번만 수행한다. 관련 파일 분류는 세 번의 배열 순회 대신 한 번에 모으며 종료 후 중복 계보 계산을 제거한다. |
| [parentGroups.ts](../../../src/summary/aggregation/parentGroups.ts) | 소비하지 않는 `nested` 반환 필드를 제거한다. 다단계 분기와 실제 작은 Map 병합은 유지한다. |
| [memoryAggregate.ts](../../../src/summary/aggregation/memoryAggregate.ts) | 원본 ID·세션 Map을 한 순회로 초기화하고 이벤트와 원본 위치가 공유하는 요청 DTO 갱신을 한곳으로 모은다. |
| [winners.ts](../../../src/summary/aggregation/winners.ts) | 신규·교체 후 가산 알림을 한곳으로 모으며 선택·차감·갱신 순서와 callback·values 계약을 보존한다. |
| [turns.ts](../../../src/summary/aggregation/turns.ts) | 모델 값과 응답 개수를 하나의 Map에 보관한다. 진단은 전체 root 키를 펼치지 않고 공통·현재 root 최대 두 키만 조회한다. 메인·이름 선택은 진단 순회에 합치고 모델 결과의 중간 배열을 줄인다. |
| [parsers/codex.ts](../../../src/summary/parsers/codex.ts) | 미사용 `sawLegacy` 필드와 두 문자열의 중복 확인을 위한 임시 Set을 제거한다. |

모델의 0토큰 응답 개수와 결제 빈도는 차감에 필요하므로 유지한다. 모델 결과에는 내부 count를 내보내지 않는다. 진단의 소스 순서·root 키와 flag의 UTF-8 순서·최초 삽입 순서, 첫 메인 파일·마지막 유효 이름 선택도 보존한다. 새 알고리즘·클래스·소스 파일 분리는 추가하지 않았다.

담당 기록: [계보](ParentDtoRefactor-Lineage-2026-11-08.md), [winner 집계](ParentDtoRefactor-Aggregation-2026-11-08.md), [모델·진단](ParentDtoRefactor-Turns-2026-11-08.md).

## 검증

- 변경 전 소스와의 diff·호출부·참조를 검토했다. 파일 반영 순서·차감 후 DTO 교체·0토큰 모델·진단 순서·모호성·실패 보존 조건을 확인했다.
- `npm run typecheck`와 변경한 여섯 TypeScript 파일의 ESLint를 통과했다.
- `git diff --check`와 관련 문서 링크를 확인했다.
- 이번 작업에서는 자동 테스트·A/B·벤치마크·재현 스크립트를 작성·변경·실행하지 않았다. [앞선 A/B](../../benchmarks/2026-11-08/ParentDtoDeltaAB-2026-11-08.md)는 당시 고정 빌드의 기록이며 이번 리팩터링의 런타임 정합성·성능 검증 결과로 확대하지 않는다.

원본 JSONL·설치 DB·기능 정책은 변경하지 않았으며 새 기능 의사결정 항목은 추가하지 않는다. 별도 승인 대기 제안은 없다.
