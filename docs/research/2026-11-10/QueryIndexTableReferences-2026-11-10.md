# 쿼리·인덱스·테이블 개선의 외부 프로젝트 레퍼런스

조사일: **2026-11-10, Asia/Seoul**. 현재 Agent Tracker의 SQLite 코드와 다른 프로젝트의 공식 문서·공개 소스를 대조했다. 제품 코드·DB는 변경하지 않았고 테스트·벤치마크는 실행하지 않았다. 아래 추가 후보의 효과는 아직 측정하지 않았다.

핵심은 **읽을 행, 다시 계산할 행, 반복 SQL 호출, 행 하나의 크기를 각각 줄이는 것**이다. 인덱스 추가, 쿼리 변경, 테이블 변경은 이 작업량을 줄이는 서로 다른 수단이다.

## 1. 어떤 프로젝트를 참고할 수 있는가

| 프로젝트·일차 자료 | 실제 사용하는 방식 | 개선 개념 | Agent Tracker와의 연결 |
| --- | --- | --- | --- |
| [Home Assistant 통계](https://contributors.home-assistant.io/data/reference/statistics/) | 원본 상태 → 5분 통계 → 시간별 통계 | 사전 집계·계층 집계 | 요청 원본 → 일별 rollup → 월·프로젝트·세션별 재집계 |
| [Home Assistant 스키마](https://github.com/home-assistant/core/blob/8228b18d24d07ebaff07dd61f5c56a1ddd6e59f7/homeassistant/components/recorder/db_schema.py#L696) | 통계의 고유 복합 인덱스 `(metadata_id, start_ts)` | 대상의 동등 조건 다음 시간 범위 탐색 | `(provider, project_key, started_at_ms)`와 같은 접근 패턴 |
| [Home Assistant 속성 공유](https://contributors.home-assistant.io/data/guides/query-the-database/#attributes) | 같은 속성은 별도 테이블에 저장하고 ID로 참조 | 정규화·중복 저장 감소 | `projects`, `sessions`로 이름을 분리한 현재 구조 |
| [TimescaleDB 계층 집계](https://www.tigerdata.com/docs/learn/continuous-aggregates/hierarchical-continuous-aggregates)·[실시간 집계](https://www.tigerdata.com/docs/learn/continuous-aggregates/real-time-aggregates) | 하위 집계를 재사용하고 미집계 원본을 결합 | 계산 결과 재사용·집계와 원본의 혼합 조회 | 완전한 일은 rollup, 양끝의 부분 날짜는 raw로 조회 |
| [pg_ivm 집계 유지](https://github.com/sraoss/pg_ivm/blob/678c37861080aa221b859cefaca98725646dbf7c/README.md#aggregates) | 합계·개수 등 보조 상태로 집계값을 증분 갱신 | Incremental View Maintenance, IVM | 현재의 변경 세션 재집계보다 작은 변경 단위 후보 |
| [GitLab OFFSET 최적화](https://docs.gitlab.com/development/database/offset_pagination_optimization/) | 정렬 키로 페이지를 고른 뒤 전체 행을 조회 | 늦은 행 조회, late materialization | 요청 상세 목록에서 이름·비용·상세 열을 붙이는 시점 검토 |
| [GitLab keyset pagination](https://docs.gitlab.com/development/database/keyset_pagination/)·[정렬 인덱스](https://docs.gitlab.com/development/database/pagination_performance_guidelines/) | 마지막 정렬 값과 고유 ID를 커서로 사용 | 인덱스 seek·안정적인 정렬 | 기본 ID 커서는 이미 존재, 사용자 정렬은 OFFSET 사용 |
| [GitLab 배치 처리](https://docs.gitlab.com/development/database/batching_best_practices/) | 대상 범위를 나누어 집합 단위 갱신 | 반복 호출 축소·처리 범위 제한 | 이름 키 중복 제거·변경 세션 일괄 rollup |

GitHub 소스 두 개는 조사 중 읽은 내용과 같은 commit으로 고정했다. PostgreSQL 기반 TimescaleDB·pg_ivm·GitLab의 문법과 실행 계획을 SQLite에 그대로 옮기는 것은 별도 문제다. 위 대응은 확인한 구조를 바탕으로 한 이 저장소에 대한 해석이다.

## 2. 쿼리 개선: 필요한 대상을 먼저 고른다

### 2.1 필터를 인덱스로 찾을 수 있게 표현한다

특정 프로젝트의 기간 조회는 다음 형태다. 이름 문자열 검색과 비용 계산 등은 생략한 설명용 SQL이다.

```sql
SELECT SUM(total_tokens)
FROM turn_summary
WHERE provider = ?
  AND project_key = ?
  AND started_at_ms >= ?
  AND started_at_ms < ?;
```

현재 `idx_summary_project_period(provider, project_key, started_at_ms)`는 제공자·프로젝트를 먼저 고르고 그 안에서 시간 범위를 찾게 하는 구조다. 날짜 열을 행마다 함수로 변환해 비교하기보다, 조회 기간을 미리 UTC 밀리초 경계로 바꾸어 비교하는 방식이다. 이런 조건을 흔히 **sargable predicate**라고 부른다. [현재 필터](../../../src/summary/db/queries/common/filters.ts), [현재 인덱스](../../../src/summary/db/schema.ts), [SQLite 조건 분석](https://www.sqlite.org/optoverview.html#where_clause_analysis).

다만 SQL을 서브쿼리 안쪽으로 옮겼다는 사실만으로 실행이 빨라지지는 않는다. SQLite가 이미 조건을 밀어 넣거나 서브쿼리를 평탄화할 수 있으므로 실제 방문 행과 정렬 경로가 바뀌는지가 판단 기준이다.

### 2.2 GitLab처럼 페이지를 먼저 고르고 상세 행을 늦게 읽는다

GitLab은 OFFSET 조회에서 정렬 키만 먼저 읽고 페이지에 남은 행의 전체 내용을 나중에 가져오는 최적화를 구현한다. 인덱스 항목은 여전히 `OFFSET + LIMIT`만큼 읽지만, 본문 행 조회를 페이지 크기에 가깝게 줄이는 방식이다. [공식 원리·구현 예시](https://docs.gitlab.com/development/database/offset_pagination_optimization/#how-does-the-optimization-work).

Agent Tracker의 [요청 목록 SQL](../../../src/summary/db/queries/raw/turns.ts)은 [이름·모델·선택적 비용을 결합한 소스](../../../src/summary/db/queries/raw/source.ts)에 정렬·LIMIT·OFFSET을 적용한다. 여기서 **페이지의 요청 ID를 먼저 확정한 뒤 표시용 상세 정보를 붙이는 것**은 검토할 수 있는 후보다. 현재 실행 계획이 이미 늦은 조회를 수행하는지는 이번에 확인하지 않았다.

적용 조건은 다음과 같다.

- 페이지를 고르는 단계에 모든 필터와 정렬 기준이 반영되어야 한다. 비용·이름·모델 값으로 정렬하는데 해당 JOIN을 무조건 뒤로 미루면 결과가 달라진다.
- 모델 기준은 요청 한 개가 여러 행이 될 수 있어 `id`만으로 페이지를 고르면 안 된다. 최종 행의 식별·정렬 키를 함께 보존해야 한다.
- OFFSET의 건너뛰기 비용과 전체 개수 계산 비용은 이 방식만으로 없어지지 않는다.
- GitLab의 `LATERAL` 구현을 복사하지 않고 SQLite가 지원하는 서브쿼리·CTE·JOIN과 실행 계획에 맞춰야 한다.

### 2.3 뒤 페이지가 느리면 keyset을 비교한다

기본 ID순이라면 `id > 마지막ID ORDER BY id LIMIT 페이지크기`로 이어 읽을 수 있다. 현재 [reader](../../../src/summary/db/reader.ts)의 `afterId` 경로가 이미 이 방식이다. 사용자 정렬·미상 우선순위가 있으면 현재는 OFFSET을 사용한다.

시간순 커서로 확장하려면 마지막 시각뿐 아니라 동률을 구분하는 ID와 NULL 배치까지 커서에 포함해야 한다. GitLab도 고유한 보조 정렬 키와 이에 맞는 인덱스를 사용한다. [GitLab keyset](https://docs.gitlab.com/development/database/keyset_pagination/), [안정적 정렬](https://docs.gitlab.com/development/database/pagination_performance_guidelines/#tie-breaker-column).

이 방식은 다음 페이지 조회에 유리하다. 임의의 페이지 번호로 바로 이동하는 UX나 집계값으로 정렬하는 화면에는 추가 설계가 필요하다. 집계 결과에 커서를 붙여도 원본 GROUP BY 비용 자체가 없어지는 것은 아니다.

## 3. 인덱싱 개선: 검색과 정렬의 순서에 저장 순서를 맞춘다

Home Assistant는 통계에 `(metadata_id, start_ts)` 고유 인덱스를 둔다. 한 센서를 고정하고 시간 구간을 읽는 구조다. [실제 인덱스 선언](https://github.com/home-assistant/core/blob/8228b18d24d07ebaff07dd61f5c56a1ddd6e59f7/homeassistant/components/recorder/db_schema.py#L696).

Agent Tracker는 조회와 갱신이 서로 다른 순서를 요구한다.

| 현재 키·인덱스 | 주된 역할 |
| --- | --- |
| `turn_summary(started_at_ms, provider)` | 전체 제공자의 기간 조회 |
| `turn_summary(provider, project_key, started_at_ms)` | 특정 제공자·프로젝트의 기간 조회 |
| 요청 UNIQUE `(provider, session_id, root_turn_id)` | 요청 중복 방지·세션 범위 탐색 |
| daily PK `(provider, session_id, project_key, local_day[, model_key])` | 변경 세션의 이전 집계 삭제·교체 |
| daily `(local_day, provider)` | 일별 기간 조회 |
| daily `(provider, project_key, local_day)` | 제공자·프로젝트 안의 날짜 조회 |

복합 인덱스는 여러 열의 조건을 독립적으로 빠르게 만드는 장치가 아니다. 기본적으로 왼쪽의 동등 조건과 이어지는 범위 조건에 맞춰 탐색 범위를 좁힌다. 시간 범위 뒤의 제공자 열은 추가 필터에는 도움을 줄 수 있어도 그 자체로 탐색 구간이 같은 정도로 줄어드는 것은 아니다. [SQLite optimizer](https://www.sqlite.org/optoverview.html#where_clause_analysis).

**Covering index**는 조회에 필요한 열을 인덱스에서 모두 얻어 본체 행의 재조회를 줄인다. 하지만 수십 개 집계 지표까지 넣으면 인덱스와 매 쓰기의 유지 비용이 커진다. 현재 일별 보조 인덱스가 모든 지표의 SUM까지 covering한다는 뜻은 아니다. [SQLite covering index](https://www.sqlite.org/queryplanner.html#covering_indexes).

이 저장소의 [기존 세션 시간 인덱스 비교](../../benchmarks/2026-11-03/SessionTimeIndexAB-summary.md)는 `(provider, session_id, started_at_ms)` 추가만으로 일관된 갱신 개선을 확인하지 못했다. 따라서 같은 인덱스를 새 개선책처럼 다시 제안하지 않는다.

## 4. 테이블 개선: 원본과 반복 조회에 필요한 요약을 나눈다

### 4.1 Home Assistant·TimescaleDB의 사전 집계

Home Assistant는 원본을 5분 단위로 요약하고 그 결과로 시간별 통계를 만든다. TimescaleDB도 하위 시간 집계 위에 상위 집계를 쌓을 수 있다. 공통 원리는 매 조회마다 원본 전체를 계산하지 않고 **이미 계산한 작은 상태를 재사용**하는 것이다. [Home Assistant 통계](https://contributors.home-assistant.io/data/reference/statistics/), [TimescaleDB 계층 집계](https://www.tigerdata.com/docs/learn/continuous-aggregates/hierarchical-continuous-aggregates).

현재 [rollup-state.ts](../../../src/summary/db/rollup-state.ts)의 `usage_request_daily`, `usage_model_daily`가 이 역할을 한다. 월별 조회는 일별 상태를 다시 합산한다. 세션별 일별 행 수가 실제 요청 수보다 충분히 작을수록 읽을 양이 줄어든다. 모든 세션에 요청이 하나뿐이면 축약 효과는 작다.

평균은 평균값 하나만 저장하면 안 된다. 예를 들어 A일이 2건·100토큰, B일이 8건·800토큰이면 전체 평균은 `(100 + 800) / (2 + 8) = 90`이다. 일별 평균의 단순 평균 `(50 + 100) / 2 = 75`는 틀린다. 현재 코드는 합계와 표본 수를 저장하며 캐시·duration 미상 값의 알려진 표본 수도 따로 보존한다.

TimescaleDB의 실시간 집계는 기존 집계와 최근 미집계 원본을 함께 읽는다. Agent Tracker는 비슷한 혼합 원리를 **기간 양끝의 부분 날짜**에 적용한다. 완전한 현지 일은 rollup에서 읽고 부분 날짜만 원본에서 계산한 뒤 겹치지 않게 `UNION ALL`한다. 두 제품의 갱신 시점·일관성 방식까지 같다는 의미는 아니다. [TimescaleDB 실시간 집계](https://www.tigerdata.com/docs/learn/continuous-aggregates/real-time-aggregates), [현재 소스 결합](../../../src/summary/db/queries/rollup/source.ts).

### 4.2 중복 문자열과 사용하지 않는 열을 줄인다

Home Assistant는 반복되는 속성을 `state_attributes`에 한 번 저장해 참조하고, 통계의 설명은 `statistics_meta`에 둔다. Agent Tracker도 이름을 `projects`, `sessions`에 분리한다. 이처럼 자주 반복되는 큰 값을 분리하면 중복 저장과 갱신량을 줄일 수 있지만 표시할 때 JOIN 비용이 생긴다. [속성 공유](https://contributors.home-assistant.io/data/guides/query-the-database/#attributes), [현재 스키마](../../../src/summary/db/schema.ts).

사용하지 않는 열을 제거하는 것은 행 폭과 계산·직렬화 비용을 줄이는 별도 방법이다. 이 저장소에서는 이미 요청 daily 41→38개, 모델 daily 41→37개로 상태를 줄였다. 기존 1회 비교에서는 daily 본체 공간이 감소했지만 실행 시간 개선은 일관되지 않았다. **공간 감소를 그대로 속도 개선율로 바꾸어 말하지 않는다.** [기존 열 제거 결과](../../benchmarks/2026-11-10/RollupTrimAB-2026-11-10.md).

현재 daily는 `WITHOUT ROWID`라 복합 PK가 본체의 저장 키다. 세션별 교체와 잘 맞는 부분이 있지만, 긴 복합 키는 보조 인덱스도 크게 만들고 넓은 행은 불리할 수 있다. 따라서 모든 테이블을 같은 형식으로 바꾸는 규칙은 적절하지 않다. [SQLite 공식 적용 조건](https://www.sqlite.org/withoutrowid.html#when_to_use_without_rowid).

## 5. 갱신 알고리즘 개선: 재계산 단위를 줄이고 반복 호출을 묶는다

### 5.1 현재: 변경 세션 재집계와 SQL 배칭

현재 [MemoryStore.replaceBatch](../../../src/summary/db/memoryStore.ts)는 변경 세션 키를 중복 제거하고 [UsageRollupStore.refreshSessions](../../../src/summary/db/rollups.ts)로 넘긴다. 여러 세션이면 해당 세션들의 이전 daily를 지우고 최종 facts를 집합 단위로 재집계한다. 한 세션은 기존 직접 경로를 사용한다.

이것은 다음 두 개선이 합쳐진 형태다.

1. **증분 무효화:** 바뀌지 않은 세션은 다시 계산하지 않는다.
2. **집합 단위 처리:** 바뀐 세션마다 SQL 네 개를 반복하는 대신 묶음당 네 개로 처리한다. 같은 요청 행을 합산하는 계산 자체는 남는다.

GitLab의 batch 갱신도 범위를 제한하고 집합으로 처리하는 참고 사례다. SQLite는 원격 DB 왕복이 없어도 JS↔SQLite 호출, statement 실행 준비와 반복 인덱스 탐색 비용이 있으므로 호출 축소의 여지가 있다. [GitLab batching](https://docs.gitlab.com/development/database/batching_best_practices/).

기존 [rollup 배칭 보고서](../../benchmarks/2026-11-10/RollupBatchAB-2026-11-10.md)에서는 실제 SQL 호출이 1,488→100회, 해당 rollup 구간 중앙값이 70.517→26.265ms였다. 전체 refresh는 3,102.307→3,039.996ms로 약 2% 감소했다. **부분 구간의 약 63% 감소와 전체 성능 개선은 다르다.** 이번에 새로 측정한 값은 아니다.

이름·결제 설정도 이미 요청별 반복을 고유 프로젝트·세션별 처리로 바꿨다. N개 요청, P개 프로젝트, S개 세션이면 해당 SQL 호출을 O(N)에서 O(P+S)로 줄이는 방식이다. 모든 요청을 읽고 처리하는 전체 알고리즘이 O(P+S)가 되는 것은 아니다. [현재 이름 저장](../../../src/summary/db/memoryStore.ts), [기존 결과·단일 관측의 한계](../../benchmarks/2026-11-10/MetadataBatchAB-2026-11-10.md).

### 5.2 추가 후보: pg_ivm처럼 이전 기여분을 빼고 새 기여분을 더한다

pg_ivm은 PostgreSQL의 집계 결과를 유지하기 위해 합계·개수 등의 보조 상태를 보관한다. 평균도 합계와 개수를 통해 갱신한다. 그룹을 찾는 인덱스가 필요하고, 최솟값·최댓값을 만든 행이 삭제되면 해당 그룹을 다시 읽을 수 있다. [pg_ivm aggregates](https://github.com/sraoss/pg_ivm/blob/678c37861080aa221b859cefaca98725646dbf7c/README.md#aggregates).

Agent Tracker에 대응시키면 다음 차이다.

```text
현재: 요청 1건 변경 → 그 요청이 속한 세션의 daily를 다시 계산
후보: 요청 1건 변경 → 그 요청의 이전 집계 기여분 제거 + 새 기여분 추가
```

같은 그룹의 토큰이 100→130이면 합계에 30만 더하고 건수는 유지할 수 있다. 날짜·프로젝트·모델이 바뀌면 이전 그룹에서 100과 건수 1을 빼고 새 그룹에 130과 건수 1을 더해야 한다. 완료 상태가 바뀌면 완료 요청 평균의 분자·분모도 함께 바뀐다.

다만 캐시·duration NULL의 알려진 표본 수, 세션 최소 시각, 빈 그룹 삭제, 모델별 다중 행, 재시도 중복 방지와 facts·rollup의 동일 transaction을 모두 보존해야 한다. 큰 재구축에서는 delta 유지 비용이 재집계보다 커질 수도 있다. 이 후보는 **현재 구현되어 있지 않으며**, pg_ivm 자체를 SQLite에 설치한다는 제안도 아니다.

중간 단계로는 변경 세션 전체 대신 **영향받은 날짜·프로젝트·모델 그룹만 무효화해 재집계**하는 방법도 있다. 이전 그룹 키와 새 그룹 키를 모두 추적해야 하고, 세션 전체 최소 시각처럼 더 넓은 범위를 요구하는 지표는 별도로 다뤄야 한다.

## 6. 복잡도와 적용 판단

N은 전체 요청 수, K는 조회에 해당하는 요청 수, D는 필요한 daily 행 수, E는 변경 세션에 속한 요청 수, Δ는 실제 변경 요청 수, G는 영향받은 집계 그룹 수, L은 페이지 크기, O는 OFFSET이다. 다음은 단순화한 작업량 비교이며 모든 SQL 실행 계획의 보장은 아니다.

| 방식 | 줄이는 작업 | 남는 비용 |
| --- | --- | --- |
| 전체 원본 집계 | 기준: 대략 N행 방문 | GROUP BY·정렬·JOIN·행 읽기 |
| 범위 인덱스 | 탐색 후 K행만 대상 | 본체 재조회·합산·그룹화는 남음 |
| daily 사전 집계 | K개 원본 대신 D개 요약 읽기 | 집계 테이블 유지·필터·재그룹화 |
| 변경 세션 재집계 | 전체 N 대신 변경 세션 E를 처리 | 세션 내 미변경 요청도 다시 집계 |
| delta 유지 후보 | Δ개 변경과 G개 그룹 중심으로 갱신 | 키 탐색·인덱스 쓰기·MIN 등 예외 재계산 |
| keyset | 정렬 인덱스로 이어 읽을 수 있으면 O에 비례한 건너뛰기 감소 | 필터·JOIN·집계 비용은 별도 |
| 늦은 상세 행 조회 | 페이지 선정을 좁은 키로 수행 | OFFSET이면 키 O+L개 방문은 여전히 남음 |
| SQL 배칭·행 폭 감소 | 호출 수·행당 상수 비용 감소 | 전체 처리 행 수와 복잡도 차수는 그대로일 수 있음 |

좁은 covering 인덱스의 단순 범위 조회는 대략 O(log N + K)로 생각할 수 있다. 비커버링 본체 조회와 별도 정렬·JOIN이 붙으면 그 비용을 더해야 한다. 인덱스가 SUM을 자동으로 O(log N)에 계산해 주는 것은 아니다.

**현재 적용된 것:** 기간 범위 조건과 복합 인덱스, 이름 분리, 일별 집계, 부분 날짜 raw 결합, 기본 ID 커서, 변경 세션 집합 처리, 이름·설정의 키별 중복 제거, 미사용 rollup 열 제거.

**추가 검토 후보:** 요청 목록의 늦은 상세 행 조회, 실제 정렬에 맞춘 커서·좁은 인덱스, 영향 그룹 단위 재집계, 합계·개수의 delta 유지. 어느 후보부터 적용할지는 느린 구간이 조회인지 갱신인지와 실제 입력 분포에 따라 달라진다. 이번 조사만으로 추가 인덱스나 스키마 변경을 확정하지 않는다.

## 확인 범위

- 현재 코드·기존 보고서와 외부 일차 자료의 대응 관계를 검토했다. 외부 프로젝트의 성능 수치를 Agent Tracker의 예상 개선율로 사용하지 않았다.
- GitHub의 Home Assistant·pg_ivm 자료는 고정 commit 내용이 조사 시 읽은 브랜치 내용과 같은지 확인했다.
- 새 문서와 목차의 상대 링크가 모두 존재하고 새 문서에 줄 끝 공백이 없음을 확인했다. `git diff --check`도 통과했다. 제품 기능 변경이 없어 의사결정 일지에는 새 항목을 추가하지 않았다.
- 테스트·임시 재현 코드·벤치마크·DB 실행 계획 수집·컴파일은 수행하지 않았다. 문서만 변경했다.
