# 원본 통계 SQL 책임별 분리

## 검토 범위와 계약

- [queries.ts](../../src/summary/db/queries.ts): 기존 호출 경로를 보존하는 공개 진입점.
- [reader.ts](../../src/summary/db/reader.ts): 생성된 SQL의 필터 바인딩 뒤에 페이지 바인딩을 연결하는 호출부.
- [summary-rollup.test.ts](../../tests/node/summary-rollup.test.ts), [usage-chart.test.ts](../../tests/node/usage-chart.test.ts): 원본과 롤업 결과·정렬·페이지 동등성 검증.
- 공개 export, 출력 열 순서, SQL의 의미, 바인딩 순서, 입력 검증과 예외 순서를 보존한다.

## 문제와 적용 범위

`queries.ts`에 서로 다른 조회 역할이 모여 필요한 SQL의 책임을 파일 이름으로 찾기 어려웠다. 사용자의 명시적 요청인 “스크립트를 책임별로 쪼개고 폴더별로 분간이 쉽게”를 승인 범위로 삼아, 공통 계약·필터·정렬과 원본 조회 SQL을 폴더·스크립트로 분리했다. 각 SQL의 절·CASE·서브쿼리를 펼치고 조건부 조각은 지역 이름으로 설명한다.

- 승인·적용 범위: 원본 SQL을 [common](../../src/summary/db/queries/common/README.md), [raw](../../src/summary/db/queries/raw/README.md)로 분리하고 루트 정렬 구현도 공통 폴더로 옮겼다. 공개 export·SQL 의미·바인딩·집계 알고리즘은 유지했다.
- 루트 [queries.ts](../../src/summary/db/queries.ts)는 9줄의 공개 API re-export만 남겼다. 내부 모듈은 필요한 하위 모듈을 직접 참조해 순환 의존을 만들지 않는다.
- 원래 `src/summary/db/sorting.ts`의 구현은 [common/sorting.ts](../../src/summary/db/queries/common/sorting.ts)로 옮겼다. 롤업 호출부도 이 공통 모듈을 직접 참조한다.
- 승인 대기 큰 변경: 없음.

변경 전에는 `queries.ts`가 모든 원본 SQL을, 루트 `sorting.ts`가 표 정렬을 맡았다. 적용한 구조와 책임은 다음과 같다.

```text
queries.ts                    공개 진입점
queries/
  common/
    types.ts                  SQL·바인딩과 집계 기준 타입
    filters.ts                제공자·프로젝트·세션·날짜 필터
    sorting.ts                미상 우선순위와 표 정렬
  raw/
    source.ts                 제공자·모델 요청 원본 projection
    usage.ts                  원본 통계 집계·개수
    turns.ts                  요청 목록·개수
    names.ts                  프로젝트·세션 이름 선택
    capabilities.ts           도구 분류별 순위·전체 합계
    diagnostics.ts            파일·요청 진단
```

공통 구현: [types.ts](../../src/summary/db/queries/common/types.ts), [filters.ts](../../src/summary/db/queries/common/filters.ts), [sorting.ts](../../src/summary/db/queries/common/sorting.ts).

원본 구현: [source.ts](../../src/summary/db/queries/raw/source.ts), [usage.ts](../../src/summary/db/queries/raw/usage.ts), [turns.ts](../../src/summary/db/queries/raw/turns.ts), [names.ts](../../src/summary/db/queries/raw/names.ts), [capabilities.ts](../../src/summary/db/queries/raw/capabilities.ts), [diagnostics.ts](../../src/summary/db/queries/raw/diagnostics.ts).

## 검증 계획과 결과

- 적용 상태: 책임별 소스 분리와 폴더별 책임 안내 완료.
- 적용 전 임시 보관한 원본과 수정 후 코드를 같은 TypeScript transpiler로 로드해 40,430건의 builder 호출을 비교했다. SQL 공백만 제외한 토큰, 바인딩, 공개 export, 예외 이름·메시지가 모두 같았다. 제공자·모델, 모든 그룹·표 정렬 열·방향, 비용·빈 사용량 설정, 기간·시간 미상, 이름 escape, 잘못된 입력을 포함했다.
- 분리 후 수정 파일 ESLint, 전체 `tsc --noEmit`, `git diff --check` 통과. 위 40,430건 비교도 최종 공개 진입점과 분리된 구현으로 다시 통과했다.
- 최종 통합본의 `npm run check`에서 타입 검사·린트·365개 테스트를 통과했다. 전체 쿼리 전후 대조는 [통합 검증 기록](QueryReadability-2026-10-29.md)에 둔다.
- 실제 계정 호출·설치·패키징은 수행하지 않았다. 본 작업은 SQL 동작을 보존하는 내부 가독성 정리다.
