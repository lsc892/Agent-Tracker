# 집계·관계 알고리즘 최소화

2026-11-11, Asia/Seoul. 사용자가 현재 기능을 보존하는 알고리즘 재검토·최소화와 불필요한 방어·확장 코드 제거를 직접 요청한 범위다.

## 현재 흐름과 적용 방향

- [부모 계보 그룹화](../../../src/summary/aggregation/parentGroups.ts): `resolveRoots`가 이미 각 ID의 최상위 부모를 확정하는데, 깊은 계보에만 다시 Union-Find와 작은 Map 병합을 수행한다. 확정한 root별 직접 그룹화로 통합한다. 루트 해소 중 방문 상태도 결과 Map의 임시 `null`로 표현해 별도 방문 Set을 없앤다.
- [파일 변경 판정](../../../src/summary/scanner/refresh/discovery.ts): 비교 전용으로 같은 메타데이터를 매번 JSON 배열 두 개로 직렬화한다. 동일한 필드의 직접 비교로 바꾸어 배열·문자열 생성을 없앤다. `lstat`·Dirent의 file/directory 판정에서 이미 제외되는 심볼릭 링크의 중복 분기도 제거한다.
- [이벤트 문자열 정규화](../../../src/summary/aggregation/sourceEvidence.ts): 비정상 UTF-16 문자열의 동일한 UTF-8 변환을 판정과 반영에서 반복한다. 변환 결과를 한 번만 계산한다.
- [원본 집계 전달](../../../src/summary/scanner/refresh/aggregation.ts): standalone 진단은 `prepareSources`가 공통으로 추가하므로 scanner의 같은 진단 추가를 제거한다.

## 보존할 계약과 검토 근거

계보의 누락·상충·순환과 그 후손은 각 ID의 독립 그룹으로 유지하고, 같은 정상 계보 ID들은 같은 그룹 객체를 참조한다. 동일 ID에 속하는 원본의 입력 순서와 최상위 root의 원본 목록을 유지한다. 제품의 [관계 해소 호출부](../../../src/summary/scanner/refresh/relations.ts)는 멤버 Map을 순회하지 않고 최상위 root의 원본 목록만 조회한다. 따라서 기존 Union-Find 내부 병합 순서는 사용자 결과에 관여하지 않는다.

기존 [계보 사례](../../../tests/node/summary-lineage.test.ts), [증분 집계 사례](../../../tests/node/memory-incremental.test.ts), [집계 oracle 사례](../../../tests/node/memory-aggregate.test.ts)는 읽어서 보존 경계를 확인한다. 테스트 코드·임시 검증 스크립트는 생성·변경하지 않고 실행하지 않는다. 코드·참조·diff 검토와 TypeScript 컴파일만 수행한다.

## 적용 결과·검증

위 네 후보를 적용했다. 부모 root를 해소한 뒤의 깊이 분기·Union-Find 대표 찾기·작은 Map 재병합·최종 대표 재조회가 사라졌다. root별 직접 그룹화의 시간·보조 공간은 모두 ID 수에 선형이다. 기존의 누락·충돌·순환 감지와 깊은 계보의 비재귀 처리는 유지한다.

소스·테스트·도구의 모든 `groupParents` 참조를 검색했다. 그룹과 멤버 Map의 내부 키 순회 순서는 입력순으로 바뀔 수 있으나 유일한 제품 소비자는 `groups.get(threadId)`와 `members.get(rootId)`만 사용한다. winner tie 순서는 준비 파일의 sequence와 이벤트 index를 계속 사용하며 이 Map의 순서를 참조하지 않는다. 정상 종점·이미 확정한 root 합류·누락/충돌 조상·자기순환/다중순환/의존 경로를 코드로 추적해 임시 `null` 방문 표시가 이전 방문 Set과 같은 결과를 내는지 검토했다.

메타데이터 비교는 기존의 제공자·경로·원본 root·크기·mtime·dev·inode·parser version 8필드를 그대로 사용한다. `lstat`의 심볼릭 링크는 file/directory가 아니고 Dirent의 심볼릭 링크도 file/directory 분기에 들어가지 않아 링크 제외 동작은 유지한다. 문자열 정규화는 변환 결과만 재사용하고 정상 이벤트 참조를 유지한다. standalone 진단은 공통 집계 준비에서 계속 추가한다.

`npm run typecheck`와 담당 파일의 `git diff --check`를 통과했다. 테스트 코드·임시 스크립트를 생성·변경·실행하지 않았다. 실행 시간·실데이터 정합성 대조·자동 테스트는 수행하지 않아 속도 향상이나 실행 결과 일치를 실측했다고 주장하지 않는다. 트랜잭션·취소·재시도·원본 보존 경계와 winner 차분 집계는 변경하지 않았다.

## 후속 실측

성능·정합성 측정 요청에 따라 [독립 계보 oracle을 포함한 170 그래프](../../benchmarks/2026-11-11/AlgorithmMinimizeParsingValidation-2026-11-11.json), 실제·합성 A/B와 거래 경계를 검증했다. 누락·충돌·순환·깊은 역순 계보·중복 원본·공유 그룹·root별 원본 배열을 통과했다. [A/B](../../benchmarks/2026-11-11/AlgorithmMinimizeAB-2026-11-11.md)의 현재 관계 확대는 2.134→1.621ms였지만 계보 함수 단독 측정은 아니다. 전체 최종 집계의 개선은 크지 않고 합성 10,000건은 소폭 느렸다.
