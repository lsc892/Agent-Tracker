# 사용량 SQLite 테이블

현재 스키마는 v29다. 확장은 VS Code의 확장 전역 저장 디렉터리에 `agent-tracker.sqlite`를 열고, 로컬 대화의 **일별 합계**와 원본 상태를 저장한다. 대화와 응답 단위 값은 수집 중 메모리에서 계산한다. [DB 경로](../../src/app.ts) · [스키마](../../src/summary/db/schema.ts) · [일별 테이블 정의](../../src/summary/db/rollup-state.ts)

## 현재 테이블

| 테이블 | 행을 구분하는 키 | 저장하는 값과 사용처 |
| --- | --- | --- |
| `source_file` | 기본 키 `id`, 고유 키 `(provider, path)` | 원본 경로와 소속 루트, 세션·스레드 ID, 마지막 정상 반영 수정 시각과 파서 버전, 소실 여부와 처리 상태·오류 위치를 보관한다. 재수집, Codex 부모 후보 탐색, 진단에 사용한다. |
| `projects` | `project_key` | 프로젝트 표시 이름. |
| `sessions` | `(provider, session_id)` | 제공자별 세션 표시 이름. |
| `session_billing` | `(provider, session_id)` | 사용자가 지정한 구독·API·미상 결제 유형. 연결된 세션이 삭제될 때 함께 제거한다. |
| `usage_rollup_meta` | `singleton = 1` | 일별 집계 기준 시간대와 형식 버전. |
| `usage_request_daily` | `(provider, session_id, project_key, local_day)` | 대화 사용량을 날짜별로 합친 결과. 토큰·비용, 전체·완료 표본 수, 시간 합계·표본 수와 세션 시작을 구하는 최소 시각을 보관한다. |
| `usage_model_daily` | 위 일별 키 + `model_key` | 같은 범위의 모델별 사용량·표본·비용. `model_key`는 모델이 `NULL`이면 `N`, 그 외에는 `V`와 모델명을 이어 만든다. |
| `usage_capability_daily` | 위 일별 키 + `category`, `name` | 이전 도구 사용량에서 이관한 스킬·서브에이전트·플러그인·모델 횟수. 도구 순위가 이 테이블을 읽으며, 현재 대화 수집의 일별 교체는 같은 범위의 기존 도구 행을 정리한다. |

`local_day`는 통계 시간대의 날짜다. 대화 시작 시각을 날짜로 바꾸며, 시각 미상은 빈 문자열로 저장한다. 제공자·모델 일별 테이블에 평균을 위한 합계와 표본 수를 저장한다. [일별 입력](../../src/summary/db/dailyFacts.ts) · [일별 그룹 키와 날짜](../../src/summary/db/queries/rollup/source.ts)

## 저장·소실·이관

- 갱신은 영향 세션의 대화 결과를 제공자·모델별 일별 행으로 반영하고, 교체 범위에서 새 결과에 없는 기존 키를 삭제한다. 원본 상태·이름과 일별 데이터는 같은 쓰기 트랜잭션에서 확정한다. [저장 트랜잭션](../../src/summary/db/memoryStore/index.ts) · [일별 교체](../../src/summary/db/rollups.ts)
- 보존 조건을 충족한 소실 파일은 `source_missing`으로 표시한다. 해당 세션에서는 이번에 다시 계산한 날짜만 교체 범위에 넣는다. `thread_usage` 값은 구형 세션 단위와 현재 스레드 단위의 소실 보존 기준을 구분한다. 통계 시간대가 바뀌면 읽을 수 있는 원본의 파서 버전을 초기화해 재집계 대상으로 만든다. [소실 보존 판정](../../src/summary/db/memoryStore/index.ts) · [시간대 변경과 날짜 교체 범위](../../src/summary/db/rollups.ts)
- 상세 형식의 `turn_summary`, `turn_model_usage`, `turn_costs`, `turn_capability_usage`는 일별 이관 후 제거된다. `applied_response` 등 이전 보조 테이블도 이때 정리한다. v29에서는 이전 `relation_meta`의 스레드 ID와 보존 플래그를 현재 열로 옮긴다. [스키마 이관](../../src/summary/db/migrations.ts)

일별 행을 통계 화면의 표·차트로 반환하는 경로는 [SQL 조회 흐름](UsageQueryFlow.md)에 있다.
