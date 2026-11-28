# 사용량 SQLite 테이블

현재 스키마는 v32이며 제품 테이블은 7개다. 확장은 VS Code의 확장 전역 저장 디렉터리에 `agent-tracker.sqlite`를 열고, 로컬 대화의 **일별 합계**와 원본 상태를 저장한다. 대화와 응답 단위 값은 수집 중 메모리에서 계산한다. [DB 경로](../../src/app.ts) · [스키마](../../src/summary/db/schema.ts) · [일별 테이블 정의](../../src/summary/db/rollup-state.ts)

## 현재 테이블

| 테이블 | 행을 구분하는 키 | 저장하는 값과 사용처 |
| --- | --- | --- |
| `source_file` | 기본 키 `id`, 고유 키 `(provider, path)` | 원본 경로, 세션·스레드 ID, 마지막 정상 반영 수정 시각과 파서 버전, Skill 수집 여부, 소실 및 처리 상태를 보관한다. |
| `projects` | `project_key` | 프로젝트 표시 이름. |
| `sessions` | `(provider, session_id)` | 제공자별 세션 표시 이름과 사용자가 지정한 구독·API·미상 결제 유형. `billing_mode`가 NULL이면 집계의 기본 결제 유형을 사용한다. |
| `usage_rollup_meta` | `singleton = 1` | 일별 집계 기준 시간대와 형식 버전. |
| `usage_request_daily` | `(provider, session_id, project_key, local_day)` | 대화 사용량을 날짜별로 합친 결과. 토큰·비용, 전체·완료 표본 수, 시간 합계·표본 수와 세션 시작을 구하는 최소 시각을 보관한다. |
| `usage_model_daily` | 위 일별 키 + `model_key` | 같은 범위의 모델별 사용량·표본·비용. 조회 시 `model_key`에서 모델명을 복원한다. `N`은 NULL, `V`는 빈 이름이고, 이름이 있으면 `V` 뒤에 붙는다. |
| `usage_capability_daily` | 위 일별 키 + `category`, `name` | 스킬·서브에이전트·플러그인·모델 횟수. 새 키와 횟수가 달라진 행을 쓰고 토큰 행과 같은 교체 범위에서 사라진 키를 삭제한다. |

`local_day`는 통계 시간대의 날짜다. 대화 시작 시각을 날짜로 바꾸며, 시각 미상은 빈 문자열로 저장한다. 제공자·모델 일별 테이블에 평균을 위한 합계와 표본 수를 저장한다. [일별 입력](../../src/summary/db/dailyFacts.ts) · [일별 그룹 키와 날짜](../../src/summary/db/queries/rollup/source.ts)

두 일별 사용량 테이블은 각각 41열이다. 조회 시 전체·완료 토큰 합계는 입력과 출력의 합으로, 소요 시간 누락 건수는 완료 건수에서 기록된 시간의 건수를 빼서 구한다. 사용량이 기록된 완료 표본은 완료 전체의 입력·출력 토큰 합계를 공유하고, 평균에는 각 표본의 건수를 사용한다. [집계 수식](../../src/summary/db/queries/rollup/metrics.ts)

## 저장·소실·이관

- 갱신은 영향 세션의 대화 결과를 제공자·모델·Skill별 일별 행으로 반영하고, 교체 범위에서 새 결과에 없는 기존 키를 삭제한다. 원본 상태·이름과 일별 데이터는 같은 쓰기 트랜잭션에서 확정한다. [저장 트랜잭션](../../src/summary/db/memoryStore/index.ts) · [일별 교체](../../src/summary/db/rollups.ts)
- 프로젝트 이름을 정리할 때 이전 집계에 있던 키에서 새 집계에 포함된 키를 제외한다. 남은 후보는 다른 일별 행의 참조 여부를 확인해 삭제한다. [이름 정리](../../src/summary/db/memoryStore/index.ts)
- 제공자·모델 UPSERT는 대화당 한 번 계산한 현지 날짜를 공유한다. 삭제와 삭제 키 대조는 한 번 추출한 영향 세션 목록을 이용해 세션 PK 범위로 좁힌다. 대조에는 중복을 제거한 일별 키만 바인딩하며 모델의 `NULL`과 빈 문자열은 같은 변환 규칙으로 구별한다. [일별 입력과 삭제 키](../../src/summary/db/dailyFacts.ts) · [삭제 대조](../../src/summary/db/rollups.ts)
- 보존 조건을 충족한 소실 파일은 `source_missing`으로 표시한다. 해당 세션에서는 이번에 다시 계산한 날짜만 교체 범위에 넣는다. `thread_usage` 값은 구형 세션 단위와 현재 스레드 단위의 소실 보존 기준을 구분한다. 통계 시간대가 바뀌면 읽을 수 있는 원본의 파서 버전을 초기화해 재집계 대상으로 만든다. [소실 보존 판정](../../src/summary/db/memoryStore/index.ts) · [시간대 변경과 날짜 교체 범위](../../src/summary/db/rollups.ts)
- 상세 형식의 테이블과 이전 보조 테이블은 일별 이관 후 제거된다. v29에서는 스레드 ID와 보존 플래그를 현재 열로 옮겼다. v30에서는 파일별 Skill 수집 여부를 기록하며, 읽을 수 있는 이전 파일은 파서 v26이 다시 집계한다. [스키마 이관](../../src/summary/db/migrations.ts)
- v31은 `session_billing`의 지정값을 같은 세션 행으로 옮기고, 모두 옮긴 뒤 이전 테이블을 삭제한다. 세션 이름만 갱신할 때 지정값은 보존되며 세션이 삭제되면 함께 제거된다. [스키마 이관](../../src/summary/db/migrations.ts) · [결제 조회](../../src/summary/db/billing.ts)
- v32는 두 일별 사용량 테이블에 남길 열을 같은 트랜잭션에서 새 테이블로 복사한 뒤 교체한다. 기존 일별 키와 집계값을 사용하므로 이관을 위한 원본 로그 재파싱이 필요 없다. [스키마 이관](../../src/summary/db/migrations.ts)

일별 행을 통계 화면의 표·차트로 반환하는 경로는 [SQL 조회 흐름](UsageQueryFlow.md)에 있다.
