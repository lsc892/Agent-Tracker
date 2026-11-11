# 현재 기능을 고정한 쿼리·테이블 최적화 설계안

설계일: **2026-11-10, Asia/Seoul**. 사용자의 전제는 현재 기능을 최종 요구사항으로 보고 중복 작업과 탐색 범위를 줄이는 것이다. 이 문서는 현재 코드를 검토한 **권장 목표 구조**이며 제품 코드·DB에 적용하지 않았다. 테스트·벤치마크·DB 실행 계획 수집은 수행하지 않아 최적 성능을 입증한 결과는 아니다.

후속 [SQL 최소화 A/B](../../benchmarks/2026-11-10/QueryMinimizeAB-2026-11-10.md)는 요청 저장·일별 집계를 선택해 신규 자식 DELETE 제거와 좁은 입력의 사용량 판정 공유만 적용했다. 아래 전체 테이블·조회 설계가 한꺼번에 반영됐다는 뜻은 아니다.

## 선택한 방향

**기존 요청 원본과 일별 집계를 유지하고, 같은 조회 결과를 한 번 계산해 공유한다. 이름 선택에 필요한 작은 관계 요약만 추가하고, 비용 때문에 원본 전체 집계로 돌아가는 경로를 줄인다.**

기능 고정은 다음 계약을 보존한다는 뜻이다.

- 제공자·모델 기준, 전체·일·월·프로젝트·세션·요청별 조회와 현재 정렬·페이지 번호 이동을 유지한다.
- 합계에는 모든 요청 상태를 포함한다. 평균은 완료 표본이며 빈 사용량 제외 설정과 NULL 캐시·duration의 분모를 유지한다. 빈 사용량을 전체 WHERE에서 제거하지 않는다.
- 미상 시간·미상 모델·사용량 미기록을 구분하고, 부분 날짜는 원본으로 계산한다. 시간대 변경·비용 미상·사용자 결제 선택도 유지한다.
- 표와 도표는 같은 페이지 결과를 사용한다. 이름 선택은 날짜·현재 표 페이지와 독립적이다.
- 세션의 전체 시작 시각과 특정 프로젝트에서의 시작 시각을 구분한다. 한 세션이 여러 프로젝트에 나타날 가능성을 보존한다.

## 1. 현재 코드에서 확인한 중복과 넓은 조회

| 구간 | 확인한 현재 구조 | 목표 |
| --- | --- | --- |
| 통계 페이지 | 행 조회와 개수 조회가 별도 SQL로 같은 필터·GROUP BY를 실행 | 집계 결과 하나를 행과 개수가 공유 |
| 도구 분류 | 4개 분류마다 순위·개수/합계/최댓값을 별도 집계: 집계 SQL 8회 | 4개 분류를 한 번 그룹화하고 결과에서 통계·페이지 분리 |
| coverage | 일반 조회도 `diagnostics(limit:1).counts`를 호출 | counts만 읽고 파일·요청 진단 목록 조회 2회 제거 |
| 이름 선택 | 요청 원본을 GROUP BY해 이름 목록과 개수 계산 | 세션×프로젝트 관계 요약을 조회 |
| 세션 시작 | 집계 행의 상관 서브쿼리로 전체 세션 MIN 조회 | 세션 metadata의 확정된 최소 시각 참조 |
| 비용 포함 | `includeCosts`이면 rollup을 포기하고 원본 집계 | 기존 daily에 비용 병합 상태 추가 |
| 요청 목록 | 이름·모델·선택적 비용 소스에 정렬·페이지 적용 | 페이지 선정에 필요한 열만 먼저 읽고 상세 조회 지연 |
| 저장 전 비교 | 요청마다 기존 facts·모델·도구·비용을 각각 조회 | 기존 ID를 재사용하고 제한된 ID 묶음으로 비교 자료 조회 |
| 변경 후 쓰기 | 도구·제목 변경 등도 비용 저장·세션 rollup 경로에 진입 가능 | 변경된 열의 의존 관계로 필요한 쓰기·집계만 실행 |

근거: [reader.ts](../../../src/summary/db/reader.ts), [Worker](../../../src/summary/client/worker.ts), [raw 집계](../../../src/summary/db/queries/raw/usage.ts), [rollup 집계](../../../src/summary/db/queries/rollup/usage.ts), [도구 집계](../../../src/summary/db/queries/raw/capabilities.ts), [이름 목록](../../../src/summary/db/queries/raw/names.ts), [저장 비교](../../../src/summary/db/memoryStore.ts).

