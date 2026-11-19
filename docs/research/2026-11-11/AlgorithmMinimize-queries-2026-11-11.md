# 현재 기능을 보존한 조회 알고리즘 최소화

2026-11-11, Asia/Seoul. 사용자가 쿼리·알고리즘의 동작 보존 최소화를 명시적으로 요청한 범위에서 적용한다.

## 현재 흐름과 적용 계획

- [통계 원본 집계](../../../src/summary/db/queries/raw/usage.ts#L141)와 [rollup 집계](../../../src/summary/db/queries/rollup/usage.ts#L37)는 페이지와 개수를 별도 GROUP BY로 계산했다. 페이지가 반환될 때 같은 그룹 집계의 window count를 사용하고, 범위를 벗어난 빈 후속 페이지에만 기존 개수 SQL을 실행한다. 빈 첫 페이지는 전체 개수 0이 확정되므로 별도 조회가 없다.
- [이름 목록](../../../src/summary/db/queries/raw/names.ts)도 같은 방식을 적용한다. 날짜 독립 범위·이름 정렬·전체 개수는 유지한다.
- [도구 순위](../../../src/summary/db/queries/raw/capabilities.ts)는 횟수 집계를 반복해 전체 개수·합계·최댓값을 계산한다. 순위 집계에 window 지표를 함께 계산하고 빈 페이지의 기존 집계만 보존한다. 분류별 API·페이지·비율 분모는 유지한다.
- [진단](../../../src/summary/db/queries/raw/diagnostics.ts)은 counts 전용 생성기를 분리하고 [reader](../../../src/summary/db/reader.ts)에 counts 전용 조회를 제공한다. 목록을 소비하지 않는 coverage 호출에서 파일·요약 목록 SQL을 없앨 수 있다. Worker 연결은 메인 에이전트 담당이다.

스키마·인덱스·필터·평균/NULL·비용·미상 시간·정렬·공개 결과 필드는 보존한다. window 메타데이터는 reader에서 제거한다. 요청 상세 행의 별도 개수는 범위가 다를 수 있는 cursor 계약을 유지한다.

## 검증과 한계

코드·참조·diff 검토와 타입 검사로 확인한다. 사용자 지시에 따라 테스트 코드 및 임시 검증 스크립트를 만들거나 자동 테스트·벤치마크를 실행하지 않는다. 실행 시간 개선은 측정하지 않으므로 SQL 횟수·중복 GROUP BY 제거와 구분한다.

## 적용 결과

| 경로 | 기존 데이터 SQL | 적용 후 데이터 SQL |
| --- | ---: | ---: |
| 그룹 통계·이름 페이지, 결과 있음 | 2회·GROUP BY 2회 | 1회·GROUP BY 1회 |
| 그룹 통계·이름의 빈 첫 페이지 | 2회 | 1회 |
| 범위를 벗어난 빈 후속 페이지 | 2회 | 2회·기존 count fallback |
| 도구 분류 4개, 각 페이지 결과 있음 또는 빈 첫 페이지 | 8회 | 4회 |
| coverage의 진단 목록·개수 | 3회 | counts API 사용 시 1회 |

SQL 수는 코드 경로에서 확인한 SELECT 호출 횟수다. rollup 준비·트랜잭션 SQL은 포함하지 않고 시간 개선율을 뜻하지 않는다. SQLite는 window 결과를 보관할 수 있으므로 메모리·실행시간 손익은 미측정이다.

- [countedPage](../../../src/summary/db/reader.ts#L57)가 페이지의 내부 `_total`을 읽고 제거한다. [도구 페이지](../../../src/summary/db/reader.ts#L91)는 내부 전체 개수·횟수·최댓값을 제거하면서 기존 percentage를 계산한다. 공개 행에는 내부 메타데이터가 남지 않는다.
- [요청 상세 페이지](../../../src/summary/db/reader.ts#L120)는 cursor 이후 행과 전체 필터 개수의 범위가 다를 수 있으므로 기존 두 SELECT와 snapshot 경계를 유지한다. 무조건 모든 페이지를 window count로 바꾸지 않았다.
- [rollup 정렬](../../../src/summary/db/queries/rollup/usage.ts#L74)은 원본 조회와 동일한 공통 unknown 정렬 생성기를 재사용해 중복 구현을 삭제했다. 시간·모델 미상 순서식은 동일하다.
- 도구 집계 source의 `t.*`를 현재 필터가 읽는 제공자·프로젝트·세션·시각으로 좁혔다. SQLite의 기존 projection 제거 여부를 측정하지 않아 읽기 비용 감소라고 주장하지 않는다.
- [진단 count 생성기](../../../src/summary/db/queries/raw/diagnostics.ts#L39)와 [reader API](../../../src/summary/db/reader.ts#L134)는 기존 count SQL과 바인딩을 그대로 공유한다. Worker와 DB 공개 진입점 연결은 메인 에이전트가 맡는다.

`npm run typecheck`와 `git diff --check`를 통과했다. 기존 호출부·테스트 소스를 읽어 빈 페이지 전체 개수, 이름 선택 범위, capability 비율 분모, 모델·제공자 및 비용·원본/rollup 분기를 검토했다. 자동 테스트·실제 DB 조회·벤치마크는 실행하지 않았다.

스키마·인덱스·새 영속 캐시·세션 metadata 추가는 필요하지 않아 적용하지 않았다. 비용 rollup 확대·관계 요약 테이블·dirty mask 등 기존 설계안의 확장도 이번 조회 중복 제거에 필요하지 않다.

## 후속 실측

성능·정합성 측정 요청에 따라 [A/B 보고서](../../benchmarks/2026-11-11/AlgorithmMinimizeAB-2026-11-11.md)와 [DB 검증](../../benchmarks/2026-11-11/AlgorithmMinimizeDbValidation-2026-11-11.json)을 추가했다. 페이지 10,386·정렬 792대조를 통과했고 실제 SQL 수는 이름 2→1·도구 8→4·coverage 3→1이다. 10,000건의 비용 포함 일별 표·도구 조회는 31.50%·49.47% 단축됐지만 제공자 세션 평균은 세 규모 모두 5.33–8.24% 느렸다. SQL 횟수 감소를 모든 조회의 개선으로 일반화하지 않는다.
