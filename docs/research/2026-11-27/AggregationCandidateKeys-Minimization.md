# 세션 응답 후보 등록 간소화

## 검토

[수집 진입점](../../../src/summary/scanner/refresh/aggregation.ts#L8)은 파일별 후보를 집계기에 등록한 뒤 세션 단위로 확정한다. 키 직렬화를 줄인 집계 경로에는 기본 후보와 레거시 대체 후보를 배열에 추가하는 코드가 각각 있다. 요청 ID가 비어 있는 Claude 응답을 비교하는 값도 정렬과 콜백에서 따로 적고 있다. [집계 코드](../../../src/summary/aggregation/memoryAggregate.ts)

## 적용

유효한 파일 후보를 먼저 결정하고 한 곳에서 세션 배열에 넣는다. 후보 객체와 생성 함수의 이름은 확정 전 응답을 다룬다는 뜻을 드러낸다. Claude의 누락 요청 ID 값은 정렬과 콜백에서 같은 상수를 사용하고, 응답과 누계가 공유하는 귀속 ID 계산도 한 번으로 모았다. [후보 생성과 등록](../../../src/summary/aggregation/memoryAggregate.ts#L135) · [누락 요청 ID 상수](../../../src/summary/aggregation/memoryAggregate.ts#L28)

## 검증

직전 계측 빌드와 diff를 대조했다. 기본 후보의 참조 조회와 유효성 검사는 각각 한 번 수행하며, 탈락하면 기존 순서의 첫 유효한 대체 후보를 택한다. 원래 응답 ID 정렬과 winner 반영 순서, 콜백 키 형식이 유지되는 것을 확인했다. 타입 검사·린트·diff 검사를 통과했다. 자동 테스트와 성능 재측정은 미실행이다. [직렬화 절감 A/B](../../benchmarks/success/2026-11-27/AggregationCandidateKeysAB-2026-11-27.md)
