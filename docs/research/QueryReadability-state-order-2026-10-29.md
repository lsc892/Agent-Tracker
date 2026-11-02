# 통계 집계 상태·정렬 가독성 정리

- 범위: [rollup-state.ts](../../src/summary/db/rollup-state.ts#L10), [common/sorting.ts](../../src/summary/db/queries/common/sorting.ts#L31)로 이동한 정렬 코드.
- 현재 흐름: 집계 상태를 선언 순서대로 만들고 그 목록으로 일별 테이블을 생성한다. 표 정렬은 열 식을 선택한 뒤 미상 값, 선택 열, 보조 식별자 순서로 조립한다.
- 문제: 긴 필드 목록과 한 줄 반복·조건식 때문에 완료/기록 표본의 차이 및 정렬 우선순위를 읽기 어렵다. DDL 안의 모델 전용 열과 키를 조립하는 코드가 섞여 있다.

## 적용 범위

기존 파일 내부 정리로 적용한다. 상태 선언을 총량·완료 표본·진단 구역으로 나누고 표본과 필드 목록에 이름을 부여한다. DDL의 테이블명·모델 열·키를 지역 변수로 펼친다. 정렬 파일은 열 매핑과 미상 우선순위, 선택 열, 안정적인 보조 순서가 구분되도록 배치한다.

구역은 `// #region`과 `// #endregion`으로 짝지어 VS Code에서 집계 상태·DDL, 표시 기준 열·표 정렬을 각각 접을 수 있게 했다.

공개 API, 상태와 열 선언 순서, SQL 표현, 데이터 형식 및 정렬 순서, 검증·예외 순서를 보존한다. 스키마·집계 알고리즘은 유지하고 별도의 큰 변경 제안은 없다. 최종 파일 배치는 아래 후속 분리 범위를 따른다.

## 검증

- 수정 전 소스를 임시 파일로 보존하고 TypeScript를 메모리에서 변환해 실제 내보내기 결과를 대조했다. 집계 상태 41개의 이름·순서·식·형식·병합 방식과 테이블명·형식 버전이 완전히 일치했다.
- DDL은 공백을 정규화한 문자열이 일치했다. 정렬은 그룹·열·방향·모델·비용의 616개 조합에서 생성 문자열이 완전히 같았고, 잘못된 정렬 입력 3개의 예외 이름·메시지도 같았다.
- 변경한 두 파일의 ESLint와 `git diff --check`가 통과했다.
- [usage-chart.test.ts](../../tests/node/usage-chart.test.ts#L35)의 전체 정렬 및 원본/롤업 동등성 검증을 포함해 최종 `npm run check`의 타입 검사·린트·365개 테스트를 통과했다.
- [통합 검증 기록](QueryReadability-2026-10-29.md)에 전체 쿼리의 전후 대조 결과를 둔다. 보류한 변경이나 추가 승인이 필요한 제안은 없다.

## 파일 분리 후 벤치마크 추적 경로 대응

사용자의 후속 파일 분리 지시에 따라 벤치마크의 고정된 쿼리 파일 추적 목록도 갱신한다. `queries.ts`와 `rollup-queries.ts`는 공개 진입점으로 남지만 실제 구현은 `db/queries` 아래로 이동하므로 두 진입점만 해시하면 구현 변경이 기록되지 않는다. 삭제되는 루트 `sorting.ts` 경로도 제거해야 한다.

대상은 [date-storage-order](../../tests/benchmarks/date-storage-order.cjs), [date-storage-raw](../../tests/benchmarks/date-storage-raw.cjs), [date-storage-rollup](../../tests/benchmarks/date-storage-rollup.cjs), [sql-explain](../../tests/benchmarks/sql-explain.cjs), [sql-rollup-memory](../../tests/benchmarks/sql-rollup-memory.cjs), [sql-rollup-product](../../tests/benchmarks/sql-rollup-product.cjs), [sql-rollup](../../tests/benchmarks/sql-rollup.cjs), [sql-rowid-append](../../tests/benchmarks/sql-rowid-append.cjs)의 8개 벤치마크다. [query-source-files.cjs](../../tests/benchmarks/query-source-files.cjs#L8)로 공개 진입점과 `db/queries` 아래 TypeScript 파일을 정렬 수집하고 수집 함수 자체도 기록한다. `sql-rowid-append`는 같은 원본 목록에 대응하는 컴파일된 JavaScript도 기록한다. 기존 스키마·저장·벤치마크 파일 추적은 보존한다.

코드 분리 담당자와 소유 파일을 구분하며 이 후속 작업은 벤치마크 목록과 [도구 역할 안내](../../tests/benchmarks/README.md)만 수정했다. 공통 목록은 현재 저장소 루트만 읽으며, `sql-rollup-product`의 과거 baseline은 기존 manifest를 그대로 사용한다. 따라서 과거 baseline에 `db/queries` 폴더가 없어도 목록 수집을 시도하지 않는다.

검증 결과: 수정한 8개 벤치마크와 새 목록 함수의 `node --check`가 통과했다. 원본 모드 15개와 컴파일 포함 모드 29개 경로가 모두 존재하고, 경로 중복 없이 정렬되며 삭제된 루트 `sorting` 경로가 포함되지 않음을 확인했다. `git diff --check`도 통과했다. 성능 측정은 실행하지 않았다.
