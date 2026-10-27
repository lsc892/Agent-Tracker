# 날짜 조건 SQL 후보 실험

2026-10-25, Asia/Seoul. 제품 코드를 바꾸지 않고 현재 제품 builder가 생성한 SQL을 실험 스크립트에서 변환했다. 이 문서의 후보는 아직 제품에 반영하지 않았다.

## 현재 문제와 공식 근거

`rollup-queries.ts`의 `dailySources`는 일별 저장 상태에서 완전한 날짜를 읽고 부분 날짜만 raw facts로 보완한다. 현재 날짜 조건은 `((local_day <> '' AND 날짜범위) OR local_day = '')` 형태다. 시각 미상은 `local_day=''`로 보존된다.

[SQLite OR 최적화](https://www.sqlite.org/optoverview.html#or_optimizations)는 OR 각 가지에 인덱스를 사용할 수 있지만 비용에 따라 적용 여부를 결정한다. 따라서 OR 자체를 병목으로 단정할 수 없다. 실제 100,000행 표본의 주간 조회는 현행에서도 날짜 범위와 미상 날짜를 각각 day 인덱스로 찾았다. 반면 `unknownTime='only'`의 `((local_day <> '' AND 0 = 1) OR local_day = '')`는 모델 rollup에서 provider만 제한한 기본키 탐색을 선택했다.

[SQLite 서브쿼리 flatten 제약](https://www.sqlite.org/optoverview.html#subquery_flattening)에 따르면 외부 집계와 내부 compound SELECT의 조합에는 flatten 제한이 있다. 명시적 `UNION ALL`은 단순한 문법 정리가 아니라 실행 경로를 바꾸므로 비용을 비교해야 한다. [EXPLAIN QUERY PLAN](https://www.sqlite.org/eqp.html)의 `SEARCH`, `SCAN`, compound query와 TEMP B-tree를 보존해 근거로 삼았다. 출력 형식은 SQLite 버전에 의존한다.

## 비교 방법

`tests/benchmarks/date-storage-query.cjs`는 기존 `sql-rollup.cjs`의 동일 seed를 사용한다. 1,000/100,000 raw 요청, 세션당 10개, 90일·20개 프로젝트·제공자 2개·미상 시각·미상 모델·여러 모델·미확인 cache·실패/진행 중 표본이 포함된다. 100,000행 표본은 요청 rollup 10,991행, 모델 rollup 25,535행, 시각 미상 facts 991행이다.

| 후보 | 동작 |
|---|---|
| A `current-or` | 현행 generated SQL |
| B `disjoint-union` | 완전 날짜와 미상 날짜를 겹치지 않는 `UNION ALL`로 분리 |
| C `specialized-union` | 기간이 없으면 NOT NULL 날짜의 항진 조건을 제거, 미상만이면 `local_day=''`만 사용, 나머지는 B |

3회 준비 실행 뒤 9개 표본에서 세 후보의 실행 순서를 교대했다. 각 표본은 최초 관측 시간에 따라 1~20회 반복한 평균이다. 같은 connection에서 prepared rows+count와 SAVEPOINT 수명을 측정했으며 SQL 생성·prepare·초기 집계 구축·검증 시간은 제외했다. 전체 group/page/count를 검증하고 현재 공개 `queryUsagePage` 결과와도 대조했다. 영속 schema/index 변경은 없어서 저장 증가와 쓰기 유지비는 0이다. TEMP scratch 메모리·cold OS cache·worker/UI 왕복은 측정하지 않았다.

## 결과

100,000 raw 요청의 중앙값(ms). 원본 9개 표본·P10/P90·SQL·bindings·계획은 [측정 JSON](../benchmarks/DateStorageQuery-2026-10-25.json)에 있다.

| 조회 | A 현행 | B UNION | C 특수화 | 해석 |
|---|---:|---:|---:|---|
| 전체 기간·일별·제공자 | 21.1657 | 30.2937 | 21.1159 | B 43.1% 느림; C 차이 0.2% |
| 전체 기간·총계·모델 | 63.3068 | 83.5156 | 60.6379 | B 31.9% 느림; C 차이 4.2% |
| 최근 7일·일별·제공자 | 6.4887 | 6.4151 | 6.0569 | 작은 차이 |
| 최근 7일·일별·모델 | 25.4141 | 23.2175 | 24.2060 | 작은 차이 |
| 프로젝트·최근 7일·모델 | 0.3367 | 0.3780 | 0.3725 | B 12.3%, C 10.7% 느림 |
| 시각 미상만·모델 | 15.7921 | 7.7708 | 4.3089 | C 72.7% 감소, 3.665배 |
| 부분 날짜·제공자 | 57.4327 | 55.6859 | 55.5461 | 작은 차이 |
| 부분 날짜·모델 | 75.7552 | 71.2819 | 69.0699 | 작은 차이 |

시각 미상만 조회에서 C의 P90은 16.9132→6.6573ms였고, 계획이 `PRIMARY KEY(provider=?)`에서 `idx_usage_model_daily_day(local_day=? AND provider=?)`로 바뀌었다. 1,000행에서는 같은 후보가 0.1911→0.1665ms(12.9% 감소)였다. 개선 폭은 데이터 크기와 분포에 의존한다. `unknownTime='only'`는 내부 DB API의 진단용 실험 조건이며 현재 `src/ui/presentation.ts`의 수신 필터나 일반 사용량 UI에 노출되지 않는다. 72.7%를 현재 사용자가 사용하는 화면의 개선율로 해석할 수 없다.

날짜 미상 제외 대조군은 세 후보의 SQL이 동일한데도 100,000행 중앙값이 2.2185/2.0350/2.1107ms로 약 5~8% 흔들렸다. 따라서 일반 주간·부분 날짜의 1~9% 차이를 확정 개선으로 주장하지 않는다. B와 C가 같은 SQL을 생성하는 주간 표본 사이의 차이도 측정 변동이다.

범용 UNION 적용은 추천하지 않는다. 현재 일반 UI의 주요 조회 경로에서는 확정할 만한 큰 이득이 없으며, 주간·전체 기간은 현행 OR를 유지하는 편이 측정에 맞는다. 내부 API의 `unknownTime='only'`를 향후 사용하게 된다면 불가능한 알려진 날짜 가지를 만들지 않고 직접 equality를 생성하는 작은 특수화를 검토할 수 있다. 사용자 조회 흐름 전체의 실제 개선율은 별도 제품 경로 확인이 필요하다.

재현 명령: `node tests/benchmarks/date-storage-query.cjs`. 실행 환경: Node v24.14.1, SQLite 3.51.2, Windows x64, AMD Ryzen 5 7500F, 논리 CPU 12개. 모든 전체 group/page/count 동등성 확인과 해당 스크립트 ESLint를 통과했다.
