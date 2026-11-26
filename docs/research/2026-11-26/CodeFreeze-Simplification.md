# 기능 동결을 위한 통계 코드 정리

## 검토 범위

- 통계 수집과 Codex 제목 인덱스는 고정 객체 필드와 스칼라를 선택하며, 나머지 JSON의 문법도 검사한다. 진단용 판독기는 행 종류에 따라 필드를 선택한다. [스레드 판독](../../../src/summary/scanner/sourceReader.ts#L54) [제목 인덱스](../../../src/summary/scanner/names.ts#L11) [진단용 필드](../../../src/summary/parsers/logFields.ts#L90)
- 스레드 집계는 대표 원본과 응답 최고값을 기준으로 응답·누계·구형 부모 기록을 대조한다. [응답 선택](../../../src/summary/scanner/refresh/aggregation.ts#L39) [누계 대조](../../../src/summary/aggregation/threadAccounting.ts#L165)
- 일별 집계 입력은 토큰과 모델 비용을 구성한다. 일별 조회는 날짜와 제공자·모델·프로젝트·세션 범위별 통계를 반환한다. [저장 입력](../../../src/summary/db/dailyFacts.ts#L14) [일별 조회](../../../src/summary/db/queries/rollup/usage.ts#L42)

## 적용 결과

- 고정 필드의 사용처를 재귀 타입에 반영하고, 짧은 행과 청크 경계 행 모두에서 하위 객체·배열을 통째로 선택하는 분기를 제거했다. 선택 필드의 스칼라 값과 빈 객체·배열 표현, 생략된 값의 문법 검사는 기존 규칙을 따른다. [짧은 행](../../../src/summary/jsonl/projection.ts#L34) [경계 행](../../../src/summary/jsonl/streamProjection.ts#L90)
- 스레드 ID·세션 ID·프로젝트 값의 정규화를 파서 한곳에서 끝낸다. 파일 읽기 실패 때 갱신 범위를 판단하는 데 쓰는 세션 ID만 Worker 결과로 전달한다. 첫 Codex 응답의 누계 값은 함께 저장된다는 보장도 타입에 반영했다. [스레드 결과](../../../src/summary/parsers/threadUsage.ts#L150) [파일 준비 결과](../../../src/summary/scanner/sourcePreparation.ts#L11) [누계 비교](../../../src/summary/aggregation/threadAccounting.ts#L86)
- 변경으로 판정된 파일의 같은 조건을 파싱 뒤 다시 계산하던 부분을 제거했다. 미리보기에서 보류했거나 관련 원본을 다시 읽은 경우에는 해당 시점의 판정을 적용한다. [갱신 반영](../../../src/summary/scanner/refresh/preparation.ts#L43)
- 디렉터리 순회 한 번으로 Codex 제목 DB의 최고 버전을 고르며, 같은 숫자 버전은 처음 발견한 파일을 선택한다. 제목 인덱스 행에 세션 키를 한 번만 만들고 `lstat().isFile()`에 포함된 파일 종류 확인을 중복하던 부분도 제거했다. [제목 읽기](../../../src/summary/scanner/names.ts#L11)
- 모델 비용과 명시 모델의 유무를 한 순회에서 계산했다. 일별 조회의 중간 SQL은 집계·정렬에서 사용하는 모델 이름을 읽으며, 저장에 쓰는 모델 키가 필요한 곳은 일별 쓰기 경로다. [집계 입력](../../../src/summary/db/dailyFacts.ts#L14) [일별 조회 SQL](../../../src/summary/db/queries/rollup/source.ts#L11)

## 별도 범위

- 이전 요청 단위 API와 진단용 응답 단위 파서는 기존 테스트와 비교 도구에서 호출한다. 이 인터페이스 정리는 일별 열 합계와 스레드 단위 검증을 사용하는 방식으로 호출부를 옮기는 별도 작업이다. [이전 조회](../../../src/summary/db/index.ts#L102) [진단 파서](../../../src/summary/scanner/sourceReader.ts#L69) [테스트 호출](../../../tests/node/memory-incremental.test.ts) [과거 벤치마크 호출](../../../tests/benchmarks/mtime-refresh-ab.cjs)
- 미리보기 스냅샷의 복사 범위를 줄이는 변경은 관련 원본과 부모 참조, 진단 수치, 영속 갱신 결과를 함께 비교할 때 검토할 수 있다. [스냅샷 복사](../../../src/summary/db/recentSnapshot.ts#L9)

## 검증

호출부와 diff에서 JSON 필드 선택, 원본 변경 판정, 제목 우선순위, 날짜·모델 그룹의 유지 여부를 검토했다. 타입·번역 확인, 린트, diff 공백 검사를 통과했다. 실제 데이터 동작 확인, 자동 테스트와 벤치마크는 실행하지 않았다.
