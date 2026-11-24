# Claude·Codex JSONL 파싱 필드

Agent Tracker의 파서 버전 23 기준이다. 원본에서 읽는 값과 그 값이 응답 선택, 요청 집계, SQLite 저장, 화면 표시로 이어지는 경로를 정리한다. 표의 `payload`는 Codex JSONL 행 내부의 객체다.

## 파일 선택과 행 읽기

| 읽는 값 | 적용하는 규칙 | 결과 |
| --- | --- | --- |
| 제공자, 파일 경로, `source_root`, `mtime_ms` | 이전 `source_file`과 제공자·경로를 맞춘다. 새 경로, 수정 시각·스캔 루트 변경, 이전 처리 실패·원본 소실, 파서 버전 변경, 누락된 도구 수집을 기준으로 읽을 파일을 정한다. | 이번에 파싱할 원본과 다시 집계할 세션 범위 |
| 파일의 `size_bytes` | 선택한 파일을 처음부터 관측한 크기까지만 읽는다. Codex `.jsonl.zst`는 압축을 풀어 같은 줄 처리기로 넘긴다. | 이번 읽기의 바이트 경계 |
| JSONL 한 줄의 바이트, 줄바꿈, 이미지 데이터 URI | 완성된 줄을 UTF-8로 디코딩한다. 이미지 데이터 URI의 Base64 본문을 걷어낸 뒤 `JSON.parse`로 줄을 객체화한다. 마지막 미완성 줄은 다음 갱신에서 처리할 수 있게 표시한다. | 제공자 파서에 전달할 객체와 `offset`, `partialLine` |
| Claude의 행 `type`, Codex의 행 `type`과 `payload.type` | 사용자·응답·세션 메타·수명주기·도구 등 해당 처리기를 선택한다. 파싱 중 얻은 현재 세션·요청·모델 문맥을 다음 행으로 이어간다. | `ParsedIdentity`, `UsageEvent`, `TurnEvent`, `CheckEvent`, `CapabilityEvent`, 부모 연결 근거 |