별도 SQL 두 개가 같은 원본을 읽는 것은 코드에서 확인했다. 반면 `SELECT *` 안의 모든 표현식이 실제 실행된다는 주장이나 특정 JOIN이 모든 원본 행에서 실행된다는 주장은 하지 않는다. SQLite가 필요 없는 projection을 제거하거나 JOIN 순서를 바꿀 수 있기 때문이다.

## 2. 권장 테이블 구조

| 테이블 | 목표 책임·변경 |
| --- | --- |
| `projects` | 프로젝트 키·이름 유지 |
| `sessions` | 제공자·세션 키·이름 유지, 전체 세션의 `first_started_at_ms` 추가 |
| `session_project_scope` — 신규 | 실제 요청이 있는 제공자×세션×프로젝트 관계와 해당 관계의 최초 시각 |
| `turn_summary` | 요청 원본과 고정 ID 유지 |
| `turn_model_usage` | 요청별 모델 원본 유지 |
| `turn_capability_usage` | 요청별 4개 분류의 사용 횟수 유지 |
| `turn_costs`, `session_billing` | 요청 비용과 세션 사용자 선택 유지 |
| `usage_request_daily`, `usage_model_daily` | 현재 합계·완료 표본 상태 유지, 비용 병합 상태 4개씩 추가; 세션 시작을 metadata로 옮긴 뒤 요청 daily의 최소 시각 상태 제거 |
| `usage_rollup_meta` | 활성 시간대·집계 형식 유지, 비용 단가 버전도 유효성 판단에 포함 |
| `manifest` | 파일 관측·처리·진단 유지 |

요청·일·월·프로젝트·세션마다 별도 통계 테이블을 모두 만들지는 않는다. 현재 daily가 재사용할 수 있는 기준 집계이고, 새 관계 요약은 날짜에 독립적인 이름 선택과 세션 metadata 조회에 한정한다.

### 2.1 이름·세션 시작을 위한 최소 관계 요약

다음은 제안 DDL이다. 실행한 migration이 아니다.

```sql
ALTER TABLE sessions ADD COLUMN first_started_at_ms INTEGER;

CREATE TABLE session_project_scope (
  provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex')),
  session_id TEXT NOT NULL,
  project_key TEXT NOT NULL REFERENCES projects(project_key),
  first_started_at_ms INTEGER,
  PRIMARY KEY(provider, session_id, project_key),
  FOREIGN KEY(provider, session_id)
    REFERENCES sessions(provider, session_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_session_project_scope_project
  ON session_project_scope(provider, project_key, session_id);
```

`session_project_scope`는 삭제 보존 정책까지 적용된 최종 `turn_summary`를 기준으로 만든다. 변경 세션의 이전 관계만 삭제하고 `GROUP BY provider, session_id, project_key`로 교체한다. 요청이 0개가 된 관계는 남기지 않는다. 현재 기능에서 사용하지 않는 관계별 요청 수는 별도 열로 저장하지 않는다.

같은 transaction에서 `sessions.first_started_at_ms`를 해당 세션 관계들의 `MIN(first_started_at_ms)`로 확정한다. 모든 시각이 미상이면 NULL이다. 최초 요청 삭제·날짜 수정·프로젝트 이동에도 다시 계산하므로 단순히 새 시각과 기존 시각의 MIN만 취하지 않는다.

열을 추가하면 현재 `INSERT INTO sessions VALUES(?,?,?)` 같은 위치 기반 INSERT도 명시적 열 목록으로 바꿔야 한다. 세션 이름을 UPSERT할 때 계산해 둔 시작 시각을 덮어쓰지 않도록 한다.

이 구조를 사용하면 다음 조회가 줄어든다.

- 프로젝트 선택: 관계 요약에서 허용 제공자에 해당하는 `project_key`만 중복 제거한다.
- 세션 선택: 관계 요약의 행을 `sessions`, `projects`와 연결한다. 한 세션의 여러 프로젝트 관계는 각각 유지한다.
- 세션 통계의 전체 시작 시각: 원본을 다시 MIN하지 않고 `sessions`의 한 행에서 얻는다.

