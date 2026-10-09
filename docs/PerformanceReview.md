# SQLite 인덱스·JSONL 파싱·스킬 집계 검토

2026-10-08, Asia/Seoul 기준 조사. 인덱싱과 파싱은 각각 별도 서브에이전트가 분석·측정하고, 스킬 집계는 주 에이전트가 확인했다. 이 문서는 분석과 개선 제안이며 제품 구현을 변경하지 않았다.

우선 검토할 곳은 현재 요청 제목 집계의 TEMP partial index와 JSONL reader의 바이트 전처리다. 영속 DB는 0.83 MiB로 작고, provider별 최신 요청 인덱스는 별도로 조회를 개선할 근거가 있다. 스킬 통계는 SQL에 저장되지만 명시 호출과 문서 읽기 탐지라는 집계 정의를 분명히 할 필요가 있다. 반복 측정 원본은 [측정 JSON](benchmarks/PerformanceReview-2026-10-08.json)에 보관했다.

## 조사 범위와 측정 조건

실제 설치 DB는 읽기 전용 연결에서 SQLite backup으로 일관된 복사본을 만들었다. 인덱스 생성·삭제·INSERT 실험은 복사본에서만 수행했다. 파싱은 원본 로그를 읽고 별도 임시 DB에 집계했다. 대화 본문·인증 정보는 결과물에 넣지 않았다.

| 대상 | 확인값 |
|---|---:|
| 설치 DB 스냅샷 | schema 7, parser 12 |
| 스냅샷의 원본 파일 | 236개, 254,130,581 bytes = 242.36 MiB |
| 영속 SQLite DB | 868,352 bytes = 0.83 MiB |
| 요청 요약 | 766행 |
| 명시적 인덱스 6개 | 합계 184,320 bytes = 180 KiB |
| 자동 UNIQUE 인덱스 2개 | 합계 126,976 bytes = 124 KiB |
| 파싱에 사용한 격리 빌드 | schema 8, parser 13 |
| 실행 환경 | Windows, Node 24.19.0, SQLite 3.53.3, i5-8250U, 논리 CPU 8개 |

조사 중 다른 작업의 소스 변경과 새 대화 로그 생성이 계속되었다. 인덱스의 기준 데이터는 위 236개 스냅샷으로 고정했고, 파싱은 격리 빌드로 고정했다. 전체 파싱 시점의 파일 수는 243개였다. 서로 다른 시점의 파일 수와 DB 버전을 동일 데이터로 취급하면 안 된다.

DB에는 JSONL 원문 전체가 들어가지 않는다. 파일 메타데이터, 요청별 요약, 모델별 토큰, 스킬 등 횟수, 비용이 저장된다. 작업 중 schema 8에는 짧은 요청 제목도 추가되어 있다. 영속 DB 크기와 파싱 중 생성되는 TEMP 이벤트 테이블의 비용은 별개다.

## 1. 인덱싱

### 최적화의 출발점