[파일 재수집 조건](../../src/summary/scanner/refresh/state.ts#L21) · [파일 리더](../../src/summary/scanner/sourceReader.ts#L34) · [JSONL 줄 처리](../../src/summary/jsonl/index.ts#L22) · [공통 이벤트 타입](../../src/summary/types.ts#L101)

## 세션·요청·응답 식별자

| 제공자와 원본 필드 | 적용하는 규칙 | 결과 |
| --- | --- | --- |
| **Claude** 파일명, `subagents/` 경로, `sessionId` | 메인은 파일명을 초기 세션·스레드 ID로 쓰고 행의 `sessionId`가 있으면 갱신한다. 자식 파일은 경로에서 부모 세션과 자기 스레드 ID를 얻는다. | 세션 집계 키와 원본의 스레드 식별 정보 |
| **Claude** `promptId`, `uuid`, `isMeta`, `isSidechain`, `message.content[].type` | `isMeta`, `isSidechain`, `tool_result` 블록으로 외부 사용자 요청인지 판단한다. `promptId`를 현재 root로 기억하고, 외부 요청에서 빠지면 `uuid`를 사용한다. 이후 응답은 현재 root를 이어받는다. | 토큰이 합산될 `root_turn_id`와 사용자 요청 시작 이벤트 |
| **Claude** `message.id`, 행의 `requestId` | `message.id`를 응답 ID로 사용한다. 같은 세션·응답 ID에서 명시된 `requestId`가 하나로 일치하면 누락 후보에 채운다. 해소되지 않은 누락값에는 `no-req`를 쓴다. | Claude 최종 응답 키 `[message.id, requestId]` |
| **Codex** `session_meta.payload.id`, `payload.session_id` | `id`가 파일의 소유 스레드다. 세션은 명시 `session_id`, 직전 세션, 부모 스레드, 자기 스레드 순으로 해소한다. `token_usage_record.payload.session_id`로도 세션 문맥을 갱신한다. | `threadId`와 논리 `sessionId` |
| **Codex** `payload.root_turn_id`, `turn_id`, `thread_id`, `response_id` | root와 turn의 명시값을 우선하고, 필요한 경우 `turn_context`와 수명주기에서 기억한 문맥을 쓴다. 사용량 행에 `thread_id`가 빠지면 파일 소유 스레드를 사용한다. | `root_turn_id`와 Codex 최종 응답 키 `[response_id, thread_id, turn_id]` |
| **Codex** `payload.parent_thread_id`, `agent_path`, `source` 또는 `thread_source`의 `subagent.thread_spawn` | 부모 스레드와 agent 경로를 읽어 최상위 부모 세션을 찾는다. 부모를 유일하게 해소할 수 없는 경우 원래 세션을 사용하고 진단을 남긴다. | 자식이 속할 세션과 저장용 원본 관계 정보 |
| **Codex** `spawn_agent` 호출의 `call_id` 또는 `id`, 결과 `output.agent_id`, `output.task_name` | 호출 식별자로 생성 결과를 원래 호출에 연결한다. 반환된 자식 식별자를 스레드 ID 또는 agent 경로와 대조해, 명시 root가 없는 자식의 부모 요청을 찾는다. | 자식의 토큰과 도구 사용량이 귀속될 부모 `root_turn_id` |
| **Codex** `forked_from_id`, legacy 후보의 root·turn·응답 ID와 토큰 벡터 | 부모·자식의 legacy 이벤트 서명을 처음부터 대조해 일치하는 복사 구간을 제외한다. 파일 내 최고 후보가 제외되면 보관한 후속 후보에서 유효한 값을 찾는다. | 복사 이력이 빠진 최종 후보와 중복 합산 방지 |

응답 키는 제공자·세션 안에서 비교한다. 요청 합산은 `(provider, session_id, root_turn_id)`를 기준으로 한다. 같은 요청 안에서도 응답 키가 서로 다르면 각각의 winner가 합계에 들어간다.

[Claude 식별자 파싱](../../src/summary/parsers/claude.ts#L21) · [Codex 식별자 파싱](../../src/summary/parsers/codex.ts#L74) · [부모 요청 해소](../../src/summary/scanner/refresh/relations.ts#L73) · [복사 구간과 Claude 요청 ID 보정](../../src/summary/aggregation/sourceEvidence.ts#L126) · [최종 응답 키](../../src/summary/aggregation/memoryAggregate.ts#L98)

## 토큰과 winner

| 제공자와 원본 필드 | 적용하는 규칙 | 결과 |
| --- | --- | --- |
| **Claude** `message.usage.input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` | 일반 입력에 캐시 읽기와 생성을 더해 공통 입력으로 변환한다. 캐시 성분도 따로 보존한다. | `tokens.input`, `tokens.cacheRead`, `tokens.cacheWrite` |
| **Claude** `message.usage.output_tokens` | 출력 토큰으로 읽는다. | `tokens.output` |
| **Codex** `payload.usage.input_tokens`, `output_tokens` | 기록된 입력·출력 총량을 사용한다. | `tokens.input`, `tokens.output` |
| **Codex** `cached_input_tokens`, `cache_write_input_tokens`, `input_tokens_details.cached_tokens`, `input_tokens_details.cache_write_tokens` | 평면 캐시 필드를 우선한다. 없으면 중첩 필드를 사용한다. 합산할 때 읽기는 `min(input, cacheRead)`, 쓰기는 `min(max(0, input − cacheRead), cacheWrite)`를 응답마다 적용한다. | 요청·모델의 캐시 읽기·쓰기 열과 API 추정 비용의 캐시 성분 |
| **Codex** `reasoning_output_tokens` | 출력보다 큰 값을 검사하고, legacy 누계 벡터와 복사 이력 서명에 포함한다. | `component-clamped` 진단 근거와 legacy 비교 성분 |
| **Codex** `event_msg.token_count`의 `info.total_token_usage`, `info.last_token_usage` | 직전과 같은 누계·최근 사용량 조합을 건너뛴다. `last`를 우선하고, 없으면 각 성분에 `max(0, 현재 누계 − 이전 최대 누계)`를 적용한다. 현재 형식의 사용량이 있는 파일에서는 legacy 후보를 제외한다. | legacy 응답 ID와 토큰 벡터. 누계가 역행하면 `counter-regression` |
| **Codex** `payload.turn_token_usage.input_tokens`, `output_tokens` | 스레드·턴별 마지막 누계를 보존하고 해당 스레드·턴의 최종 winner 합계와 대조한다. | 차이가 있을 때 `token-total-mismatch` |
| **공통** 정규화된 `input`, `output`, 응답 키, 이벤트 순번 | 파일 안에서 먼저 최고 후보를 남긴다. 세션 안에서 최종 키가 같은 후보를 모아 `input + output`이 큰 쪽을 선택한다. 점수가 같으면 집계 순번이 큰 쪽을 사용한다. | 응답 키마다 승자의 사용량·모델·결제 정보 한 건 |

입력·출력 중 하나 이상이 있어야 하며, 값이 있는 주요 평면 토큰 필드는 음이 아닌 안전 정수여야 한다. 요청의 총 토큰은 최종 winner들의 `input + output` 합이다. 캐시와 reasoning은 각각 입력과 출력의 구성 성분이다.

[토큰 정규화와 검증](../../src/summary/parsers/common.ts#L67) · [Codex legacy 계산](../../src/summary/parsers/codex.ts#L266) · [파일별 후보](../../src/summary/aggregation/sourceWinners.ts#L49) · [세션별 최종 비교와 검산](../../src/summary/aggregation/memoryAggregate.ts#L108) · [캐시 집계](../../src/summary/aggregation/turns.ts#L79)

## 요청 시각과 상태

| 제공자와 원본 필드 | 적용하는 규칙 | 결과 |
| --- | --- | --- |
| **Claude** 외부 `user` 행의 `timestamp` | 요청 시작 시각 후보를 만든다. 같은 요청의 유효한 시작 후보 중 가장 이른 값을 쓴다. | `started_at_ms`, 날짜 필터와 일·월 집계 기준 |
| **Claude** `assistant.timestamp`, `message.stop_reason`, `isApiErrorMessage` | 마지막 assistant 시각을 갱신한다. API 오류는 실패, `end_turn`과 `stop_sequence`는 완료, 그 외에는 진행 중의 근거다. | `status`, 완료 후보 시각, `api-error` 진단과 근사 소요 시간의 근거 |
| **Claude** `system.subtype`, `preventedContinuation`, `durationMs`, `timestamp` | `stop_hook_summary`는 요청을 계속할지 판단한다. `turn_duration`은 명시 소요 시간을 제공한다. `stop`, `turn_complete`, `task_complete`는 종료 근거다. | `completed_at_ms`, `duration_ms`, `duration_quality` |
| **Codex** `task_started.started_at`, `user_message`의 행 `timestamp`, `payload.id` | 시작 시각을 얻는다. 구형 사용자 이벤트에서 새 root가 필요하면 `id` 또는 `legacy-<시각>`을 사용한다. | `started_at_ms`와 필요 시 legacy 요청 ID |
| **Codex** `task_complete`·`task_completed`의 `completed_at`, `duration_ms`, `turn_aborted`, `agent_message`의 행 `timestamp` | 완료·중단·마지막 assistant 시각을 접는다. `started_at`·`completed_at`이 숫자면 초를 밀리초로 변환하며, 수명주기 시각이 빠지면 바깥 행 `timestamp`를 사용한다. | 상태와 완료 시각, 명시 소요 시간. 최종 메인 상태가 중단인 요청은 요청 요약에서 제외 |
| **공통** 메인 요청의 시작·종료·마지막 assistant 시각과 명시 duration | 명시 duration을 우선하고, 이어 종료와 시작의 차이, 완료 요청의 마지막 assistant와 시작의 차이를 사용한다. 계산 근거에 따라 품질을 정한다. | `duration_ms`와 `exact`·`derived`·`approximate`·`missing`. 완료 요청은 평균 토큰과 평균 시간의 표본이 된다. |

[Claude 수명주기](../../src/summary/parsers/claude.ts#L111) · [Codex 수명주기](../../src/summary/parsers/codex.ts#L201) · [요청 시각·품질 확정](../../src/summary/aggregation/turns.ts#L108) · [조회 평균 SQL](../../src/summary/db/queries/raw/usage.ts#L64)

## 모델·결제·표시·도구·진단

| 원본에서 읽는 값 | 적용하는 규칙 | 결과 |
| --- | --- | --- |
| Claude `message.model`, Codex 사용량 행의 `model`과 세션·턴 모델 문맥 | winner의 토큰을 모델명별로 더한다. 저장 직전 모델별 합계를 요청 합계와 대조하고, 모델 단가를 적용해 비용을 추정한다. | `turn_model_usage`의 토큰과 단가 적용 결과, 모델별 표·차트 |
| Claude·Codex `billing_mode`, `auth_mode` | 응답별 결제 방식을 구독·API·미상으로 정규화한다. 요청 내 winner 결제가 섞이면 미상으로 집계한다. 사용자 지정 세션 결제 방식은 저장 시 우선한다. | `turn_costs.billing_mode`, `cost_usd`, `unknown_costs`. 구독은 비용 0, API는 모델별 추정 비용 합계 |
| `cwd`, 원본 경로 | 경로 표기를 정규화해 프로젝트 키를 얻고 마지막 경로 요소를 이름으로 사용한다. 요청에는 메인 파일의 프로젝트를 우선 사용한다. | `projects`와 프로젝트별 집계·필터 |
| Claude `customTitle`, `aiTitle`, Codex `thread_name`, `name`, `title`과 외부 이름 메타데이터 | Claude는 사용자 지정 제목을 우선한다. Codex는 `state_N.sqlite`, `session_index.jsonl`, 로그 메타데이터 순으로 표시 이름을 선택한다. | `sessions.session_name`, 목록·차트 표시 이름 |
| Claude `user.message.content`, Codex `event_msg.user_message`의 `payload.message` | 문자열과 `text`·`input_text` 블록에서 첫 유효 줄을 최대 80자로 줄인다. `## My request:`가 있으면 마지막 해당 구간을 우선한다. 요청에는 집계 순서의 첫 제목을 쓴다. | `turn_summary.request_title`. Codex `response_item`의 사용자 텍스트는 현재 제목 추출 경로 밖에 있으며, UI에서 빈 제목은 세션 이름으로 대체한다. |
| Claude `tool_use` 블록의 `id`·`name`·`input`, Codex `function_call`·`custom_tool_call`의 `call_id` 또는 `id`, `name`, `arguments` 또는 `input` | 도구명과 인자에서 스킬명, agent 유형, `SKILL.md` 경로, MCP 플러그인 이름을 찾는다. 같은 요청에서 동일한 스레드·호출 ID·분류·이름은 한 번 센다. | `turn_capability_usage`의 `usage_count`와 스킬·서브에이전트·플러그인 순위 |
| 파서가 붙이는 파일 ID, 줄 `offset`, 이벤트 `index` | `offset`은 원본 위치, `index`는 파일에서 생성된 이벤트 순서다. 순서는 동점 winner와 마지막 누계 check를 고르는 데 쓰이고, 이상 상태는 파일 ID와 위치로 추적한다. | `quality_flags`, `diagnostic_file_id`, `diagnostic_offset`, 원본 처리 상태 |

[모델·도구 집계](../../src/summary/aggregation/turns.ts#L87) · [비용 산식](../../src/summary/models/pricing.ts#L34) · [결제 저장](../../src/summary/db/billing.ts#L7) · [표시값 정규화](../../src/summary/parsers/common.ts#L30) · [Codex 세션 이름](../../src/summary/scanner/names.ts#L11) · [도구 분류](../../src/summary/parsers/capabilities.ts#L117) · [화면의 제목 대체](../../media/dashboard.js#L342)

## 집계 결과와 저장값

| 단계 | 데이터와 쓰임 |
| --- | --- |
| 파일 파싱 완료 | `SourceWinnersSnapshot`에 파일별 winner, 요청 상태·최신 check·도구, 부모와 복사 구간을 판단할 근거를 담는다. |
| 세션 집계 완료 | TypeScript에서 최종 winner마다 `AppliedResponse`를 만들고, 요청별로 합산한 토큰·시간·제목·모델·도구·진단을 `MaterializedTurnSummary`에 담는다. |
| 이전 반영값과 비교 | 증분 저장에서는 SQLite의 이전 `applied_response`와 `turn_summary`를 읽는다. TypeScript에서 응답별 `새 값 − 기존 값`을 이전 요청 합계에 더하고 재집계한 DTO와 대조한다. 차분 경로를 적용할 수 없으면 재집계한 DTO로 교체한다. |
| 요청과 응답 저장 | 변경 요청은 `(provider, session_id, root_turn_id)` 기준으로 `turn_summary`에 한 번 UPSERT한다. 응답별 토큰은 `(turn_id, response_key)` 기준으로 `applied_response`에 저장한다. 모델·도구·비용은 요청 ID를 참조한다. |
| 통계 조회 | SQLite가 확정된 요청·모델 또는 일별 사전 집계 행에서 토큰 합계, 완료 요청 수, 평균 토큰과 소요 시간을 일·월·세션·프로젝트별로 계산한다. |

[파일 DTO](../../src/summary/aggregation/sourceWinners.ts#L26) · [요청 DTO](../../src/summary/aggregation/turns.ts#L170) · [차분 계산](../../src/summary/aggregation/appliedUsage.ts#L18) · [요청 저장](../../src/summary/db/memoryStore/index.ts#L57) · [응답 저장](../../src/summary/db/appliedResponses.ts#L21) · [통계 조회](../../src/summary/db/reader.ts#L39)
