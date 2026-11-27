# Claude·Codex JSONL에서 읽는 대화·사용량 필드

파서 v26은 사용자 요청과 메인 에이전트의 응답을 하나의 대화로 묶는다. 세션은 한 채팅에서 이어진 대화의 묶음이고 프로젝트는 작업 폴더다. 로그에 기록된 작업 디렉터리 `cwd`를 사용하고, 값이 없으면 로그 위치에서 프로젝트 키를 얻는다.

| 항목 | Claude | Codex |
| --- | --- | --- |
| 세션과 스레드 | 메인 로그의 `sessionId` 또는 파일명. 서브에이전트의 세션은 `subagents/`의 상위 폴더, 스레드는 파일명으로 식별한다. | `session_meta.payload.id` 또는 사용량 행의 `thread_id`가 스레드를 식별한다. `session_id`를 세션 키로 쓰며, 값이 없으면 부모 스레드 또는 현재 스레드 식별자로 시작한다. |
| 대화 경계와 시간 | 사용자 행의 `promptId` 또는 `uuid`, 응답의 `stop_reason`, 시스템의 종료 및 `durationMs` | `root_turn_id`, `turn_id`, 사용자 메시지와 작업 시작·완료·중단 이벤트 |
| 서브에이전트 귀속 | 공유된 `promptId` 또는 도구 결과의 `toolUseResult.agentId` | 명시된 부모 대화 ID 또는 부모의 `spawn_agent` 결과에 기록된 `agent_id`·`task_name`과 자식의 스레드 ID·`agent_path` |
| 응답과 모델 | `message.id`, `requestId`, `message.model`, `message.usage` | `thread_id`, `turn_id`, `response_id`, `payload.model`, `payload.usage` |
| 토큰 누계와 fork | 응답 사용량의 입력·출력·캐시 성분 | `thread_token_usage`, `turn_token_usage`, 구형 `token_count`의 `total_token_usage`·`last_token_usage`, `forked_from_id`·`parent_thread_id` |
| Skill | `assistant.message.content`의 `tool_use` | `response_item`의 function/custom tool 호출과 `exec`의 정적 도구 호출 |

일반·Zstd JSONL에서 필요한 필드를 선택하고 이미지 Base64를 건너뛴다. 파일 준비 Worker는 응답 후보, 대화 경계, 부모 참조와 호출 근거를 반환한다. 집계기는 세션 안에서 응답을 중복 제거하고 확인된 자식 사용량을 부모 대화에 합산한다. 대화 수와 소요 시간은 메인 에이전트의 완료 시점과 수명주기를 따른다. 출처를 여전히 확인할 수 없는 자식의 기록은 독립 대화로 집계하지 않는다.

대화의 시작 시각을 집계 시간대의 날짜로 바꾸어 제공자·모델·Skill의 일별 행을 갱신한다. 원본 상태와 집계 결과는 같은 트랜잭션에서 반영한다. [파싱 필드](../../src/summary/parsers/logFields.ts) · [귀속 해소](../../src/summary/scanner/refresh/relations.ts) · [응답 비교](WinnerPolicy.md) · [SQLite 저장](SQLiteTables.md)