인덱스는 별도로 정렬된 키와 행 위치를 유지한다. `(provider, project_key, started_at_ms)`라면 provider를 찾고, 해당 provider 안에서 프로젝트를 찾은 뒤 날짜 범위를 읽는다. 기능 이름보다 실제 `WHERE`, `JOIN`, `ORDER BY`, 읽는 행 수에 맞추는 것이 기준이다. 날짜 전체 집계와 특정 provider의 최신 요청은 키 순서가 달라 서로 다른 인덱스가 유리하다. [SQLite Query Planning](https://www.sqlite.org/queryplanner.html), [Optimizer Overview](https://www.sqlite.org/optoverview.html).

조회가 빨라지는 대신 INSERT·DELETE 및 인덱스 키의 UPDATE가 B-tree도 갱신한다. 따라서 인덱스 하나당 일정한 트랜잭션 속도 향상을 보장할 수 없다. 조회 절약 시간과 쓰기 추가 시간, 저장 공간을 따로 측정해야 한다.

인덱스에 필요한 조회 컬럼까지 담으면 테이블을 다시 읽지 않는 covering index가 된다. 다만 토큰·시간·품질 컬럼을 모두 담는 큰 인덱스는 저장·쓰기 비용도 커진다. 전체 요청을 합산하는 통계는 인덱스가 있어도 대상 행을 읽어야 한다. 지금 766행에서는 추가 인덱스의 체감 효과가 작을 수 있다.

최적화할 때는 먼저 실제 SQL에 `EXPLAIN QUERY PLAN`을 붙인다. `SEARCH ... USING INDEX`는 키로 범위를 좁히는 탐색, `SCAN`은 범위의 많은 행을 순회하는 계획, `USE TEMP B-TREE`는 정렬·그룹화용 임시 구조를 뜻한다. SCAN 자체가 오류는 아니다. 대부분의 행을 합산한다면 전체 순회가 적절할 수 있으므로 실제 시간과 함께 판단한다.

### 기존 6개 인덱스의 실측 tradeoff

조회는 다른 인덱스를 유지하고 해당 인덱스 하나만 제거한 복사본과 비교했다. 30회 준비 실행 후 250회 조회 블록 11개의 중앙값이다. 영속 쓰기는 WAL/FULL, 준비 실행 4쌍 뒤 21쌍의 AB/BA 교차 INSERT+COMMIT 중앙값이다. 아래 시간 단위는 ms다.

| 인덱스·키 | 현재 공간 | 대표 조회: 없음 → 있음 | INSERT+COMMIT: 없음 → 있음 | 판단 |
|---|---:|---:|---:|---|
| `idx_manifest_identity(provider,dev,inode)` | 16 KiB | 0.0161 → 0.0151 | 236행: 3.298 → 3.619 | 이동 파일 탐색용. 현재 Windows 스캔은 이 경로를 호출하지 않음 |
| `idx_manifest_root_id(provider,source_root,id)` | 16 KiB | 0.0863 → 0.0607 | 236행: 3.324 → 4.012 | 루트별 미방문 파일 탐색·정렬에 적합 |
| `idx_manifest_session(provider,session_id,id)` | 16 KiB | 0.0217 → 0.0141 | 236행: 3.418 → 3.900 | 관련 세션 파일 탐색에 적합 |
| `idx_summary_period(started_at_ms,provider)` | 20 KiB | 0.1221 → 0.1165 | 500행: 9.454 → 10.094 | provider 전체의 날짜 범위에 적합. 이 7일 표본의 차이는 작음 |
| `idx_summary_project_period(provider,project_key,started_at_ms)` | 64 KiB | 0.1439 → 0.0382 | 500행: 8.877 → 9.988 | provider+프로젝트+날짜에서 약 3.77배. 유지 가치가 뚜렷함 |
| `idx_summary_session(provider,session_id,turn_index)` | 48 KiB | 0.0313 → 0.0421 | 500행: 9.545 → 10.191 | 현재 `ORDER BY id`에서 추가 정렬 발생. 키 재검토 대상 |

조회 범위는 날짜 7일, 프로젝트 날짜 30일, 행이 가장 많은 세션과 프로젝트 등을 골랐다. 전체 UI 시간이나 모든 필터의 평균이 아니다. 0.001~0.006ms 차이를 확정적인 성능 향상으로 해석하지 않는다.

쓰기의 추가 비용을 쌍별로 계산한 결과는 아래와 같다. 별도 중앙값 두 개의 차이와 쌍별 차이의 중앙값은 수학적으로 같지 않을 수 있다. P10~P90은 이 실험의 변동 범위이며 신뢰구간이 아니다.

| 인덱스 | 쌍별 추가 쓰기 시간 중앙값 | 추가 시간 P10~P90 |
|---|---:|---:|
| manifest identity | +0.197ms / 236행 | -0.523 ~ +0.837ms |
| manifest root | +0.591ms / 236행 | +0.277 ~ +0.930ms |
| manifest session | +0.503ms / 236행 | +0.014 ~ +0.896ms |
| summary period | +0.527ms / 500행 | -0.526 ~ +1.783ms |
| summary project | +1.227ms / 500행 | -0.271 ~ +2.366ms |
| summary session | +0.743ms / 500행 | -0.211 ~ +1.258ms |

저장 비용은 `dbstat`의 실제 할당 페이지 합계다. payload뿐 아니라 빈 공간과 B-tree 페이지도 포함하며, WAL·TEMP·JS 메모리는 포함하지 않는다. 인덱스를 DROP하면 페이지가 재사용 가능해지지만 DB 파일이 곧바로 그만큼 작아지는 것은 아니다. [DBSTAT](https://sqlite.org/dbstat.html), [VACUUM](https://sqlite.org/lang_vacuum.html).

### 후보 비교와 추천 순서

| 후보 | 조회: 기존 → 후보 | 저장 변화 | INSERT+COMMIT: 기존 → 후보 | 제안 |
|---|---:|---:|---:|---|
| `turn_summary(provider,started_at_ms)` | 실제 최신 60개 chart 메서드: 3.507 → 0.581ms | +20 KiB | 500행: 9.990 → 11.058ms | provider별 최신 요청이 중요하면 우선 후보 |
| 세션 인덱스를 `(provider,session_id)`로 교체 | id 페이지 대표 SQL: 0.0424 → 0.0263ms | 48 → 44 KiB | 500행: 10.036 → 9.968ms | 현재 사용하지 않는 `turn_index` 제거 검토. 쓰기 개선은 변동 범위 안 |
| `turn_summary(project_key,started_at_ms)` | provider 미지정 프로젝트 합계: 0.0798 → 0.0524ms | +52 KiB | 500행: 10.248 → 10.942ms | 먼저 통계 수집을 검토 |
| `turn_capability_usage(category,name,turn_id,usage_count)` | skill 순위: 0.2272 → 0.1569ms | +32 KiB | 500행: 3.037 → 3.867ms | 데이터·조회 빈도가 커진 뒤 검토 |
| `turn_model_usage(model,turn_id)` | 현행 모델 집계: 0.5993 → 0.5853ms | +20 KiB | 500행: 1.643 → 2.086ms | 현행 집계 plan에서 사용되지 않아 추가 근거 없음 |

최신 60개는 실제 `queryUsageChart({provider}, 'turn', 'Asia/Seoul', 'tokens')`를 사용했다. 설치 DB의 격리 복사본을 schema 8로 마이그레이션하고 고정한 현재 메서드를 호출했다. 프로젝트·세션 JOIN, 모델 유무 확인, COUNT를 포함하고 worker IPC와 UI 렌더링은 제외했다. 20회 준비 실행 뒤 100회 호출 블록 11개의 중앙값이며 약 6.04배, 83.4% 감소했다. `EXPLAIN`의 임시 정렬이 사라졌다. 나머지 행은 대표 SQL 측정이다.

`id INTEGER PRIMARY KEY`는 SQLite rowid다. 보통 secondary index에 rowid가 따라붙으므로 `(provider,started_at_ms)`의 역순 탐색으로 동일 날짜의 `id DESC`도 처리할 수 있었다. 명시적으로 `DESC,id DESC`를 추가한 후보는 24 KiB, 0.562ms로 저장 비용이 더 컸다. 세션 인덱스도 `(provider,session_id)` 뒤 rowid가 오면 id 페이지에 맞는다. 기존 UNIQUE의 다음 키는 `root_turn_id`이므로 단순히 앞부분이 겹친다고 대체할 수는 없다. [SQLite Query Planning](https://www.sqlite.org/queryplanner.html).

프로젝트 후보는 먼저 `PRAGMA optimize` 운영을 검토하는 것이 낫다. 코드에는 현재 `ANALYZE`·`PRAGMA optimize`가 없다. 복사본에 `ANALYZE`를 실행하자 기존 프로젝트 인덱스에서 `ANY(provider)` skip-scan을 사용하는 계획이 확인됐다. 모든 쿼리에서 동일 결과를 보장하지는 않는다. 지속 연결의 통계 수집과 인덱스 변경 뒤 실행 시점은 [SQLite ANALYZE 권고](https://www.sqlite.org/lang_analyze.html)를 기준으로 정할 수 있다.

모델 테이블은 `WITHOUT ROWID`, 기본키 `(turn_id,model)`로 요청별 JOIN에 이미 맞춰져 있다. PK가 곧 테이블의 저장 구조이므로 별도 일반 테이블과 PK 인덱스 비용을 이중 계산하면 안 된다. [WITHOUT ROWID](https://www.sqlite.org/withoutrowid.html).

시간 손익은 `조회 횟수 × 조회 절약 시간 - 쓰기 배치 횟수 × 추가 쓰기 시간`으로 비교할 수 있다. 저장 공간은 별도 제약으로 둔다. 예를 들어 skill 후보는 500행 쓰기 배치당 약 0.833ms가 추가되고 대표 조회당 0.0703ms를 절약했다. 약 12회 조회가 시간상 분기점이다. 현재 프로젝트 인덱스는 500행 쓰기당 약 1.227ms 추가, 조회당 0.1057ms 절약으로 역시 약 12회다. workload와 캐시·fsync가 달라지면 이 값도 달라진다. 여러 인덱스의 단독 비용을 합해 전체 refresh 시간을 예측할 수는 없다.

### 유사 상황의 실제 코드

1. [claude-session-index의 SQLite 스키마](https://github.com/lee-fuhr/claude-session-index/blob/main/session_index/indexer.py#L46-L109)는 Claude JSONL을 읽어 세션 메타데이터와 도구·에이전트 횟수를 저장한다. 프로젝트·클라이언트·시작 시각에 인덱스를 두고, 도구 횟수는 `(session_id,tool_name)` 복합 PK를 쓴다. Agent Tracker의 manifest·capability 구조와 비교하기 좋은 사례다. 본문 검색은 별도 FTS5다.
2. [Simon Willison LLM의 migration](https://github.com/simonw/llm/blob/main/llm/migrations.py#L406-L518)은 대화 트리의 자식 탐색에 `messages(parent_hash)`, 메시지 부분의 순서에 `(message_hash,position)`, 대화별 턴 조회에 `turns(thread_id)`를 둔다. 화면의 탐색 경로에 맞춰 키를 정한다는 예다. [LLM SQLite logging 문서](https://llm.datasette.io/en/latest/logging.html)도 저장 구조를 설명한다.
3. [claude-conversation-memory의 build_db.py](https://github.com/danieluszta/claude-conversation-memory/blob/main/build_db.py#L18-L67)는 JSONL 메시지를 저장하고 세션·timestamp 인덱스와 본문 FTS를 분리한다. 원문 검색이 목적일 때 저장 비용이 커지는 비교 사례다.

이 프로젝트들의 인덱스가 Agent Tracker에서도 최적이라는 뜻은 아니다. 자신의 조회 형태·보존 범위에 맞춘 실제 구현 예시이며, 성능 우월성을 입증하는 비교 실험은 아니다.

## 2. JSONL 파싱

> 이 절은 2026-10-08의 구현과 실험을 기록한다. 2026-10-09 제품 reader에 일반 줄 직접 파싱·연속 Buffer 처리와 기존 보호 조건을 함께 적용했다. 최종 소스의 JSONL 행 수·바이트 기준 파싱 비교는 I/O를 제외한 [적용 전후 브랜치 보고서](JsonlParsingBranches-2026-10-09.md)를 따른다. 이전 I/O 포함 측정은 [JSONL reader 트레이드오프 보고서](JsonlReaderTradeoff.md)에 그대로 보존한다.

### 현재 실행 구조

```mermaid
flowchart LR
  F[파일 메타데이터 스캔] --> R[변경 파일 전체 읽기]
  R --> J[바이트별 이미지 제거와 줄 구성]
  J --> P[JSON.parse와 provider 이벤트 추출]
  P --> T[TEMP SQLite 이벤트 저장]
  T --> D[중복 제거와 lineage·요청 집계]
  D --> S[영속 세션 교체]
```

관련 코드: [JSONL reader](../src/summary/jsonl.ts), [scanner](../src/summary/scanner.ts), [staging](../src/summary/staging.ts), [worker](../src/summary/worker.ts).

summary worker는 하나이며 파일을 순서대로 처리한다. 8개 논리 CPU가 있어도 파싱·동기 SQL이 자동으로 8개 코어에 나뉘지는 않는다. 파일 읽기는 비동기지만 JS reader·adapter·SQLite는 해당 worker에서 실행된다.

### 실제 200개 파일 표본

크기 분포를 따라 고른 200개 파일, 215,755,703 bytes = 약 205.76 MiB, 53,711 JSONL 행을 사용했다. 원본 크기는 관찰한 시점으로 제한했다. 아래는 3회 실행 중앙값이다.

| 단계 | 시간 | 의미 |
|---|---:|---|
| 원시 64 KiB 파일 읽기 | 0.376초 | 최초 읽기는 1.936초. 캐시 영향을 구분해야 함 |
| 현재 `readJsonl`, 행 처리 없음 | 5.695초 | 이미지 sanitizer·줄 구성·복사·JSON.parse 포함 |
| 현재 reader + adapter, SQL 저장 없음 | 6.756초 | 토큰·수명주기·스킬 이벤트 추출까지 포함 |
| 실험 native 줄 분리 + JSON.parse | 1.443초 | 제품 보호 조건이 빠진 비교용 구현 |
| 실험 native 줄 분리 + adapter | 2.186초 | 동일 표본에서 행 수·이벤트 종류별 개수 일치 |

한 번의 계측 실행에서는 adapter 포함 전체 5.926초 중 `JSON.parse` 1.014초, `adapter.row` 0.783초, 나머지 reader·복사·바이트 탐색·I/O 등이 약 4.129초였다. tool arguments의 JSON.parse 일부는 adapter 시간에도 포함되므로 세부 타이머를 독립 비용처럼 합산하면 안 된다. SQL을 빼도 전처리의 CPU 비용이 크다는 근거다.

실험 줄 분리는 `Buffer.indexOf(10)`으로 LF 위치를 찾고 `subarray`로 연속 영역을 다룬다. 하지만 이미지 Base64 제거가 없고 긴 줄·부분 줄의 메모리 제한 등 제품과 동등하지 않다. 행·이벤트 개수가 같다는 것만으로 내용·오류·이미지 처리가 같다고 증명할 수 없다. 성능 개선 가능성을 확인한 실험이며 현재 그대로 적용할 구현이 아니다.

### 전체 집계와 다시 읽는 비용

현재 격리 빌드로 실제 전체 243개 파일, 257,947,040 bytes를 새 임시 DB에 집계한 시간은 13.237초였다. 스캔 0.105초, 파싱 구간 9.819초, committing 구간 3.309초이며 실패 파일은 0개였다. `prepareSummaries` 222회 합계 1.759초, `replaceSessions` 합계 0.899초 등이 committing 비용을 구성했다.

`batchEvents`는 읽어온 chunk의 JSON 처리·adapter·SQL을 함께 감싼다. 그 전체 시간을 SQL INSERT만의 시간으로 해석하면 안 된다. 이미 chunk 단위 transaction과 prepared statement를 사용하므로 “한 줄마다 COMMIT해서 느리다”는 설명은 현재 코드와 맞지 않는다.

파일은 변경되지 않으면 본문을 읽지 않는다. 반면 append된 파일은 처음부터 다시 읽으며, 같은 논리 세션의 다른 관련 파일도 재처리될 수 있다. `processing_position`은 진단 문자열이고 append 재개를 위한 parser checkpoint가 아니다.

별도 합성 데이터 201개 파일로 이를 재현했다. 완전한 변화 없음 refresh는 0.055초, parsed 0, reused 201, 본문 읽기 0 bytes였다. 796,670 bytes인 큰 파일에 400 bytes를 append하자 797,070 bytes 전체를 읽고 3.324초가 걸렸다. 읽기 증폭은 새 데이터 대비 약 1,993배다. 요청·토큰 합계는 2,200요청/770,000토큰에서 2,201요청/770,350토큰으로 정확히 증가했다.

또한 설치 스냅샷의 parser 12와 현재 빌드의 parser 13이 다르다. 현재 빌드로 다음 refresh를 실행하면 unchanged 파일도 버전 차이 때문에 다시 읽는 대상이다. 스킬 수집을 다시 켜면서 `capabilities_collected=0`인 파일을 복원하는 경우도 전체 재처리가 필요할 수 있다.

### 개선 우선순위

현재 parser 13의 요청 제목 집계에서 반복 탐색을 재현했다. 약 0.8 MB, 2,000요청의 단일 합성 세션은 전체 3.320초 중 파싱 0.123초, committing 3.190초였다. `component_events`는 원래 이벤트 테이블에서 복사되지만 원래의 root 인덱스는 승계하지 않는다. 제목 상관 서브쿼리가 각 요청마다 이벤트를 다시 탐색하고 정렬했다.

제품 코드를 수정하지 않고 격리 실험에서 TEMP 인덱스만 추가했다. 각 조건 3회 교차 실행 중앙값은 아래와 같으며, 2,000요청·700,000토큰을 모두 확인했다.

| 조건 | 전체 refresh | prepareSummaries |
|---|---:|---:|
| 기존 | 3.320초 | 2.712초 |
| `component_events(root_id,is_main,id)` | 0.808초 | 0.163초 |

전체는 약 4.11배, 제목을 포함하는 요약 준비는 약 16.6배 개선됐다. `EXPLAIN`도 전체 index scan과 임시 정렬에서 root 검색으로 바뀌었다. 이 결과는 현재 작업 중인 parser 13의 제목 기능에 대한 것이며, 제목이 없는 설치 parser 12의 지연을 전부 설명하지는 않는다.

후속 비교에서는 아래 partial index가 같은 목적을 더 적은 공간으로 처리했다.

```sql
CREATE INDEX temp.component_request_title
ON component_events(root_id, id)
WHERE is_main = 1 AND request_title IS NOT NULL;
```

| 인덱스 | 대상 이벤트 | TEMP 할당 공간 | 생성 중앙값 | 전체 refresh 중앙값 |
|---|---:|---:|---:|---:|
| 전체 root 인덱스 | 6,000행 | 132 KiB | 2.211ms | 0.700초 |
| 제목 partial index | 2,000행 | 44 KiB | 1.166ms | 0.694초 |

별도의 3회 교차 비교라 앞 표의 refresh 절대값과 직접 연결하지 않는다. 두 인덱스의 처리 시간 차이는 작았고, partial은 페이지를 약 67% 줄였다. 이 비용은 영속 DB에 계속 남는 공간이 아니라 해당 component를 처리하는 TEMP 공간이다. partial index의 일반 원리는 [SQLite Partial Indexes](https://www.sqlite.org/partialindex.html)를 참고할 수 있다.

1. **현재 제목 집계에 맞는 TEMP partial index 또는 root별 사전 집계를 적용하기.** 확인한 큰 세션의 반복 스캔을 우선 제거한다. 여러 파일·provider·lineage를 포함한 제목 선택의 결과와 null 제목을 검증해야 한다.
2. **바이트별 reader를 연속 buffer 처리로 바꾸기.** 일반 JSONL에서 native 줄 탐색과 연속 영역 복사를 사용하고, 이미지 제거가 필요한 경우에는 현재 문자열 상태와 검증을 유지한다. 전체 파일을 문자열로 읽는 방식은 큰 이미지·메모리 상한과 충돌한다. 줄 budget, escaped image, UTF-8 경계, 잘못된 JSON, 부분 줄, 파일 교체·truncate·취소가 동등해야 한다.
3. **변경 파일 내부의 증분 처리를 설계하기.** 마지막 완전한 줄의 offset만 저장해서는 부족하다. active root/turn, 모델·billing, 누적 토큰 high-water, 중복 응답 식별자, fork·부모 관계 등의 상태도 필요하다. 본문 없이 정규화 이벤트를 파일별 캐시하면 재사용할 수 있지만 저장 비용이 증가한다. rewrite·truncate·parser 변경에서는 전체 재처리로 돌아가야 한다.
4. **독립 파일 읽기·정규화를 제한된 수의 worker로 병렬 처리하기.** 두 worker부터 실제 처리량·메모리·SQLite 대기를 비교한다. lineage 정합성 확인과 영속 writer는 조율해야 한다. 동기 SQLite writer를 여러 개 추가한다고 쓰기 처리량이 비례하지 않는다.
5. **native SIMD parser는 위 단계 뒤 검토하기.** native 배포·Electron 호환·이미지 budget 의미 보존 비용이 있다. 현재 `JSON.parse`만 교체해서 전체 13초가 모두 없어지는 구조는 아니다.

### 파싱 레퍼런스

- [Claude session parser](https://github.com/sevenevesai/claude-session-parser): 같은 Claude JSONL의 bounded streaming과 응답 중복 제거를 다루는 Rust 구현. 파일 변경 감지·캐시는 별도 계층으로 둔다. 실제 속도가 Agent Tracker보다 빠르다는 비교 결과는 아니다.
- [File parse cache](https://github.com/sevenevesai/file-parse-cache): mtime·content hash를 기준으로 재파싱을 제한하는 구현. Agent Tracker의 unchanged manifest 재사용은 이미 같은 방향이며, 추가분 파싱은 그보다 많은 상태가 필요하다.
- [Node Buffer.indexOf와 subarray](https://nodejs.org/api/buffer.html): native byte 검색과 연속 buffer 영역 처리의 API 근거.
- [Node worker_threads](https://nodejs.org/api/worker_threads.html): CPU 작업을 worker pool로 나누고 worker 생성 비용을 줄이는 지침. I/O와 CPU 병렬화를 구별해야 한다.
- [simdjson iterate_many 설계](https://github.com/simdjson/simdjson/blob/master/doc/iterate_many.md): JSONL을 parser 재사용·배치·SIMD로 처리하며 문서별 할당 비용을 줄이는 참고 구현. Node에서 바로 같은 배수를 얻는다는 의미는 아니다.

## 3. 스킬 로그의 저장과 통계

### 실제 SQL 저장 구조

[schema.ts](../src/summary/db/schema.ts)의 `turn_capability_usage`에 다음 네 값이 저장된다.

```sql
turn_id, category, name, usage_count
PRIMARY KEY(turn_id, category, name) WITHOUT ROWID
```

category는 `skill`, `subagent`, `plugin`, `model`이다. 원본 툴 명령과 응답, 스킬 파일 전문은 이 테이블에 저장하지 않는다. 요청 요약이 삭제되면 foreign key cascade로 횟수도 삭제된다.

[capabilities.ts](../src/summary/parsers/capabilities.ts)는 다음 신호를 수집한다.

| 종류 | 탐지 기준 |
|---|---|
| skill | Claude `Skill` 호출, 읽기 툴·쉘 명령의 `SKILL.md` 경로 |
| subagent | `spawn_agent`, `Task`, `Agent` 호출. 종류 필드가 없으면 `default` |
| plugin | `mcp__server__tool`의 server 부분, plugin 경로 또는 skill 접두사 |
| model | 중복 제거를 통과한 모델 응답/사용량 이벤트 수 |

Codex `exec` 안의 정적 `tools.xxx(...)`도 탐색한다. 문자열과 주석은 건너뛰며 코드를 실행하지 않는다. 툴 호출 ID와 wrapper 내 index를 사용해 중복 이벤트를 제거하고, 요청별·종류별·이름별 횟수로 압축한다. 모델 횟수는 요청 수·토큰 수와 다른 단위다. fork의 검증된 복사 이력도 중복 제거한다. 근거: [staging.ts](../src/summary/staging.ts)의 capability winners와 capabilityUsage.

### 통계 계산

[queryCapabilities](../src/summary/db/index.ts)는 요청 요약과 capability 테이블을 JOIN하고 provider·프로젝트·세션·요청 시작 날짜 등의 filter를 적용한다. `GROUP BY provider,name`, `SUM(usage_count)`로 순위를 구하고 아래 식으로 비율을 계산한다.

`percentage = 해당 provider·이름의 횟수 / 필터 범위의 해당 category 전체 횟수 × 100`

두 provider를 함께 선택하면 분모도 둘을 포함한다. 100개씩 페이지를 넘겨도 분모는 전체 범위를 유지한다. 표시 막대 길이는 최다 사용 대비 비율이고, 숫자 percentage는 전체 횟수 대비 비율이다. 날짜는 개별 툴 호출 시각이 아니라 그 요청의 `started_at_ms`다.

스냅샷에서 236개 파일 모두 `capabilities_collected=1`, parser 12, done이었다. 이는 이전 parser가 수집을 수행했다는 상태이며 모든 실제 사용을 빠짐없이 탐지했다는 증명은 아니다.

| 저장된 횟수 | Claude | Codex |
|---|---:|---:|
| skill | 9 | 252 |
| subagent | 5 | 108 |
| plugin | 0 | 21 |
| model 응답 | 726 | 6,957 |

### 확인한 부채와 개선 제안

현재 스킬 횟수의 의미는 **명시 호출과 스킬 문서 읽기로 탐지된 횟수**다. 성공 여부나 실제 지침 준수는 확인하지 않는다. 문서가 이미 문맥에 있어 다시 읽지 않는 사용도 잡을 수 없다. Claude 공식 문서는 호출 뒤 스킬 내용이 문맥에 남고, 서브에이전트에는 사전 주입될 수도 있다고 설명한다. [Claude skill lifecycle](https://code.claude.com/docs/en/skills#skill-content-lifecycle), [invocation과 context loading](https://code.claude.com/docs/en/skills#control-who-invokes-a-skill).

현재 빌드의 detector를 직접 실행해 다음 한계를 재현했다. 아래 명령 문자열은 synthetic 예시이며 실행하지 않았다.

| 예시 | 현재 탐지 | 문제 |
|---|---|---|
| `cat README.md; echo '/skills/commit/SKILL.md'` | commit 1회 | 읽기 명령이 다른 파일을 읽어도 전체 명령의 경로를 skill로 과탐지 |
| 변수로 구성한 `cat` 경로 | 0회 | 정적 리터럴만 보는 방식의 누락 |
| 같은 읽기 호출을 3번 실행하는 loop | 1회 | 정적 호출 지점과 실제 실행 횟수의 차이 |
| task 이름·model만 있는 `spawn_agent` | subagent `default` | 현재 표는 task/model별 분류를 표현하지 않음 |

우선 화면에 집계 정의를 짧게 설명하고, 명시 호출·문서 읽기·wrapper 추론을 `source_kind` 등으로 구분하는 것을 제안한다. 읽기 명령은 실제 명령과 인자의 관계를 파악해 compound command의 과탐지를 줄일 수 있다. 임의 JS·쉘을 평가해서 동적 횟수를 추정하는 방식은 사용할 이유가 없다.

성공 횟수가 필요하면 tool result와 호출 ID를 연결해야 한다. 검증 가능한 최소 근거로 file ID·offset·정규화 이벤트 ID·탐지 종류를 남기면 재확인이 쉬워지지만, 현재 요청별 압축 테이블보다 저장 비용이 늘어난다. 명령·본문 저장은 필요 없다.

MCP server 이름과 설치 plugin 이름이 항상 같다는 보장은 없으므로 표시 명칭과 정규화 규칙도 구분할 필요가 있다. 비율 분모, 요청 시작일 기준, 모델 응답 수라는 단위를 설명하면 현재 숫자를 잘못 해석할 가능성을 줄일 수 있다.

스킬 조회의 성능은 현재 923개 집계 행 규모에서 우선순위가 낮다. 먼저 탐지 정의·근거와 과탐지를 개선하고, 이후 실제 행 수·조회 빈도에 따라 category covering index나 category별 반복 집계 재사용을 검토하는 편이 타당하다.

## 검증과 후속 작업 경계

영속 DB 인덱스 비교, 실제 파싱 단계별 측정, 합성 unchanged/append의 요청·토큰 합계, 스킬 detector 최소 재현을 수행했다. 파싱 빌드의 타입 컴파일은 성공했다. 제안은 제품에 적용하지 않았고 실험 native reader의 이미지·오류·메모리 동등성 검증도 수행하지 않았다.

이 조사에서 추가한 것은 문서와 측정 결과다. 기능 동작을 바꾸지 않았으므로 의사결정 일지와 설계 명세를 변경하지 않는다. 구현을 진행할 때는 해당 동작의 검증과 `npm run check`, 일지·명세 갱신이 필요하다.

## 요청 제목 집계 A/B 후속 검증

TEMP partial index와 기존 `roots GROUP BY`에 제목 선택을 합치는 두 로직은 재실행 가능한 `node:test`와 별도 벤치마크로 비교한다. 같은 2,000개 요청에 대해 전체 결과의 동등성을 확인하고, 생성 비용을 포함한 SQL 집계 시간·TEMP 할당·process RSS를 기록한다. 배치 구조·측정 조건·원시 기록은 [요청 제목 A/B 보고서](RequestTitleAB.md)를 참고한다. 이 비교도 제품 구현을 변경하지 않는다.

사용자 선택에 따라 이후 제품에 A(TEMP partial index)를 반영했다. 선택 근거와 현재 schema/parser의 같은 실제 원본 사본으로 측정한 무인덱스 대비 집계 준비·영속 교체 transaction·전체 갱신 결과는 [실제 transaction 보고서](RequestTitleTransactions.md)에 기록한다. 앞선 후보 비교와 과거 조사 수치는 당시 조건의 기록으로 보존한다.
