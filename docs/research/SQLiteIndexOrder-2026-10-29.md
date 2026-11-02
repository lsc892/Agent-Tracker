# SQLite 복합 인덱스의 날짜·세션 순서를 정하는 방법

조사: 2026-10-29, Asia/Seoul. SQLite 공식 자료와 Agent Tracker의 실제 SQL을 기준으로 정리했다. 대응하는 [통제 A/B 보고서](../benchmarks/2026-10-29/StorageAB-2026-10-29.md)와 함께 읽는다.

## 먼저 읽을 자료

| 공식 자료 | 읽을 부분 | 이 프로젝트에 필요한 이유 |
| --- | --- | --- |
| [Query Planning](https://www.sqlite.org/queryplanner.html#multi_column_indices) | 1.6 Multi-Column Indices, 1.7 Covering Indexes, 3 Searching And Sorting | 복합 키의 왼쪽부터 정렬되는 구조와 본체 재접근 비용을 그림으로 설명한다. |
| [Query Optimizer Overview](https://www.sqlite.org/optoverview.html#where_clause_analysis) | 2 WHERE Clause Analysis, 6 Skip-Scan, 10 ORDER BY | 동등 조건·범위 조건·중간 키 누락에 따라 사용할 수 있는 인덱스 구간이 달라지는 원리를 설명한다. |
| [Clustered Indexes and WITHOUT ROWID](https://www.sqlite.org/withoutrowid.html) | 3 Benefits, 4 When To Use | 이 확장의 복합 PK가 테이블 본체의 탐색·정렬 키라는 점과 큰 행에서의 비용을 설명한다. |
| [EXPLAIN QUERY PLAN](https://www.sqlite.org/eqp.html) | 1.1 Table and Index Scans, 1.2 Temporary Sorting B-Trees | 범위 탐색·전체 순회·커버링 접근·임시 GROUP BY를 구별한다. |
| [ANALYZE](https://www.sqlite.org/lang_analyze.html) | 2.1 Periodically run PRAGMA optimize | 데이터 분포 통계가 계획 선택에 미치는 영향과 통계 갱신 시점을 설명한다. |

## 기본 원리: 쿼리의 동등 조건을 먼저, 범위 조건을 그 뒤에

복합 인덱스 `(a,b,c)`는 먼저 `a`, 같은 `a` 안에서 `b`, 같은 `a,b` 안에서 `c`를 정렬한다. 따라서 `session_id = ? AND local_day >= ? AND local_day < ?`가 주된 조회라면 `(session_id,local_day)`가 자연스러운 출발점이다. 세션 하나를 고른 뒤 그 안의 날짜 범위를 연속해서 탐색할 수 있다. `(local_day,session_id)`는 모든 세션의 날짜 범위를 먼저 방문하고 세션을 더 걸러야 할 수 있다. [공식 WHERE 분석](https://www.sqlite.org/optoverview.html#where_clause_analysis).

```sql
-- 세션 갱신·세션 내 기간 조회
CREATE INDEX example_session_day ON usage_request_daily(provider,session_id,local_day);
SELECT * FROM usage_request_daily
WHERE provider = ? AND session_id = ? AND local_day >= ? AND local_day < ?;

-- 제공자를 지정하지 않는 전체 기간 조회
CREATE INDEX example_day ON usage_request_daily(local_day,provider);
SELECT * FROM usage_request_daily WHERE local_day >= ? AND local_day < ?;
```

이 두 인덱스는 서로 다른 쿼리의 접근 경로다. 세션을 지정하지 않는 조회가 많으면 세션 선두 인덱스 하나만으로 해결하기 어렵다. 선두를 생략하는 skip-scan 예외도 있지만 분포·통계에 좌우되므로 보장으로 삼지 않는다. [공식 Skip-Scan 설명](https://www.sqlite.org/optoverview.html#the_skip_scan_optimization).

`(provider,session_id,project_key,local_day)`에서 프로젝트 조건이 없으면 일반적으로 `provider,session_id`까지 탐색하고 날짜는 추가로 검사한다. 중간의 `project_key`를 건너뛰어 날짜까지 항상 탐색 키로 사용한다고 가정하면 안 된다. 반면 영향 날짜·프로젝트를 모두 알고 동등 비교하면 네 키를 모두 활용할 수 있다. [공식 인덱스 조건 예시](https://www.sqlite.org/optoverview.html#index_term_usage_examples).

## 선택도가 높은 컬럼을 무조건 앞에 두지는 않는다

모든 키에 동등 조건을 주는 한 쿼리에서는 어느 순서든 전체 키로 좁힐 수 있다. 순서 선택에는 **일부 조건만 있는 다른 쿼리**, 범위 조건, 결과 정렬, 데이터 분포를 함께 반영해야 한다. 세션이 제공자보다 훨씬 다양하더라도 `provider,session_id`를 항상 함께 주는 경로에서 세션 선두가 반드시 더 빠르다는 결론은 나오지 않는다. 이는 공식 복합 키 구조와 통계 기반 선택 설명으로부터의 적용 판단이다. [Query Planning](https://www.sqlite.org/queryplanner.html#multi_column_indices), [ANALYZE](https://www.sqlite.org/lang_analyze.html).

## Agent Tracker에 적용하는 순서

| 실제 작업 | 먼저 고정하는 조건 | 이어지는 범위 | 유력한 접근 경로 |
| --- | --- | --- | --- |
| 세션 전체 교체·조회 | provider, session_id | 없음 | 세션 중심 PK |
| 세션 내 기간 조회 | provider, session_id | local_day | `(provider,session_id,local_day)` 검토 |
| 전체 제공자의 기간 조회 | 없음 | local_day | 날짜 선두 인덱스 또는 날짜 선두 본체 |
| 제공자·기간 조회 | provider | local_day | `(provider,local_day)` 검토 |
| 제공자·프로젝트·기간 조회 | provider, project_key | local_day | 기존 `(provider,project_key,local_day)` |
| 특정 한 달의 전체 조회 | local_month | 없음 | 월 선두 PK와 `local_month = ?` 조합 검토 |
| 모든 달의 합계 | 없음 | 전체 | 읽을 집계 행 수·그룹화·본체 재접근 비용까지 측정 |

여기서 “유력”은 설계 출발점이다. 현재 세션 PK에 날짜·프로젝트 보조 인덱스를 함께 두는 선택도 충분히 합리적이며, 날짜·월 PK와 어느 쪽이 좋은지는 실제 읽기·쓰기 비율로 결정해야 한다.

## GROUP BY와 클러스터링을 구분해서 확인하기

`WITHOUT ROWID`에서는 PK가 본체 B-tree의 키다. 날짜·월 선두 PK는 해당 기간의 지표를 본체에서 함께 읽게 할 수 있다. 보조 인덱스는 다른 순서의 탐색 경로를 제공하지만 필요한 지표가 없으면 본체로 돌아가야 한다. 지표까지 넣는 커버링 인덱스는 이 접근을 줄이는 대신 공간과 쓰기를 늘릴 수 있다. [WITHOUT ROWID](https://www.sqlite.org/withoutrowid.html), [Covering Indexes](https://www.sqlite.org/queryplanner.html#covering_indexes).

월 PK를 추가한 뒤에도 SQL이 `substr(local_day,...)`로 월을 계산하면 저장된 월 키와 GROUP BY 표현식이 일치하지 않는다. `local_month`를 직접 필터·그룹 키로 쓰는 후보도 함께 시험해야 한다. 다만 월별 입력을 찾는 비용과 합계 계산에 필요한 모든 행을 읽는 비용은 별개다. 그룹 수가 적다는 이유만으로 전체 입력을 덜 읽는다고 볼 수 없다.

## 실무 검증 절차

1. 실제 `WHERE`, `JOIN`, `ORDER BY`, `GROUP BY`, 조회 빈도와 세션 갱신 빈도를 적는다.
2. 동등 조건의 공통 prefix와 첫 범위 조건을 찾고, 조건이 빠진 쿼리를 따로 검토한다.
3. 기존 구조, PK만 변경, 보조 인덱스만 추가, 둘 다 변경한 후보를 분리한다. 월 컬럼 추가 비용도 별도 대조한다.
4. 동일 입력과 같은 PRAGMA·통계 조건에서 준비된 SQL, 결과 전체·개수, 실제 갱신, WAL·본체·인덱스 공간을 비교한다.
5. 실행 순서를 교대하고 준비 실행 뒤 반복 표본의 중앙값·범위를 보존한다. cold I/O는 별도 환경에서 검증한다.
6. 계획에서 `SEARCH`, `SCAN`, `USING COVERING INDEX`, `USE TEMP B-TREE`를 확인한다. 인덱스를 사용한다는 문구만으로 개선을 판정하지 않는다. [계획 판독](https://www.sqlite.org/eqp.html).
7. 읽기 절감 시간 × 읽기 횟수와 쓰기 증가 시간 × 갱신 횟수를 합산한다. 호출 빈도를 모르면 단일 승자를 확정하지 않는다.

이번 실험은 합성 분포에서 위 절차의 접근 경로·갱신·정확성·공간을 비교한다. 실제 사용자별 호출 비율과 OS 캐시를 비운 디스크 시험은 포함하지 않는다.
