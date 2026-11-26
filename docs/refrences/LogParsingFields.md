# Claude·Codex JSONL에서 읽는 스레드 필드

파서 버전 25는 JSONL 행에서 토큰·시각·모델·스레드 ID·세션 ID와 응답 중복 및 fork 복사 확인에 필요한 참조를 읽는다. `type`은 값의 해석 방식을 고른다. 파일 경로, 수정 시각, 관측 크기는 원본 순서 선택과 읽기 범위에 사용한다.

## 원본 필드와 용도

| 항목 | Claude | Codex | 용도 |
| --- | --- | --- | --- |
| 세션·스레드 | 메인의 `sessionId`. 기본값은 파일명이며, `subagents/` 아래서는 디렉터리와 파일명으로 세션과 스레드를 각각 구분 | `session_meta.payload.id`, `payload.thread_id`, `payload.session_id`. 세션 ID가 없으면 스레드 ID 사용 | `(provider, session_id, thread_id)` 비교 키와 세션 필터 |
| 모델 | `assistant.message.model` | 사용량 행의 `payload.model`, 세션·턴 문맥의 `payload.model` | 스레드 안의 모델별 토큰 합계 |
| 입력·출력·캐시 | `message.usage`의 `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` | `payload.usage`, `thread_token_usage`, `turn_token_usage`와 구형 `token_count.info`의 `total_token_usage`·`last_token_usage`. 입출력과 평면·중첩 캐시 값을 읽고, 구형 행의 `reasoning_output_tokens`·`total_tokens`는 복사 비교에 쓴다. | 스레드·모델별 사용량, 누락 구간 검산, API 추정 비용 |
| 응답과 부모 참조 | `message.id`, `requestId`, 빈 오류 응답 거르기에 쓰는 `isApiErrorMessage` | `payload.turn_id`, `payload.response_id`, `session_meta`의 `forked_from_id` 또는 직접·중첩 `parent_thread_id` | 응답별 최고 사용량 선택 및 부모에서 복사된 구형 앞부분 대조 |
| 시간 | 행 `timestamp` | 행과 `payload`의 `timestamp`, `event_msg` 시작·완료 시각 | 첫 시각으로 일·월을 결정하고 마지막 시각과의 차이를 기록 시간으로 사용 |

제목, `cwd`, 로그의 결제 방식, 본문과 도구 인자는 건너뛴다. 프로젝트 표시는 원본 경로에서 파생하며 Codex 이름 색인은 표시용으로 별도 조회한다. [스레드 필드 및 파서](../../src/summary/parsers/threadUsage.ts)

## 읽기와 합산

1. 일반·Zstd JSONL에서 이미지 Base64 본문을 거르고 고정 필드 경로의 조각을 모은다. 경계를 넘거나 이미지가 있는 줄은 청크마다 JSON 문법 상태와 선택한 조각을 이어 간다. LF에서 축소된 줄을 `JSON.parse`에 넘긴다. 줄 예산과 원본 위치는 리더가 관리한다.
2. 읽는 동안 파일 안에서 응답 키별 최고값을 갱신한다. 파일 준비 Worker는 스레드 식별·시각과 파일별 최고값, Codex 검산용 순서·누계를 전달한다. 수집기는 이를 `(제공자, 세션, 스레드)`에 합친다. 식별된 응답의 존재 여부, 중복 제거 전 사용량 기록 수, 최신 수정 시각, 경로 순으로 시간과 Codex 누계 검산에 쓸 기준 파일을 고른다. [비교 키와 동점 처리](WinnerPolicy.md)
3. Claude는 세션 내 `(message.id, requestId)`마다 `입력 + 출력`이 가장 큰 행을 스레드에 한 번 반영한다. 같은 메시지에 확인된 `requestId`가 한 종류면 해당 후보를 요청 ID가 없는 후보와 함께 비교한다. 새 Codex는 스레드 내 `(turn_id, response_id)`마다 같은 비교를 하고 `payload.usage`를 더한다. 중단 전에 기록된 사용량도 합산한다.
4. 구형 Codex는 순서대로 보관한 구형 스냅샷을 부모와 비교한다. 일치한 복사 앞부분으로 기준 누계를 잡고 그 사용량을 제외한다. 그 밖의 첫 누계에서는 확인되는 `last_token_usage`만 합산한다. 이후 이미 본 스냅샷을 건너뛰고 검증 가능한 증가분을 계산한다. 새 형식과 섞인 파일에서는 첫 응답 전에 기록된 구형 사용량을 보존한다. 응답이 처음 등장할 때 기록된 사용량으로 이미 설명되는 새 형식 누계 구간은 읽는 중에 제외한다. 남은 구간은 최종 응답별 최고값으로 다시 계산하고, 설명되지 않은 증가분은 같은 턴 누계 또는 구형 스냅샷이 뒷받침할 때만 보충한다. 부모 원본 없이 복사 여부를 확인할 수 있는 범위는 제한된다.
5. 메모리 집계 입력의 호환 필드 `root_turn_id`에 스레드 ID를 넣고 `model_usage`에 모델별 값을 담는다. 스레드 첫 시각의 날짜로 묶어 `usage_request_daily`와 `usage_model_daily`에 일별 합계와 평균에 필요한 표본 수를 저장한다. 기록 시간에는 첫 시각과 마지막 시각 사이의 유휴 시간도 포함된다. 이전 파서 버전의 파일은 다음 갱신에서 다시 읽고, 소실 원본은 일별 저장의 보존 기준을 적용한다. [현재 SQLite 테이블과 보존 규칙](SQLiteTables.md)

[JSONL 필드 선택](../../src/summary/jsonl/projection.ts) · [스레드별 선택](../../src/summary/scanner/refresh/aggregation.ts) · [토큰 합산](../../src/summary/aggregation/threadAccounting.ts) · [SQLite 저장](../../src/summary/scanner/refresh/persistence.ts)
