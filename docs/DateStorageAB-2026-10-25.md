# 날짜 저장 순서·인덱스·SQL A/B 분석

2026-10-25, Asia/Seoul. 기준 소스 `d8ef1bdb6fd93ecad56019b5df836174da636002`, schema 13. 세 서브에이전트가 요청 저장, 일별 집계 키, SQL 조건을 나누어 조사·구현했고 성능 측정은 한 종류씩 실행했다. 제품 기능 변경에 앞선 후보 비교이며 측정용 코드와 보고서에 한정한다.

## 현재 문제와 판단 기준

요청 facts는 이미 `turn_summary(started_at_ms, provider)`와 `(provider, project_key, started_at_ms)` 인덱스를 갖는다. 날짜 인덱스가 없는 구조는 아니다. `id INTEGER PRIMARY KEY`가 테이블의 rowid이므로 기존 id를 보존한 채 INSERT 순서만 날짜순으로 바꾸어도 테이블의 논리적인 키 순서는 id다. 인덱스는 날짜순 키를 유지하는 별도 B-tree다. 날짜순 입력은 페이지 분할·빈 공간·정렬 비용을 바꿀 수 있지만 날짜 clustering이나 공간 절약을 보장하지 않는다. [SQLite Query Planning](https://www.sqlite.org/queryplanner.html), [Rowid Tables](https://www.sqlite.org/rowidtable.html).

일별 집계는 `WITHOUT ROWID`이며 기본 키가 `(provider, session_id, project_key, local_day[, model_key])`다. 이 기본 키는 세션별 교체에 맞고, 기간 조회는 별도 `(local_day, provider)` 인덱스를 사용한다. 날짜를 기본 키 앞으로 옮기면 집계 상태 자체를 날짜 범위에서 읽을 수 있지만, 세션별 삭제·재구축과 세션 시작 시각 탐색에는 별도 인덱스가 필요할 수 있다. 보조 인덱스에는 기본 키의 나머지 열도 들어가므로 날짜 인덱스 하나를 없앤 공간을 그대로 순절감으로 계산하면 안 된다. [WITHOUT ROWID](https://www.sqlite.org/withoutrowid.html), [Index B-trees](https://www.sqlite.org/fileformat2.html#representation_of_without_rowid_tables).

실제 화면의 요청 정렬은 시각 미상 후순위 식과 시작 시각 내림차순, provider, id를 조합한다. 단순 `(provider, started_at_ms)` 추가만으로 이 ORDER BY가 충족되지는 않는다. 날짜 범위를 찾는 인덱스와 최종 표시 순서를 충족하는 인덱스는 역할이 다르다. 집계 후 토큰·평균·모델순 정렬도 별도 비용이다. [Expression Indexes](https://www.sqlite.org/expridx.html), [ORDER BY Optimization](https://www.sqlite.org/optoverview.html#order_by_optimizations).

원본 요청 id를 날짜에 맞춰 다시 부여하는 방식은 실험 후보에서 제외했다. 모델·비용·Skill·진단 참조와 내부 id cursor의 의미까지 바꾸며, 세션 교체와 과거 날짜 수정 때 날짜순 id를 지속 유지할 수 있는 별도 설계가 필요하다.

## 설치 DB의 현재 규모

[읽기 전용 프로필](benchmarks/DateStorageProfile-2026-10-25.json)은 하나의 읽기 트랜잭션으로 수집했다. 설치 DB는 schema 12이고 실험은 현재 소스의 schema 13이다. 설치 DB의 migration·쓰기·원본 로그 읽기는 수행하지 않았다.

| 항목 | 관측값 |
|---|---:|
| DB 할당 공간 | 1,609,728 B, 약 1.54 MiB |
| 요청 / 모델 facts / 세션 | 1,100 / 918 / 368 |
| 요청 / 모델 일별 집계 행 | 419 / 502 |
| 시작 시각 미상 요청 | 35 |
| 일별 집계 보조 인덱스 4개 합계 | 245,760 B, 240 KiB |
| 두 일별 집계 테이블 본체 합계 | 249,856 B, 244 KiB |

현 규모에서 절감 가능한 절대 용량은 작다. 10만 행 실험은 확장 시의 경향을 보기 위한 합성 데이터이며 사용자의 실제 분포나 실제 화면 시간을 대신하지 않는다.

## 측정 방법

- Windows x64, Node 24.14.1, SQLite 3.51.2. CPU·각 런타임과 샘플은 JSON에 보존했다. 이전 성능 보고서의 SQLite 3.53.3 수치와 직접 연결하지 않는다.
- 각 후보에 같은 fixture를 사용하고 1,000 / 100,000 요청에서 3회 준비, 9개 교차 표본을 측정했다. raw·정렬 실험은 세션당 100요청, SQL 실험은 10요청, 집계 키 실험은 10 / 100요청이다. **같은 실험 안에서만 A/B 절대 시간을 비교한다.**
- raw·집계 키·정렬 실험은 공개 DB API, SQL 조건 실험은 준비된 rows+count+SAVEPOINT를 측정한다. SQL 조건 실험은 SQL 생성·prepare·rollup 준비를 제외하므로 공개 API 시간과 동일하지 않다.
- 모든 그룹·첫 페이지·개수와 변경 후 결과를 비교했다. 정수·문자열·null은 정확 일치, 평균은 기존 helper의 상대/절대 `1e-9` 허용오차를 사용한다. 집계 키는 독립 raw oracle도 비교한다. digest만으로 정확성을 대신하지 않는다.
- 조회는 warm cache 결과다. OS cache를 비운 디스크 I/O, worker IPC, UI 렌더링, 실제 JSONL 파싱 시간은 포함하지 않는다. SQLite `dbstat` live 페이지와 할당·free 페이지를 구분하고 WAL은 별도 측정한다. RSS·최대 TEMP scratch는 측정하지 않았다.
- P10/P90은 9표본의 관측 분포이며 신뢰구간이 아니다. 동일 SQL 대조군의 약 5~8% 변동도 관측되어 작은 차이는 확정 개선으로 해석하지 않는다. 각 실험의 `ANALYZE`는 후보에 동일하게 적용한 통제 조건이다. 제품의 주기적인 `PRAGMA optimize`만으로 모든 설치 DB가 같은 계획을 택한다는 뜻은 아니다. [SQLite ANALYZE 권고](https://www.sqlite.org/lang_analyze.html).

## 요청 facts의 저장·인덱스 비교

[원시 측정](benchmarks/DateStorageRaw-2026-10-25.json), [재현 코드](../tests/benchmarks/date-storage-raw.cjs). 정상 일별 rollup을 사용하는 경로와 분리해 최신 요청 및 비용 포함 raw fallback을 측정했다.

10만 요청, 중앙값:

| 후보 | live DB 공간 | 재입력 transaction | 대표 읽기 결과 |
|---|---:|---:|---|
| A 현재 | 30,920,704 B | 667.31 ms | 최신 전체 49.74 ms |
| B 날짜순 INSERT, 기존 id 보존 | 32,612,352 B, **+5.47%** | 802.78 ms, **+20.3%** | 최신 전체 51.64 ms |
| C `(provider, started_at_ms)` 추가 | 33,267,712 B, **+7.59%** | 766.96 ms, **+14.9%** | 최신 provider 26.03 → 25.32 ms, 작은 차이 |
| D 기존 날짜 인덱스를 `(started_at_ms)`로 축소 | 30,212,096 B, **−2.29%** | 626.24 ms, −6.15% | 7일 비용 집계 64.41 → 72.55 ms, **+12.63%** |

B는 1천 요청에서도 공간이 405,504 → 425,984 B로 증가했다. 기존 id를 유지하므로 논리적인 날짜 clustering이 생기지 않았고 재입력에는 날짜 정렬 비용도 포함된다. 단순 날짜순 INSERT는 권하지 않는다.

C의 최신 요청 SQL은 여전히 `USE TEMP B-TREE FOR ORDER BY`를 사용했고 추가 인덱스는 주로 count에 쓰였다. 저장·입력 비용 증가를 정당화할 읽기 이득을 확인하지 못했다.

D는 날짜 인덱스 자체를 2,334,720 → 1,626,112 B로 줄였다. 대신 날짜 범위의 provider count가 covering index를 잃어 테이블을 다시 읽었고 비용 포함 7일 집계가 느려졌다. 공간만 보고 채택하기에는 회귀가 있다. 공개 `replaceSessions` 100요청 갱신은 A 3.88 → D 3.60 ms였으며, 이 측정은 rollup 미구축 상태다.

## 일별 집계의 기본 키 비교

[원시 측정](benchmarks/DateStorageRollup-2026-10-25.json), [재현 코드](../tests/benchmarks/date-storage-rollup.cjs). 날짜를 맨 앞에 둔 PK는 아래 정확성 문제로 제외했다. 성능 비교는 통과한 `(provider, local_day, session_id, project_key[, model_key])`를 대상으로 한다. B는 기존 day 인덱스를 제거하고 project-day 인덱스를 유지하며, C는 여기에 `(provider, session_id)` 인덱스를 추가한다.

10만 요청·세션당 10요청:

| 항목 | A 현재 세션 우선 PK | B 제공자·날짜 PK | C B + 세션 인덱스 |
|---|---:|---:|---:|
| 집계 본체+집계 인덱스 live 공간 | 11,526,144 B | **9,224,192 B, −20.0%** | 11,538,432 B, +0.11% |
| 전체 DB live 공간 | 41,242,624 B | 38,940,672 B, **−5.58%** | 41,254,912 B |
| 완전한 날짜 7일, 모델별 | 6.03 ms | **3.66 ms, −39.2%** | **3.58 ms, −40.6%** |
| 전체 세션, 모델별 첫 페이지+개수 | 106.34 ms | 127.88 ms | 108.99 ms |
| 단일 세션 provider 조회 | 0.332 ms | 0.584 ms | 0.331 ms |
| 세션 1개 교체 transaction | 1.67 ms | **13.85 ms, 8.32배** | 1.70 ms |
| 세션 1개 삭제 transaction | 1.53 ms | **15.87 ms, 10.40배** | 1.69 ms |

집계 표만 20% 절약하는 값과 전체 DB 5.58% 절약하는 값을 구분해야 한다. 변경 세션을 찾는 기존 PK prefix를 잃으면 삭제·교체가 넓은 범위를 훑는다. 세션 보완 인덱스는 이를 회복하지만 day 인덱스 제거로 얻은 공간을 사실상 다시 사용한다. 날짜 정렬 범위에서 표 본체를 직접 읽는 이득은 남으므로 C는 **읽기 성능 후보**이며 저장 절감 후보로 분류하지 않는다.

작은 1천 요청·세션당 10요청에서는 B 집계 공간이 143,360 → 110,592 B, C는 143,360 B였다. 10만 요청·세션당 100요청에서는 B의 집계 공간이 19.96% 줄어도 전체 DB 절감은 1.36%였다. C의 완전한 7일 모델 조회는 1.398 → 1.087 ms, 22.2% 줄었고 집계 공간은 0.19% 늘었다. 세션 수와 일별 상태 수가 달라지면 비율도 달라진다. 각 후보의 최초 구축·추가 요청·과거 날짜 수정·삭제도 원시 JSON에 구분한다.

## SQL 날짜 조건 비교

[원시 측정](benchmarks/DateStorageQuery-2026-10-25.json), [상세 분석](research/DateStorageQueryNotes.md), [재현 코드](../tests/benchmarks/date-storage-query.cjs).

A는 현행 `(날짜 범위 OR local_day='')`, B는 서로소 `UNION ALL`, C는 무기간·시각미상만 조건을 특수화하고 나머지는 UNION으로 분리한다.

| 10만 요청의 조회 | A 현재 | B 범용 UNION | C 조건 특수화 |
|---|---:|---:|---:|
| 전체 일별 provider | 21.17 ms | 30.29 ms, **43.1% 느림** | 21.12 ms |
| 전체 모델 합계 | 63.31 ms | 83.52 ms, **31.9% 느림** | 60.64 ms |
| 7일 모델별 | 25.41 ms | 23.22 ms | 24.21 ms |
| 프로젝트 7일 모델별 | 0.337 ms | 0.378 ms | 0.373 ms |
| 시각 미상만, 내부 DB API | 15.79 ms | 7.77 ms | **4.31 ms, 72.7% 감소** |

주간 A는 이미 `MULTI-INDEX OR`로 날짜 범위와 시각 미상을 각각 인덱싱한다. UNION으로 나누면 compound subquery·외부 집계 비용이 늘 수 있다. 범용 치환은 권하지 않는다. [OR Optimization](https://www.sqlite.org/optoverview.html#or_optimizations), [Subquery Flattening](https://www.sqlite.org/optoverview.html#subquery_flattening).

72.7%는 현재 UI에서 받지 않는 `unknownTime:'only'` 내부 DB API 조건이다. 이때 `(0=1 OR local_day='')`를 `local_day=''`로 단순화하면 provider 전체 탐색에서 날짜 인덱스 직접 탐색으로 바뀐다. 추가 영속 공간이 없는 조건부 개선 후보지만 일반 사용자 화면 개선율로 제시할 수 없다. 일반 UI 주요 경로의 1~9% 차이는 대조군 변동과 함께 보아야 한다.

## 실제 최신 요청 정렬 비교

[원시 측정](benchmarks/DateStorageOrder-2026-10-25.json), [재현 코드](../tests/benchmarks/date-storage-order.cjs). 기존 인덱스를 유지하고 현재 UI의 provider별 최신 요청 ORDER BY와 맞는 표현식 인덱스를 하나 추가했다.

```sql
CREATE INDEX bench_summary_ui_date_order ON turn_summary(
  (started_at_ms IS NULL), (started_at_ms IS NULL),
  started_at_ms DESC, provider
);
```

현재 SQL이 미상 후순위 식과 선택 열의 null 후순위 식을 각각 생성해 같은 식이 두 번 나온다. probe에서 null 식 하나의 인덱스는 TEMP 정렬을 없애지 못했고 위 키는 없앴다. 마지막 id ASC는 secondary index의 암묵적 rowid가 충족해 명시적인 id를 생략했다. 이는 **현행 SQL을 그대로 비교하기 위한 후보**다. 실제 도입 시 중복 정렬식을 정리하고 더 짧은 키로 같은 정합성과 계획을 재검증하는 편이 낫다. 중복 제거 후 인덱스 성능은 이번에 측정하지 않았다.

| 10만 요청 공개 API | A 현재 | B 정렬 표현식 인덱스 추가 | 판단 |
|---|---:|---:|---|
| 최신 전체, provider 기준 | 45.66 ms | **6.51 ms, 85.7% 감소·7.01배** | TEMP ORDER BY 제거 |
| 최근 7일, provider 기준 | 5.77 ms | **0.73 ms, 87.4% 감소·7.91배** | TEMP ORDER BY 제거 |
| 최신 Claude만 | 20.25 ms | 20.41 ms | 같은 기존 join 계획, 개선 없음 |
| 최신 전체, model 기준 | 96.84 ms | 96.79 ms | 모델 미상 정렬까지 충족하지 못함 |
| 최근 7일, model 기준 | 10.34 ms | 10.29 ms | 변동 수준 |

live 공간은 30,924,800 → 33,255,424 B, **+2,330,624 B·7.54%**다. 100요청의 공개 `replaceSessions`는 3.36 → 3.80 ms, **+0.43 ms·12.9%**였고 WAL 길이는 135,992 → 177,192 B였다. rollup 미구축 상태의 쓰기 실험이며 WAL 길이는 물리적 디스크 쓰기량이 아니다.

1천 요청의 최신 전체는 1.54 → 0.49 ms, 68.4% 줄었다. 현재 설치 규모에서는 절대 이득이 약 1ms 수준일 수 있으며 실제 설치 데이터의 동일 개선율을 측정한 것은 아니다. 깊은 OFFSET, 다른 헤더 정렬, 실제 provider 분포, cold cache에서는 추가 대조가 필요하다. 이 후보는 저장 절감 목적보다 **10만 요청 이상의 provider 기준 최신 목록 지연 개선 목적**에 맞는다.

## 날짜 선두 PK에서 발견한 정확성 문제

[최소 재현](../tests/benchmarks/date-storage-sqlite-repro.cjs), [Node 관측 결과](benchmarks/DateStorageSqliteRepro-2026-10-25.json), [설치 VS Code 런타임 관측 결과](benchmarks/DateStorageSqliteReproVSCode-2026-10-25.json).

SQLite 3.51.2에서 날짜 선두 `WITHOUT ROWID` PK, `provider IN (...)`, `(날짜 범위 OR local_day='')`의 조합이 PK의 `MULTI-INDEX OR` 계획을 택하면 시각 미상 행이 누락됐다. 제품 코드 없이 5컬럼 메모리 DB와 독립 JS raw oracle로 재현했으며 `integrity_check`는 정상이다. secondary index 강제 또는 서로소 UNION은 oracle와 일치했다. 해당 후보는 성능 개선율과 무관하게 제외했다.

설치 VS Code의 Node 24.21.0 / SQLite 3.53.4에서도 같은 최소 재현의 OR 결과가 6그룹, 독립 oracle·secondary·UNION이 7그룹이었다. 성능 수치는 Node 24.14.1 / SQLite 3.51.2에서 측정했으며 VS Code에서는 이 정확성 재현만 교차 확인했다.

특정 upstream 이슈·수정 버전과 연결한 증거가 없어 모든 SQLite 버전의 문제로 일반화하지 않는다. 현재 제품의 세션 선두 PK에서 같은 누락을 관측했다는 뜻도 아니다.

## 권장 방향과 검증

1. **저장량이 우선이면 현재 구조를 유지한다.** 단순 날짜순 INSERT는 공간·입력이 악화됐다. 날짜 단독 인덱스는 전체 DB 2.29% 절감과 조회 회귀를 맞바꾼다. 제공자·날짜 집계 PK는 전체 5.58% 절감 대신 세션 변경을 8~10배 느리게 했다. 현재 설치 DB 1.54 MiB에 곧바로 schema 변경을 적용할 근거는 약하다.
2. **일별 모델 조회가 병목이면 제공자·날짜 집계 PK와 세션 인덱스 조합을 검토한다.** 완전한 7일 모델 조회는 40.6% 줄고 세션 갱신은 현재 수준이지만 저장 절감은 없다. 전체 세션·모델 조회까지 일괄 개선되는 방식은 아니다.
3. **큰 DB의 provider 기준 최신 요청 화면이 병목이면 정렬 표현식 인덱스가 가장 큰 읽기 이득이다.** 측정한 최신 전체 85.7%, 7일 87.4% 감소는 추가 공간 2.22 MiB·쓰기 약 0.43ms와 함께 판단한다. Claude만·모델별 조회에는 같은 효과가 없었다.
4. 범용 OR→UNION 변경과 날짜 맨 앞 PK 변경은 채택하지 않는다. 전자는 주요 경로가 느려지고 후자는 두 SQLite 런타임에서 정확성을 통과하지 못했다. 내부 미상 시각 전용 조건의 특수화는 향후 사용될 때 별도 작은 후보로 남긴다.

실험용 스크립트·집계 프로필·보고서만 추가했다. 제품 `src`, 영속 schema·migration, 설치 DB의 기능 동작은 변경하지 않았으므로 설계 명세와 기능 의사결정 일지에 새 기능 항목을 만들지 않는다. 후보별 실행·전체 결과 대조와 `npm run check`의 타입 검사·린트·360개 테스트를 통과했다. 실험 스크립트 6개의 구문, 문서 6개의 링크·공백, JSON 7개도 확인했다. 실제 VS Code UI의 성능 측정은 수행하지 않았다.

집계 키 실험 첫 실행을 중단하기 직전 완료된 3개 dataset은 보존했고, 마지막 10만 요청·세션당 100요청 dataset만 같은 코드·설정으로 이어 실행해 합쳤다. 모든 dataset의 준비 3회·측정 9회는 유지했다. 중단된 실행의 합성 임시 DB 폴더 `agent-tracker-date-rollup-lwT5XU`는 삭제 시도가 자동 승인 검토에서 `blocked by policy`로 차단되어 OS Temp에 남았다. 더 구체적인 거절 사유는 제공되지 않았다. 저장된 보고서와 운영 DB에는 영향이 없다.

## 재현

현재 소스를 먼저 컴파일한 뒤 저장소 루트에서 실행한다. 아래 스크립트는 fixture DB를 OS 임시 디렉터리에서 생성·정리한다. 프로필 스크립트만 설치 DB에 읽기 전용으로 연결한다.

```powershell
node tests/benchmarks/date-storage-profile.cjs
node tests/benchmarks/date-storage-raw.cjs
node tests/benchmarks/date-storage-rollup.cjs
node tests/benchmarks/date-storage-query.cjs
node tests/benchmarks/date-storage-order.cjs
node tests/benchmarks/date-storage-sqlite-repro.cjs
```

각 측정의 `--output=`으로 출력 위치를 바꿀 수 있다. 프로필에는 `--db=`를 지정할 수 있으며 내용을 출력하지 않고 집계 수치와 스키마 인덱스만 보존한다. 성능 실험은 동시에 실행하지 않는다.
