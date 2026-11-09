# 평균·합계 SQL과 rollup 저장 비용 개선 조사

2026-11-09, Asia/Seoul. 현재 제품 코드를 읽고 공식 문서·원 논문을 조사했다. 아래 개선안은 설계 제안이며, 이 조사에서는 제품 SQL·스키마를 변경하거나 자동 테스트·벤치마크·재현 스크립트를 실행하지 않았다. 새 성능 측정값은 없다.

## 1. 현재 구조에서 확인한 것

이 프로젝트는 [connection.ts](../../../src/summary/db/connection.ts)의 `node:sqlite.DatabaseSync`를 사용한다. 별도 DB 서버에 네트워크 batch를 보내는 구조가 아니다. [Node.js SQLite API](https://nodejs.org/api/sqlite.html)는 동기 연결·준비된 statement 실행을 제공한다. 실제 설치 Node·내장 SQLite 버전은 이번 조사에서 조회하지 않았다.

| 경로 | 현재 동작 | 비용을 볼 곳 |
| --- | --- | --- |
| [MemoryStore.replace/apply](../../../src/summary/db/memoryStore.ts) | 최종 snapshot을 `BEGIN IMMEDIATE` 한 트랜잭션에서 비교·저장 | 잠금 대기, 기존 행 조회, DTO 값 변환·비교, 변경 행 쓰기, COMMIT |
| 같은 파일의 `saveSummary` | 기존 facts·모델·Skill·비용을 읽고 같으면 쓰기를 생략 | 요청마다 여러 statement 호출과 JS 배열·JSON 비교 |
| 같은 파일의 `finishSessions` | 실제 변경된 세션마다 rollup 갱신 | 큰 세션의 전체 요청 재집계 |
| [UsageRollupStore.refresh](../../../src/summary/db/rollups.ts) | 대상 세션의 요청·모델 일별 집계를 각각 DELETE 후 `INSERT ... SELECT ... GROUP BY` | 두 집계의 삭제와 재생성, 날짜 변환 UDF, 모델 연결 |
| [rollup/source.ts](../../../src/summary/db/queries/rollup/source.ts) | 완전한 현지 날짜는 rollup, 부분 날짜 경계는 원본으로 집계해 `UNION ALL` | 시간대·부분 경계 처리, 원본 경계 입력 수 |
| [rollup/usage.ts](../../../src/summary/db/queries/rollup/usage.ts) | 페이지 행과 전체 그룹 개수 SQL을 각각 실행 | 두 조회가 같은 소스를 처리하는 비용 |

현재의 일괄 저장은 **여러 변경을 하나의 트랜잭션에 묶고 캐시한 준비 statement를 반복 실행**하는 방식이다. 모든 사실 행을 한 번의 거대한 다중 VALUES INSERT로 넣는 방식은 아니다. 또한 DTO를 SQL 임시 표에 전부 다시 올리는 staging 경로도 아니다.

코드상 가장 먼저 확인할 후보는 **요청 한 건 변경 → 그 세션 전체의 요청·모델 rollup 재생성**이다. 세션 요청 수를 N, 변경 요청 수를 Δ라 하면 지금 갱신의 집계 입력은 Δ 대신 대략 N에 비례할 수 있다. 이는 코드로 확인한 입력 범위이며, 이번 실행의 병목이나 실제 시간으로 확정한 것은 아니다.

## 2. 평균은 SUM과 표본 수를 보존하는 방식이 맞다

SQLite `AVG(x)`는 NULL을 제외한 값의 평균이며 내부적으로 `total(x) / count(x)`를 사용한다. `COUNT(*)`와 `COUNT(x)`는 NULL에서 다르다. 그룹 평균을 다시 단순 평균하면 표본 수가 다른 그룹에서 결과가 틀린다. [SQLite Aggregate Functions](https://www.sqlite.org/lang_aggfunc.html)

```sql
-- 일별 sum/count를 기간 전체의 가중평균으로 병합하는 개념 예시
SELECT SUM(token_sum) AS tokens,
       1.0 * SUM(completed_token_sum)
         / NULLIF(SUM(completed_count), 0) AS avg_completed_tokens
FROM daily_usage;
```

예를 들어 첫날 한 건이 100토큰, 둘째 날 아홉 건이 각각 10토큰이면 전체 평균은 `(100 + 90) / (1 + 9) = 19`다. 일별 평균의 단순 평균인 55를 쓰면 안 된다. [Data Cube 원 논문](https://arxiv.org/abs/cs/0701155)은 평균처럼 중간 상태로 병합하는 집계의 이론적 배경이다. [Apache Hive의 Materialized Views](https://hive.apache.org/docs/latest/language/materialized-views/#materialized-view-maintenance)도 AVG의 증분 유지에 같은 컬럼의 SUM과 COUNT를 요구하는 구현 사례다. Hive 문법·클러스터링을 SQLite에 그대로 적용한다는 뜻은 아니다.

현재 [rollup-state.ts](../../../src/summary/db/rollup-state.ts)와 [rollup/metrics.ts](../../../src/summary/db/queries/rollup/metrics.ts)는 이미 이 원칙을 따른다. 복잡성을 줄여도 다음 의미는 보존해야 한다.

- 전체 토큰·요청 합계는 완료·진행·실패 전체를 포함한다. 평균은 완료 요청만 사용한다.
- `excludeEmptyUsage`는 평균의 표본군을 바꾼다. 0토큰이어도 모델이 기록됐으면 기록 표본에 포함된다.
- 캐시는 표본에 NULL이 하나라도 있으면 해당 합계·평균을 NULL로 돌려주는 정책이다. 알려진 값만 평균내는 것으로 바꾸면 결과가 달라진다.
- duration 평균은 선택된 완료 표본 가운데 duration이 알려진 건수로 나눈다. 토큰 평균 분모를 그대로 쓰면 안 된다.
- 모델별 행을 합산한 요청 수는 제공자별 고유 요청 수와 다를 수 있다. 모델 여러 개에 기여한 한 요청을 중복 제거하려면 별도 식별자 상태가 필요하다.

## 3. 41개 상태를 줄일 수 있는 범위

현재 상태 수는 정적으로 계산하면 **41개**다. 키와 모델 열은 별도다.

| 상태 묶음 | 열 수 | 보존 이유 |
| --- | ---: | --- |
| 전체 토큰 3, 건수 4, 캐시 합·known count 4 | 11 | 총량과 미상 캐시 정책 |
| 완료 전체 `c_*` | 13 | 평균 분자·known count·duration 품질 |
| 기록된 완료 `r_*` | 13 | 빈 사용량 제외 옵션 |
| 시각 미상·오래된 행·최종 갱신·최소 시각 | 4 | 진단과 세션 시작 시각 |

**우선 제안:** 평균 저장 방식은 유지하고, 갱신 범위를 먼저 줄인다. 열 수만으로 런타임 병목을 단정하지 않는다.

**열 슬림화 후보:** 전체·c·r의 `total_tokens` 합계는 각각 input+output 합계로 복원할 수 있어 3개 상태를 줄일 여지가 있다. c/r의 `duration_missing`도 각각 표본 수에서 `duration_ms_known`을 빼 복원하면 2개를 더 줄일 여지가 있다. 합계 중복을 없애는 제안은 [schema.ts](../../../src/summary/db/schema.ts)의 `total_tokens = input_tokens + output_tokens`와 현재 집계 조건에서 도출한 것이다. 실제 적용 전 정수 overflow, 기존 DB 내용, 모델 projection, 빈 그룹, raw 경계와의 열 순서·타입을 검토해야 한다.

더 공격적으로 c/r 토큰 합계를 공유하는 안도 가능하다. 현재 비음수 토큰과 기록 판정에서는 r에서 제외한 완료 요청의 input·output이 0이어서 두 표본의 토큰 분자가 같다. 그러나 이를 적용하려면 제공자·모델 소스 양쪽의 불변조건을 함께 문서화해야 한다. 캐시의 NULL 표본 수와 duration은 그대로 별도로 보존한다. 위 후보의 절감 시간·페이지 수는 미측정이다.

41개 상태를 단지 `sum,count` 두 열로 줄이면 현재 API의 캐시·품질·진단 결과를 표현할 수 없다. 상태를 지표별 세로 행으로 바꾸면 키 반복과 행 수가 늘 수 있으므로 공간 절감으로 단정하지 않는다. 스키마를 바꿀 때는 `ROLLUP_FORMAT_VERSION`, DDL·마이그레이션, `ROLLUP_STATES` 소비처, raw 경계 결합을 함께 변경해야 한다.

## 4. 갱신 알고리즘은 세션 전체에서 변경 버킷으로 좁히는 안을 우선한다

아래는 현재 코드를 근거로 한 설계 제안이다. 제품에는 아직 반영하지 않았다.

1. facts 변경 전·후의 `(provider,session,project,local_day[,model_key])`를 수집한다. 날짜·프로젝트·모델이 바뀌거나 삭제되면 이전 키도 포함한다.
2. 같은 키는 Set으로 한 번만 남긴다. 요청 집계와 모델 집계의 영향 키를 구분한다.
3. 변경 버킷만 삭제·재집계한다. 해당 현지 일의 UTC 반개구간을 구해 facts의 `started_at_ms` 조건으로 좁힌다. 시각 미상은 별도 NULL 분기로 처리한다.
4. 사실 행과 rollup을 기존과 같은 쓰기 트랜잭션에서 확정한다. 시간대가 바뀌면 전체 rebuild를 유지한다.

현재의 N이 세션 전체 크기라면 이 안은 영향 날짜·프로젝트의 사실 행 K까지 재집계 범위를 줄인다. K가 작을 때 이득을 기대할 수 있지만 한 세션의 모든 요청이 같은 버킷이면 차이가 작다. 논리적으로 범위만 줄여 놓고 SQL이 여전히 세션 전체를 스캔하면 실제 I/O는 줄지 않을 수 있으므로 인덱스 접근도 함께 확인해야 한다.

그다음 후보가 **행 기여분 차분 유지**다. 이전 기여분을 빼고 새 기여분을 더하면 SUM·COUNT는 Δ에 맞춰 갱신할 수 있다. 하지만 MIN/MAX에서 기존 극값이 삭제되면 해당 버킷을 재조회해야 하고, 고유 개수에는 중복별 참조 수가 필요하다. 부동소수 duration의 반복 덧셈·뺄셈 오차도 별도 고려 대상이다. [PostgreSQL 개발 wiki의 IVM 이론·집계 절](https://wiki.postgresql.org/wiki/Incremental_View_Maintenance)은 이 차이의 설계 레퍼런스이며, 해당 기능이 SQLite나 PostgreSQL core에 내장됐다고 가정하지 않는다.

## 5. 인덱스와 클러스터링: 현재 적용과 추가 후보

### 현재 적용된 접근 경로

| 표 | 키·인덱스 | 맞는 작업 |
| --- | --- | --- |
| `turn_summary` | `id INTEGER PRIMARY KEY` | 요청 ID와 모델·Skill·비용 FK 연결 |
| 같은 표 | UNIQUE `(provider,session_id,root_turn_id)` | 요청 비교와 세션 범위 조회 |
| 같은 표 | `(started_at_ms,provider)` | 제공자 전체의 시간 범위 |
| 같은 표 | `(provider,project_key,started_at_ms)` | 특정 제공자·프로젝트의 시간 범위 |
| 요청·모델 daily | PK `(provider,session_id,project_key,local_day[,model_key]) WITHOUT ROWID` | 세션 변경·삭제와 세션 집계 본체 접근 |
| 같은 두 표 | `(local_day,provider)`, `(provider,project_key,local_day)` | 전체 기간·프로젝트 기간 조회 |

SQLite의 `WITHOUT ROWID`는 복합 PK를 본체 B-tree 키로 사용하는 clustering 방식이다. 이미 두 daily 표에 적용돼 있다. 다른 DB의 `CLUSTER` 명령이나 clustered index DDL을 추가하는 문제가 아니다. 공식 문서는 복합 키에서 이점이 있을 수 있지만 큰 행에서는 rowid 표가 유리할 수 있다고 설명한다. 긴 세션·프로젝트 키와 많은 상태 열이 있으므로 실제 행 폭과 페이지 구성을 봐야 한다. [SQLite WITHOUT ROWID](https://www.sqlite.org/withoutrowid.html)

일반 복합 인덱스는 왼쪽부터 제약을 활용하므로 **동등 조건 → 범위 조건**을 출발점으로 한다. `(provider,session_id,project_key,local_day)`에서 project 조건이 없는데 local_day가 항상 범위 탐색에 쓰인다고 가정하면 안 된다. 현재의 시각 MIN/MAX는 단일 집계를 분리한 서브쿼리여서 날짜 인덱스의 극값 탐색을 노린 구조다. 이를 합쳐 무조건 빠르다고 판단하지 않는다. [SQLite Optimizer Overview](https://www.sqlite.org/optoverview.html)

### 추가 후보의 조건

| 후보 | 검토할 조건 | 비용·주의 |
| --- | --- | --- |
| facts `(provider,session_id,project_key,started_at_ms)` | 위의 변경 버킷 재집계를 도입하고 세션·프로젝트·시간을 모두 고정할 때 | 기존 세션 UNIQUE와 별개 쓰기·공간이 늘어남 |
| facts `(provider,started_at_ms)` | 제공자 하나의 raw 기간 조회가 많고 날짜 선두 경로가 과도하게 많은 행을 읽을 때 | 제공자 미지정 전체 기간에는 기존 날짜 선두가 유리할 수 있음 |
| 작은 전용 covering index | 한두 지표의 좁은 쿼리가 실제로 빈번할 때 | 모든 지표를 넣으면 원본 표에 가까운 복제본이 됨 |
| 완료 표본 partial index | 완료 평균만 독립 SQL로 조회할 때 | 현재 전체 합계와 평균을 함께 구하는 SQL에는 바로 적용되지 않음 |
| 모델 선두 인덱스 | 실제 model 필터로 먼저 대상을 좁히는 쿼리가 추가될 때 | 현재 전체 모델 GROUP BY만 보고 추가할 근거가 부족함 |

Covering index는 해당 쿼리에 필요한 조건·출력 열을 모두 담아 본체 재접근을 줄인다. 하지만 합계·평균은 선택한 표본이나 사전 집계 행을 여전히 읽는다. 인덱스가 총합을 한 번의 탐색으로 알려 주는 것은 아니다. 중복 prefix 인덱스도 각 제약·정렬·실제 사용을 확인한 뒤 정리한다. [SQLite Query Planning](https://www.sqlite.org/queryplanner.html)

완료 partial index를 만들더라도 완료 조건이 `AVG(CASE WHEN status='completed' THEN ... END)` 안에만 있으면 전체 쿼리의 WHERE가 그 조건을 보장하지 않는다. 따라서 전체 합계까지 포함한 현재 SQL의 모든 입력을 완료 행 인덱스만으로 대체할 수 없다. [SQLite Partial Indexes](https://www.sqlite.org/partialindex.html)

현지 일 UDF의 expression index도 시간대를 바인딩하는 현재 다중 시간대 동작에 바로 대입하기 어렵다. expression index는 일치하는 식과 deterministic 제약이 있다. 고정 시간대 식을 저장하려면 시간대 변경과 함수 구현 변경 시 재구축 전략까지 필요하다. [SQLite Indexes On Expressions](https://www.sqlite.org/expridx.html)

## 6. 시간과 공간을 해석하는 기준

- 저장 구간은 `BEGIN IMMEDIATE` 대기, manifest, 요청 값 비교·facts, 모델·Skill·비용, 삭제·재연결, provider/model rollup, 이름 정리, COMMIT을 구분한다. 기존 행과 같은 요청 수·실제 바뀐 요청 수·변경 세션 수·rollup 영향 행 수가 시간의 해석에 필요하다.
- SQL 구간의 벽시계 시간에는 statement 준비·바인딩·검증·JS 비교가 함께 포함될 수 있다. 그 시간을 순수 디스크 INSERT 시간으로 부르지 않는다. 중첩 구간의 합계를 전체 시간에 또 더하지 않는다.
- `EXPLAIN QUERY PLAN`의 SEARCH·SCAN·COVERING·임시 B-tree는 접근 경로를 보여 준다. 출력 형식은 버전에 따라 달라질 수 있고, 실행 시간이나 실제 방문 행 수는 아니다. [SQLite EXPLAIN QUERY PLAN](https://www.sqlite.org/eqp.html)
- 저장 공간은 가능할 때 `dbstat`으로 표·인덱스별 B-tree 페이지를 구분한다. 이 표에는 freelist 등의 모든 DB 페이지가 포함되지 않고 SQLite 빌드 옵션에 따라 모듈이 없을 수 있다. WAL 파일 길이를 총 쓰기 바이트로 해석하지 않는다. [SQLite DBSTAT](https://www.sqlite.org/dbstat.html)
- 현재 연결은 열기에서 `main.optimize=0x10002`, 스캔 뒤 하루 간격·닫기에서 `main.optimize`를 호출한다. 이미 공식 장기 연결 권고에 맞는 방향이다. 매 스캔의 전체 ANALYZE로 바꿀 이유는 이번 조사에서 확인되지 않았다. [SQLite ANALYZE 권고](https://www.sqlite.org/lang_analyze.html)

기존 [세션 rollup rowid 비교](../../benchmarks/2026-10-27/SqlRowid-2026-10-27.md)와 [최초·추가 적재 시제품 비교](../../benchmarks/2026-10-27/SqlRowidAppend-2026-10-27.md)는 서로 다른 당시 실행물의 기록이다. 현재 제품의 성능 수치나 이번 조사에서 실행한 결과로 재사용하지 않는다. 이전 [복합 인덱스 조사](../2026-10-29/SQLiteIndexOrder-2026-10-29.md)도 참고하되 현재 메모리 snapshot 저장 경로는 이 문서의 코드 연결을 기준으로 한다.

## 7. 권고 순서와 미검증 사항

1. 실제 저장 구간과 데이터 규모를 계측하여 rollup 재생성·기존 값 비교·COMMIT 중 큰 구간을 확인한다.
2. 큰 세션의 재집계가 지배적이면 변경 버킷 재집계를 먼저 설계한다. 필요할 때만 그 WHERE를 지원하는 인덱스를 추가한다.
3. 동일 의미로 복원할 수 있는 상태 열부터 줄인다. 평균의 SUM·COUNT와 NULL·표본 정책은 유지한다.
4. 그 뒤에도 갱신이 크면 행 기여분 차분 유지와 extrema의 부분 재계산을 비교한다.
5. clustering 순서 변경·rowid 전환·넓은 covering index는 읽기와 저장 양쪽의 근거가 생긴 뒤 선택한다.

컴파일·런타임 측정·실행계획 재조회·DB 페이지 조회·결과 대조는 이 조사에서 수행하지 않았다. 개선율과 절대 시간은 미측정이다. 제품 동작 변경이 없는 조사 문서이므로 별도 기능 의사결정 일지는 추가하지 않았다.
