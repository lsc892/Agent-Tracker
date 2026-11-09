# 부모 DTO 집계 내부 정리

2026-11-08, Asia/Seoul. 부모 합산·차분 집계의 동작과 공개 호출 방식을 보존하는 내부 리팩터링이다.

## 검토 범위와 현재 흐름

- [StreamingAggregation](../../src/summary/aggregation/memoryAggregate.ts)은 준비된 원본을 세션으로 묶고, 원래 root에서 유효성을 확인한 뒤 부모 root에 winner·요청 상태를 반영한다.
- [Winners](../../src/summary/aggregation/winners.ts)는 input+output 최대값·동점의 늦은 순번을 선택하며 같은 DTO를 갱신하고 교체 전 차감·교체 후 가산을 알린다.
- [기존 호출 계약](../../tests/node/streaming-winner.test.ts)과 [집계 fixture](../../tests/node/memory-aggregate.test.ts)는 읽기만 했다. 테스트 코드는 수정하거나 실행하지 않는다.

## 적용한 내부 정리

1. 원본 ID 인덱스와 세션 묶음을 같은 순회에서 초기화해 별도 entries 배열과 중복 초기화 순회를 제거한다.
2. 이벤트 입력과 패자 위치 보존이 공유하는 root 조회·생성·최소 offset·최초 파일·main 상태 갱신을 같은 클래스의 한 메소드로 모은다.
3. winner 신규 등록과 교체가 공유하는 최종 가산 알림을 한곳으로 모은다. 선택·차감·DTO 갱신·가산 순서와 optional callback·values API를 유지한다.

## 유지할 상태와 큰 변경 판단

`totals`는 나중에 도착하는 check를 검증하기 위한 상태다. 제품의 check 발행자는 Codex지만 공통 ParseEvent와 기존 fixture는 Claude check도 허용한다. 제공자만 보고 totals 생성을 생략하거나 check 이전의 사용량을 버리면 기존 계약이 달라지므로 유지한다. check 보존 방식 변경·자료구조 교체·클래스 또는 파일 분리는 이번 정리에 추가하지 않는다. 별도 승인 대기 제안은 없다.

## 검증 계획과 결과

세 항목 모두 기존 파일 안에서 적용했다. 코드·호출부·diff를 검토하고 선택 순서, 부모 root 변환 전 유효성 판정, 진단 위치·품질 flag, 교체 전후 알림 순서와 DTO 객체 재사용을 확인했다. 0토큰 모델을 처리하는 addWinner 호출과 인자는 유지했다. `git diff --check`는 통과했다. 자동 테스트·벤치마크·A/B 및 재현 스크립트는 작성하거나 실행하지 않았다. 컴파일·린트는 메인 에이전트가 수행하며 실제 데이터 재대조는 이번 작업에서 미수행이다.