이름만 바뀌면 관계 요약·토큰 집계를 재구축하지 않는다. 표시 이름은 이름 테이블에서 가져온다. 기존 이름 선택의 `NOCASE`와 이름 없는 세션 정렬 규칙도 유지한다.

raw·rollup의 세션 시작 조회가 모두 이 metadata를 사용하게 되면, 현재 요청 daily의 `min_started_at_ms`도 제거한다. 모델 daily에는 이미 없는 상태다. 같은 최소 시각을 날짜마다 반복 저장할 필요가 없어지고, 비용 상태를 추가하는 공간 증가의 일부도 줄인다.

### 2.2 비용을 일별 집계에 포함한다

각 daily에 다음 상태를 추가한다.

| 상태 | daily 생성 | 상위 집계 병합 |
| --- | --- | --- |
| `cost_usd` | `SUM(cost_usd)`; 모두 미상이면 NULL | `SUM(cost_usd)` |
| `unknown_costs` | `SUM(unknown_costs)` | `SUM(unknown_costs)` |
| `billing_mode_min` | `MIN(billing_mode)` | `MIN(billing_mode_min)` |
| `billing_mode_max` | `MAX(billing_mode)` | `MAX(billing_mode_max)` |

최종 결제 방식은 병합한 MIN과 MAX가 같을 때 그 값, 다르면 `unknown`이다. 구독 비용 0과 비용 미상 NULL은 그대로 구분한다. 비용 SUM을 처음부터 `coalesce(..., 0)`로 저장하면 이 구분이 사라지므로 적용하지 않는다.

요청 daily와 모델 daily의 비용 입력은 현재 [원본 비용 projection](../../../src/summary/db/queries/raw/source.ts)을 각각 따른다. 요청 비용을 모델마다 복사하면 다중 모델 요청의 비용이 중복되므로 금지한다. 부분 날짜 raw 소스에도 같은 비용 상태를 제공한다.

비용을 표시하지 않는 조회는 추가 비용 상태를 SELECT·병합하지 않는다. 다만 저장 공간과 비용 상태 유지 비용은 늘어난다. 사용자 결제 변경·단가 재계산이 끝난 transaction 안에서 해당 세션 daily까지 갱신해야 한다. 단가 버전이 바뀌었으면 모델별 추정 비용과 요청 비용을 먼저 재계산한 뒤 daily를 유효하게 만든다. 기존 비용 코드가 쓰는 부동소수점의 합산 순서 차이도 구현 시 확인 대상이다.

## 3. 통계 행과 전체 개수: 한 번 그룹화하고 공유

권장 흐름은 `필터 → 필요한 원본/일별 소스 → GROUP BY 1회 → 전체 개수 + 페이지 → 표시용 정보`다.

아래 SQL은 **제공자 하나·알려진 날짜 범위·프로젝트별 조회**에서 토큰과 요청 수만 표시한 설계 예시다. 실제 생성기는 현재 전체 지표·평균·필터·정렬을 보존해야 한다.

```sql
WITH grouped AS MATERIALIZED (
  SELECT provider, project_key,
         SUM(total_tokens) AS total_tokens,
         SUM(turn_count) AS turn_count
  FROM usage_request_daily
  WHERE provider = :provider
    AND local_day >= :from_day
    AND local_day < :to_day
  GROUP BY provider, project_key
),
page AS MATERIALIZED (
  SELECT * FROM grouped
  ORDER BY total_tokens DESC, provider, project_key
  LIMIT :limit OFFSET :offset
)
SELECT totals.total AS __total,
       page.*, projects.project_name
FROM (SELECT COUNT(*) AS total FROM grouped) AS totals
LEFT JOIN page ON 1 = 1
LEFT JOIN projects ON projects.project_key = page.project_key
ORDER BY page.total_tokens DESC, page.provider, page.project_key;
```

`grouped`를 count와 page가 공유해 원본 집계를 한 번으로 모으고, 페이지 선택에 필요 없는 이름은 마지막에 붙인다. 이 예시에서는 이름이 필터·정렬 조건에 없어서 가능하다. 실제로 이름으로 정렬하는 경우에는 페이지를 선택하기 전에 이름을 결합해야 한다.

