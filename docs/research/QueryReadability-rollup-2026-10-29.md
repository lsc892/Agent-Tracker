# 롤업 SQL 가독성 정리 — 2026-10-29

## 범위와 승인

- 사용자의 파일별·구역별 가독성 개선 요청과 책임별 스크립트를 폴더로 구분하라는 추가 지시에 따라 롤업 SQL을 `queries/rollup/`에 분리했다.
- SQL의 의미, 출력 열 순서, 바인딩 순서, 검증·예외·원본 대체 조건은 보존한다. 집계 알고리즘이나 DB 스키마는 바꾸지 않는다.
- 적용 전 [기존 진입점](../../src/summary/db/rollup-queries.ts), [조회 호출부](../../src/summary/db/reader.ts), [롤업 저장 호출부](../../src/summary/db/rollups.ts)를 확인했다.

## 문제와 변경 전후

기존 `rollup-queries.ts`는 날짜 경계 계산, 일별 소스 결합, 지표 병합, 조회 차원·정렬, 행·개수 조회를 한 파일에 섞었다. 긴 삼항식과 한 줄 SQL 때문에 `SELECT` 열과 바인딩 순서를 함께 추적해야 했다.

변경 전에는 `rollup-queries.ts`가 위 책임을 모두 맡는다. 변경 후 책임은 다음과 같다.

| 파일 | 책임 | 적용 상태 |
| --- | --- | --- |
| [rollup-queries.ts](../../src/summary/db/rollup-queries.ts) | 기존 공개 함수·타입의 재노출 | 적용 |
| [queries/rollup/usage.ts](../../src/summary/db/queries/rollup/usage.ts#L37) | 입력 검증, 차원·정렬, 최종 행·개수 SQL 조립 | 적용 |
| [queries/rollup/source.ts](../../src/summary/db/queries/rollup/source.ts#L21) | 완전한 현지 일과 원본 경계 결합, 원본의 일별 집계 | 적용 |
| [queries/rollup/metrics.ts](../../src/summary/db/queries/rollup/metrics.ts#L9) | 합계·완료 표본 평균·미상 캐시·소요 시간 품질 지표 병합 | 적용 |

기존 `aggregateUsageSource`와 `buildRollupUsageQueries`는 `rollup-queries.ts`에서 재노출해 [조회 호출부](../../src/summary/db/reader.ts)와 [저장 호출부](../../src/summary/db/rollups.ts)의 공개 경로를 보존한다. 내부 구현은 공통 필터·타입·정렬과 원본 소스를 직접 참조하고 공개 재노출 파일로 되돌아가지 않는다. 각 파일의 위치는 [폴더 안내](../../src/summary/db/queries/rollup/README.md)에도 기록했다.

## 내부 정리

- SQL 절과 출력 열 목록·서브쿼리·`CASE`를 줄별로 펼쳤다.
- 일별 소스의 기간 경계·미상 시각 정책을 의미 있는 변수와 함수로 분리했다.
- 지표식은 합계, 평균, 캐시의 미상 처리, 소요 시간 품질 구역으로 나눴다.
- 최종 조회에서 검증 → 소스 → 차원 → 행·개수 SQL 흐름을 드러내고, 표 정렬 여부에 따른 `ORDER BY`·페이지 절의 중복을 제거했다.
- `#region` 구역을 적용해 VS Code에서 역할별로 접어 볼 수 있게 했다.

## 검증 계획과 결과

- [롤업 통합 테스트](../../tests/node/summary-rollup.test.ts), [정렬·페이지 테스트](../../tests/node/usage-chart.test.ts), [독립 기대 값 테스트](../../tests/node/sql-rollup-oracle.test.ts)를 확인했다.
- 자체 리뷰에서 일별 소스의 열·바인딩 순서, 미상 시각·모델 키, 합계·평균 분모, 오류와 원본 대체 조건을 대조했다.
- 담당 3개 소스의 ESLint와 `git diff --check`를 통과했다. 최종 통합본은 원본 대비 72,034개 경우의 SQL·바인딩·모드·예외·집계 상태·스키마 대조와 `npm run check`의 타입 검사·린트·365개 테스트를 통과했다. [통합 검증 기록](QueryReadability-2026-10-29.md)에 결과를 둔다.
- 추가 알고리즘·아키텍처 변경 제안은 없다.
