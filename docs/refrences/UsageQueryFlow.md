# 통계 화면에서 SQLite까지의 조회 흐름

화면 진입이나 새로 고침 때 변경된 원본을 집계하고 일별 결과를 저장용 SQLite에 반영한다. 갱신이 성공하면 첫 표를 조회한다. 기본 기간은 최근 30일이며 복원된 선택 조건이 있으면 그 조건을 적용한다. 이후 필터·정렬·페이지를 바꾸면 Worker가 같은 일별 집계를 다시 조회한다. [화면의 갱신과 조회](../../src/ui/dashboard.ts) · [Worker 조회](../../src/summary/client/worker.ts)

```text
Webview queryUsage
  → Dashboard에서 메시지 검증 및 조회 조건 구성
  → SummaryClient / WorkerTransport에서 요청 ID와 조건 전송
  → Worker query
  → SummaryDatabase.queryUsagePage / SummaryReader
  → SQL 빌더의 { sql, values } → node:sqlite prepare(...).all(...)
  → 페이지 행과 전체 그룹 개수 → Worker에서 차트 데이터 구성
  → Dashboard에서 최신 결과를 Webview로 전송
```

## 요청 전달

1. Webview가 기간·그룹·제공자/모델 기준·프로젝트·세션·정렬·페이지를 보내면 Extension Host가 메시지를 검증한다. Host 설정에서 활성 제공자, 통계 시간대, 비용 표시, 빈 사용량 제외 설정을 덧붙인다. 시작일은 현지 자정 이상, 종료일은 다음 날 현지 자정 미만으로 바꾼다. [Webview 요청](../../media/dashboard.js) · [메시지 검증](../../src/ui/presentation.ts) · [Host 조회](../../src/ui/dashboard.ts)
2. `SummaryClient.query()`는 통계 데이터 삭제가 진행 중이면 완료를 기다린다. `WorkerTransport`가 `{id, method: 'query', payload}`를 보내고, 응답 ID로 대기 중인 호출을 완료한다. Worker는 사용량 또는 도구 탭을 구분한다. 일반 사용량은 `SummaryDatabase.queryUsagePage()`를 거쳐 `SummaryReader`로 전달한다. [클라이언트](../../src/summary/client/index.ts) · [Worker 요청·응답](../../src/summary/client/transport.ts) · [Worker 명령](../../src/summary/client/worker.ts) · [DB 공개 API](../../src/summary/db/index.ts)

## SQL 조립과 실행

1. **일별 데이터 선택.** 제공자 기준은 `usage_request_daily`, 모델 기준은 `usage_model_daily`를 읽는다. 제공자·프로젝트·세션·날짜 조건을 적용한다. 비용 표시가 켜지면 `sessions`를 `(provider, session_id)`로 조인하고 결제 지정값을 비용 계산식에 공유한다. SQL 구조는 빌더가 구성하고 필터 값, 개수, 오프셋은 `?` 자리에 바인딩한다. [일별 소스와 날짜 조건](../../src/summary/db/queries/rollup/source.ts) · [공통 필터](../../src/summary/db/queries/common/filters.ts)
2. **그룹화 후 페이지 선택.** 제공자에 필요한 모델·일·월·프로젝트·세션 키를 더해 `GROUP BY`한다. 각 그룹의 일별 합계를 합치고 완료 표본 수로 토큰 평균을 계산한다. 시간 평균에는 기록 시간이 있는 완료 표본을 사용한다. 정렬은 그룹 전체에 적용하고 그다음 `LIMIT`과 `OFFSET`으로 페이지를 자른다. [그룹·페이지 SQL](../../src/summary/db/queries/rollup/usage.ts) · [평균 계산](../../src/summary/db/queries/rollup/metrics.ts)
3. **SQLite 실행.** `SummaryReader`가 `connection.prepare(sql).all(...values, limit, offset)`을 실행한다. 각 행의 `COUNT(*) OVER()` 값으로 페이지를 자르기 전 전체 그룹 수를 얻는다. 오프셋이 있는 페이지가 비어 있으면 동일한 조건의 개수 쿼리를 `.get(...values)`으로 실행한다. 호출자의 트랜잭션을 사용하거나 독립 조회에서 `SAVEPOINT`를 열어 두 결과가 같은 스냅샷을 읽도록 한다. 기본 페이지 크기는 100이며 허용 범위는 1~1,000이다. [실행과 스냅샷](../../src/summary/db/reader.ts) · [페이지 검증](../../src/summary/db/validation.ts)
4. **표·차트 반환.** Worker는 `rows`와 `total`을 받고, 차트가 필요하면 같은 페이지 행으로 구성한다. 진단 범위와 필요한 세션 결제 정보도 응답에 담는다. Host는 가장 최근 요청의 결과만 Webview로 보내고, Webview는 표와 차트를 그린다. [Worker 응답](../../src/summary/client/worker.ts) · [차트 데이터](../../src/summary/db/chart.ts) · [화면 렌더링](../../media/dashboard.js)

예를 들어 최근 30일의 Codex 일간 토큰을 보려면, `usage_request_daily`에서 Codex와 날짜 범위를 고르고 세션·프로젝트별 일별 행을 다시 제공자·날짜로 묶는다. 표와 차트는 이 쿼리에서 반환된 같은 페이지를 사용한다.

아래는 이 예에서 날짜·토큰·개수만 남긴 SQL이다. 앞의 세 자리에는 `codex`, 시작일, 종료일 다음 날짜를 넣고, 마지막 두 자리에는 페이지 크기와 오프셋을 넣는다.

```sql
SELECT provider, local_day AS period,
       SUM(total_tokens) AS total_tokens, COUNT(*) OVER() AS _total
FROM usage_request_daily
WHERE provider = ? AND local_day >= ? AND local_day < ?
GROUP BY provider, local_day
ORDER BY period DESC
LIMIT ? OFFSET ?
```

## 이름·도구·파일 진단

| 화면 요청 | 읽는 데이터 |
| --- | --- |
| 프로젝트·세션 이름 선택 | `usage_request_daily`에서 사용량이 있는 키를 고르고 `projects`·`sessions`에서 이름을 읽는다. 날짜나 통계 표 페이지와 독립적으로 페이지를 만든다. [이름 쿼리](../../src/summary/db/queries/rollup/names.ts) |
| 도구 사용량 | `usage_capability_daily`의 공통 필터 범위를 한 번 읽고 분류·제공자·이름으로 그룹화한다. 분류별 순위와 페이지를 정하고 빈 페이지에도 전체 개수·횟수 합계·최댓값을 반환한다. [도구 쿼리](../../src/summary/db/queries/rollup/capabilities.ts) |
| 파일 진단 | `source_file`에서 상태와 오류를 읽는다. 실패·중단 파일이 있는 경우에만 해당 세션의 기존 집계 건수를 `usage_request_daily`에서 합산한다. [진단 쿼리](../../src/summary/db/queries/rollup/diagnostics.ts) |

저장 행의 키와 버전별 이관은 [SQLite 테이블](SQLiteTables.md)에 있다. [이전 상세 조회 SQL](../../src/summary/db/queries/raw/README.md)은 이전 스키마 이관과 검증에 사용한다.