페이지가 비었거나 OFFSET이 결과 끝을 넘어도 `totals` 한 행을 LEFT JOIN의 기준으로 유지한다. 실제 요청·집계의 provider는 NOT NULL이므로 `page.provider IS NULL`인 행은 반환 목록에서 제거하고 `__total`만 읽는다. `COUNT(*) OVER()`만 붙였다가 빈 페이지에서 전체 개수를 잃는 방식을 피한다.

`AS MATERIALIZED`는 SQLite에서 임시 결과를 만들며 predicate push-down·flattening을 막는다. 따라서 **필터와 부분 날짜 처리를 먼저 끝낸 작은 최종 그룹 결과**에 사용한다. 전체 원본을 무조건 materialize하지 않는다. 그룹이 아주 작거나 원본 count가 매우 싼 경우에는 별도 조회보다 이득이 없을 수 있다. [SQLite materialization](https://www.sqlite.org/lang_with.html#materialization_hints).

## 4. 4개 분류의 순위·통계: 집계 8회에서 공통 그룹화 1회로

지금 화면은 네 분류를 함께 요청하므로 category를 함수 인자로 바꾸어 같은 집계를 반복할 필요가 없다. 공통 필터로 `(category, provider, name)`을 한 번 집계한 뒤 각 분류의 전체 통계와 서로 다른 페이지를 만든다.

```sql
WITH page_config(category, offset_rows, page_rows) AS (
  VALUES ('skill',    :skill_offset,    :skill_limit),
         ('subagent', :subagent_offset, :subagent_limit),
         ('plugin',   :plugin_offset,   :plugin_limit),
         ('model',    :model_offset,    :model_limit)
),
grouped AS MATERIALIZED (
  SELECT u.category, t.provider, u.name,
         SUM(u.usage_count) AS uses
  FROM turn_summary AS t
  JOIN turn_capability_usage AS u ON u.turn_id = t.id
  WHERE t.provider = :provider
    AND t.started_at_ms >= :from_ms
    AND t.started_at_ms < :to_ms
  GROUP BY u.category, t.provider, u.name
),
stats AS (
  SELECT category, COUNT(*) AS total,
         SUM(uses) AS total_uses, MAX(uses) AS max_uses
  FROM grouped
  GROUP BY category
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY category
    ORDER BY name = '', uses DESC, provider, name
  ) AS rn
  FROM grouped
)
SELECT cfg.category,
       COALESCE(stats.total, 0) AS __total,
       COALESCE(stats.total_uses, 0) AS __total_uses,
       COALESCE(stats.max_uses, 0) AS __max_uses,
       ranked.provider, ranked.name, ranked.uses
FROM page_config AS cfg
LEFT JOIN stats ON stats.category = cfg.category
LEFT JOIN ranked
  ON ranked.category = cfg.category
 AND ranked.rn > cfg.offset_rows
 AND ranked.rn <= cfg.offset_rows + cfg.page_rows
ORDER BY cfg.category, ranked.rn;
```

이 SQL도 제공자 하나·알려진 시각 범위의 예시다. WHERE를 그대로 고정하지 않고 현재 제공자 목록·이름·프로젝트·세션·미상 시간 정책을 생성기로 반영한다. 분류별 빈 페이지도 cfg가 유지하므로 통계가 사라지지 않는다. `ranked.provider IS NULL`인 행은 해당 분류의 rows에서 제외한다.

비율의 분모는 페이지 사용량이 아닌 해당 분류의 `__total_uses`다. 제공자가 달라도 이름이 같다는 이유로 합치지 않는다. 기존 `(turn_id, category, name)` PK를 활용하며, 네 분류를 모두 읽는 경로에 category 선두 인덱스를 추가할 필요는 우선 없다. 윈도 정렬과 작은 그룹 결과의 재순회 비용은 남는다. [SQLite window functions](https://www.sqlite.org/windowfunctions.html).

## 5. 요청 상세: 좁은 페이지 키부터 결정

제공자 기준 기본 시간 내림차순은 다음 형태를 목표로 한다. 모델·비용·이름 정렬이 없는 경우의 축약 예시이며, 이 SQL도 실행하지 않았다.

```sql
WITH page AS MATERIALIZED (
  SELECT id, started_at_ms, provider
  FROM turn_summary
  WHERE started_at_ms >= :from_ms
    AND started_at_ms < :to_ms
  ORDER BY started_at_ms DESC, provider, id
  LIMIT :limit OFFSET :offset
)
SELECT t.*, p.project_name, s.session_name
FROM page
JOIN turn_summary AS t ON t.id = page.id
JOIN projects AS p ON p.project_key = t.project_key
JOIN sessions AS s
  ON s.provider = t.provider AND s.session_id = t.session_id
ORDER BY page.started_at_ms DESC, page.provider, page.id;
```

전체 개수는 모든 요청의 상세를 materialize하지 않고 `turn_summary`의 좁은 조건으로 따로 센다. 상세 요청 목록에는 GROUP BY가 없으므로 앞의 통계 페이지 결합 전략을 일괄 적용하지 않는다. 모델 기준 개수는 모델 자식이 없는 요청의 한 행도 보존하는 좁은 LEFT JOIN을 사용한다.

실제 구현에서는 다음을 지킨다.

- 필터·정렬에 필요한 JOIN·값은 페이지 선정 전에 있어야 한다. 나머지 표시·진단 열만 뒤로 보낸다.
- 모델 기준 페이지 식별자는 `turn_id`와 **저장된 모델 키**를 함께 사용한다. 표시용 모델 정규화 값만 쓰거나 ID만 고르면 행 수가 달라질 수 있다.
- 상세 반환의 모델·비용·`has_recorded_usage` 의미는 기존 source projection을 그대로 따른다. 위 예시가 전체 반환 열 계약을 대신하지 않는다.
- OFFSET의 키 건너뛰기 비용과 count 비용은 남는다. 현재 페이지 번호 이동을 유지하므로 전 화면 keyset 전환은 목표에 넣지 않는다. 기존 `afterId` API는 유지한다.

## 6. 필터·정렬·인덱스의 목표 형태

### 6.1 기본 정렬을 단순화하고 기존 기간 인덱스의 교체를 검토한다

현재 제공자 기준 요청의 기본 `period DESC`는 `started_at_ms IS NULL`이 미상 우선순위와 선택 열 NULL 여부로 두 번 들어간다. 동일한 정렬식을 제거하고, 이 경로에서는 SQLite의 DESC가 NULL을 마지막에 두는 규칙을 이용해 다음과 같이 단순화할 수 있다.

```sql
ORDER BY started_at_ms DESC, provider ASC, id ASC
```

모델 미상 우선순위나 다른 열의 오름차순에도 똑같이 지울 수 있다는 뜻은 아니다. 정렬 생성기의 전체 계약을 기준으로 경로별로 단순화한다. [현재 정렬 생성기](../../../src/summary/db/queries/common/sorting.ts), [SQLite NULL 정렬](https://www.sqlite.org/lang_select.html#the_order_by_clause).

위 기본 순서에 대응하는 기간 인덱스 목표는 다음과 같다. **기존 기간 인덱스 두 개의 교체 후보**이며, 둘씩 중복 유지하는 안이 아니다.

```sql
-- idx_summary_period 교체 시 목표 정의
CREATE INDEX idx_summary_period
  ON turn_summary(started_at_ms DESC, provider ASC, id ASC);

-- idx_summary_project_period 교체 시 목표 정의
CREATE INDEX idx_summary_project_period
  ON turn_summary(provider, project_key, started_at_ms DESC, id ASC);
```

현재 ASC 인덱스를 역방향으로 읽으면 뒤의 동률 열 방향도 함께 뒤집힌다. 기본 화면의 시간 DESC·동률 ID ASC와 같은 혼합 방향을 명시하면 범위 탐색과 정렬을 함께 만족시킬 여지가 있다. 다만 미상 포함 OR, 이름·모델 정렬과 다른 필터 조합에서 선택되는 실제 계획은 별도 확인이 필요하다.

그 밖의 현재 request UNIQUE, daily 날짜·프로젝트 인덱스, manifest 인덱스는 유지하는 것이 출발점이다. 세션 시간 인덱스는 [기존 비교에서 일관된 개선을 확인하지 못했으므로](../../benchmarks/2026-11-03/SessionTimeIndexAB-summary.md) 같은 인덱스를 새 기본안에 다시 넣지 않는다. 모든 정렬 열에 인덱스를 추가하지 않는다.

### 6.2 이름 검색은 이름 테이블에서 후보 키를 먼저 찾는다

`%이름%` 검색은 현재 부분 문자열 검색 의미를 유지한다. 이름 테이블에서 일치하는 프로젝트 키·제공자/세션 키를 작은 집합으로 한 번 만든 뒤 원본·daily에 적용하는 형태를 권장한다. 동일 이름의 여러 제공자 세션을 섞지 않도록 세션 키는 `(provider, session_id)` tuple이다.

현재처럼 요청별 상관 EXISTS로 표현해도 planner가 충분히 최적화할 수 있으므로 키 집합을 명시하는 것만으로 더 빠르다고 단정하지 않는다. 선행 `%`에는 일반 LIKE 범위 최적화를 기대하지 않고, 날짜·제공자·프로젝트 키로 사실 테이블 범위를 줄이는 데 집중한다. 검색 의미가 달라지는 prefix/FTS 교체는 이 설계에 포함하지 않는다. [SQLite LIKE 조건](https://www.sqlite.org/optoverview.html#the_like_optimization).

### 6.3 의미가 확정된 필터 분기를 직접 만든다

- 시각 미상만 조회: raw는 `started_at_ms IS NULL`, daily는 `local_day = ''`를 직접 쓴다.
- 미상 제외 기간: `>= 시작 AND < 다음 시작` 범위를 직접 쓴다.
- 미상 포함: 알려진 범위와 미상 그룹의 의미를 유지한다. OR를 UNION ALL로 바꾸는 것은 기존 계획과 비용을 확인한 후 결정한다.
- 선택하지 않은 조건에 `(:value IS NULL OR column = :value)`를 잔뜩 붙이는 SQL 대신 현재처럼 필요한 조건만 생성한다.
- 시작·끝이 역전된 기간도 미상 포함 정책에 따라 미상 행은 남을 수 있으므로 무조건 0행으로 단축하지 않는다.

## 7. coverage와 저장 쿼리도 실제로 필요한 작업만 수행

### 7.1 coverage 전용 counts API

현재 Worker는 모든 통계 조회에서 `diagnostics({limit:1,...}).counts`를 사용한다. `diagnostics()`는 counts를 얻기 전에 파일 목록과 오류 요청 목록도 조회한다. 일반 화면에는 `queryCoverageCounts(providers)`를 제공해 이 두 목록 조회를 제거한다. 실제 진단 패널은 기존 목록·페이지 API를 유지한다.

counts 내부의 manifest 상태 합산과 stale 요청 수 조회는 서로 다른 입력이므로 합치기 위해 큰 JOIN을 만들지 않는다. 현재처럼 독립 집계하되 결과 숫자만 반환한다. coverage는 선택 제공자 범위이며 현재 표의 날짜·프로젝트 필터와 독립적이라는 의미도 유지한다.

### 7.2 이전 요청 비교는 ID 묶음으로 읽는다

삭제 판정을 위해 이미 읽는 기존 `id/root_turn_id/project_key` 결과에서 요청 키→ID 정보를 재사용한다. 기존 사실·모델·도구·비용 비교 자료는 요청마다 네 번 조회하는 대신 제한된 ID 블록으로 읽는다. 그 후 같은 요청별 비교를 수행한다.

요청 facts와 1:1인 비용의 존재 여부·결제 방식·단가 버전은 한 조회로 읽고, 모델과 도구는 각각 별도 블록 조회로 읽는 것이 목표다. 두 종류의 1:N 자식을 한 번에 JOIN하면 모델 수×도구 수로 행이 늘어나므로 합치지 않는다. 비교를 위해 필요한 조회를 블록당 세 개로 모으면서 실제 자식 행은 한 번씩 읽는 구성이다.

전체 세션의 넓은 기존 객체를 한꺼번에 메모리에 보관하지 않는다. 현재 transaction의 요청 상한 안에서 비교 자료 블록의 별도 상한을 둔다. 행별 결과·이터러블 단일 소비·실패 격리와 기존 16성분/1,000요청의 정상 저장 경계를 유지한다. 반복 snapshot·삭제·재연결의 호환 경로는 입력 순서 의미를 우선한다.

### 7.3 바뀐 값에 따라 후속 쿼리를 구분한다

| 실제 변경 | 필요한 후속 작업 |
| --- | --- |
| 토큰·시간·duration·상태·프로젝트·모델 사용량 | 영향 세션의 관계/시작 시각·daily 중 해당 상태 갱신 |
| 모델별 비용 입력·결제 방식·단가 버전 | 요청 비용과 daily 비용 상태 갱신 |
| Skill 등 도구 자식만 변경 | 도구 자식 저장; 토큰·비용이 그대로면 해당 재계산 제외 |
| 요청 제목·원본 진단 위치·오류 표시만 변경 | 상세/진단 facts 저장; 집계 지표에 영향이 없으면 daily 재계산 제외 |
| 프로젝트·세션 이름만 변경 | 이름 저장; 토큰·비용 집계 재계산 제외 |

현재 `saveSummary()`는 사실·모델·도구·비용 중 하나가 바뀌어도 비용 저장과 변경 세션 등록에 도달한다. 의존 열 기준으로 dirty 사유를 나누면 도구나 제목 변경이 토큰 재집계로 이어지는 범위를 줄일 수 있다. 영향 범위를 분류하더라도 전체 저장 transaction·rollback·삭제 보존은 유지한다.

사용자 결제 변경의 `saveTurnCost()` 반복도 기존 100개 ID 블록마다 `INSERT ... SELECT ... GROUP BY t.id` 한 번으로 바꿀 수 있다. 모델이 없는 요청을 LEFT JOIN으로 보존하고 모델 수는 `COUNT(m.turn_id)`로 세어, 원본 없는 LEFT JOIN 한 행을 실제 모델 한 개로 오인하지 않는다. 요청별 `SUM`, `max(1, 모델 수) - 알려진 비용 수`, 구독 0·미상 NULL과 pricing version을 보존해야 한다. 큰 세션을 전부 JS 배열로 옮기는 방식은 사용하지 않는다.

## 8. 적용 순서와 남는 비용

권장 순서는 다음과 같다. 이는 구현·측정 지시를 이미 실행했다는 뜻이 아니다.

1. **coverage 전용 counts와 dirty 사유 분리:** 결과에 사용하지 않는 조회·쓰기를 먼저 제거한다.
2. **통계 공통 GROUP BY와 4개 분류 공통 집계:** 동일 필터·집계의 반복을 줄인다.
3. **좁은 요청 페이지와 기본 정렬 정리:** 필요한 상세 행만 읽도록 하고 기간 인덱스 교체를 비교한다.
4. **관계 요약과 비용 daily:** 이름 선택·세션 MIN·비용 화면의 원본 탐색을 줄인다. 파생 구조는 스키마/rollup 형식 전환과 최초 재구축이 필요하다.
5. **ID 블록 비교·결제 SQL 배칭:** 메모리 상한과 기존 저장 순서를 유지하면서 호출을 줄인다.

전체 집계는 모든 대상 그룹을 읽어야 한다. 집계값으로 정렬하려면 그 값을 계산해야 하고 OFFSET도 키를 건너뛰는 비용이 남는다. 이 설계는 기능에 필요한 계산을 보존하면서 중복 실행과 불필요한 큰 행 조회를 제거한다.

요청별 delta 유지, 모든 차원의 영속 집계, 모든 열을 포함한 covering index, 모든 화면의 keyset 전환은 기본안에 넣지 않는다. 이 작업의 우선 근거는 새 알고리즘 복잡도보다 현재 코드에서 확인한 중복 SQL·넓은 탐색이다.

## 검토·검증 범위

- 현재 소스와 [외부 프로젝트 레퍼런스](QueryIndexTableReferences-2026-11-10.md), SQLite 공식 문서로 설계를 검토했다.
- 코드·DB·스키마 버전은 변경하지 않았다. SQL은 설계 예시이며 실행·컴파일하지 않았다. 테스트·임시 재현 코드·벤치마크도 만들거나 실행하지 않았다.
- 구현 시 읽기 지연뿐 아니라 쓰기·인덱스 공간·임시 결과 크기와 빈 페이지·다중 모델·NULL·시간대·결제 변경의 결과 보존이 판단 기준이다. 측정 전에는 개선율이나 전역 최적성을 주장하지 않는다.
- 문서·목차의 상대 링크가 모두 존재하고 새 문서에 줄 끝 공백이 없음을 확인했다. `git diff --check`도 통과했다. 기능을 변경한 작업이 아니므로 현재 설계 명세와 의사결정 일지는 변경하지 않았다.
