# JSONL 파싱·DB 증분 갱신·집계 쿼리 알고리즘 레퍼런스

조사 기준: **2026-11-05, Asia/Seoul**. Agent Tracker의 현재 코드와 공식 문서·원 논문·개발자 공개 소스를 대조했다. 설명 아래의 데이터는 이해를 위한 합성 예시다.

핵심은 **읽고 만드는 양을 줄이고, 같은 작업을 묶고, 이미 계산한 결과를 다시 사용하는 것**이다.

| 요청 | 최적화 개념 | 대표 레퍼런스 |
| --- | --- | --- |
| 1. AI 도구의 JSONL 파싱 | 청크·행 스트리밍, 이벤트별 상태 유지, 응답 값과 누계 구분 | JSON Lines, Codex rollout/protocol, Filebeat |
| 2. 비슷한 입력 조건의 일반 파싱 | 필요한 필드만 변환, 불필요한 중첩 구간 건너뛰기, 구간 병렬 검사 | RapidJSON SAX, simdjson, Mison, JSONSki |
| 3. dirty flag 기반 DB 증분 갱신 | 변경 키 중복 제거, 영향 구역 재집계, 이전 기여분 차감·새 기여분 추가 | Dirty Flag, Kubernetes workqueue, Timescale, DBSP, pg_ivm |
| 4. 일·월·프로젝트·세션·평균 | 일별 상태 재사용, 합계·표본 수 병합, 시간 범위 먼저 좁히기 | Gray의 Data Cube, SQLite 집계·날짜 함수 |
| 5. 해당 조회의 인덱싱 | 동등 조건 다음 범위 조건, covering·partial·expression index, ID 커서 | SQLite Query Planner·Optimizer |

## 현재 코드에서 이미 하는 일

| 처리 단계 | 현재 방식 | 아직 적용하지 않은 후보 |
| --- | --- | --- |
| 파일 읽기 | 최대 64 KiB 청크, LF 완성 행 처리, 일반 행의 `JSON.parse` 빠른 경로 | byte checkpoint 뒤만 이어 읽기 |
| 큰 문자열 | `data:image/...;base64,` 문자열의 본문을 버리고 문자열 문법 검사 | 임의 필드 projection·중첩 구조 fast-forward |
| 변경 감지·정규화 | manifest 비교, dirty 세션 집합 중복 제거, 연결 세션의 원본 재파싱 | 영속 dirty 작업 큐·parser 상태 checkpoint |
| facts 저장 | 작은 세션 교체, 큰 세션의 소수 변경은 TEMP 비교 후 부분 반영 | 정규화된 facts의 before/after를 rollup delta에도 재사용 |
| 통계 유지·조회 | 변경 세션 rollup 재집계, 일별 상태 병합, 부분 날짜만 원본 조회 | 정규화 facts의 ±delta로 rollup 유지, 월 전용 rollup |

현재의 증분 처리는 **변경 없는 세션을 건너뛰는 것**이 중심이다. ‘추가된 바이트만 읽기’나 ‘변경 행의 증감분만 집계에 반영하기’까지 구현한 것은 아니다. 아래에서는 **현재 대응**과 **추가 후보**를 구분한다.

현재 구조의 근거: [JSONL reader](../../src/summary/jsonl.ts), [scanner](../../src/summary/scanner.ts), [staging](../../src/summary/staging.ts), [세션 저장](../../src/summary/db/sessions.ts), [부분 저장 판정](../../src/summary/db/sessionChanges.ts), [rollup 갱신](../../src/summary/db/rollups.ts), [집계 조회 선택](../../src/summary/db/reader.ts).

## 1. Claude·Codex JSONL 파싱에 직접 대응하는 레퍼런스

여기서 기본 대상은 **모델이 답변으로 만든 임의의 JSON이 아니라, Claude·Codex 도구가 남긴 JSONL 이벤트 로그**다. JSON 한 줄을 객체로 바꾸는 문법 파싱과, 그 객체를 사용량·요청·세션으로 해석하는 처리를 나눠 보면 이해하기 쉽다. Claude 공식 문서는 로컬 transcript가 JSONL이고 내부 레코드 형식은 버전에 따라 바뀔 수 있다고 설명한다. [Claude Code: Where transcripts are stored](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)

### 1.1 줄 단위 스트리밍: 전체 파일 대신 현재 줄만 메모리에 둔다

**최적화 개념:** 파일 전체를 문자열로 읽고 `split()`하면 파일·문자열·줄 배열이 한꺼번에 메모리를 쓴다. 일정 크기의 청크를 읽고 LF까지 이어 붙여 한 줄씩 넘기면, 파일이 커져도 reader가 동시에 보관하는 범위를 제한할 수 있다. 이는 JSON Lines 형식의 줄 경계를 이용한 스트리밍 처리다. [JSON Lines 명세](https://jsonlines.org/)

**예시:**

```text
청크 1: {"type":"session_meta"}\n{"type":"token_
청크 2: usage_record","payload":{"usage":120}}\n

1. 청크 1의 완성된 session_meta 행을 처리한다.
2. token_ 뒤의 나머지는 다음 청크와 연결한다.
3. 완성된 두 번째 행을 처리하고 문자열을 버린다.
```

**현재 코드 연결:** [readJsonl](../../src/summary/jsonl.ts)은 최대 64 KiB 청크를 읽고, 일반적인 짧은 행은 곧바로 `JSON.parse()`에 전달한다. 여러 청크에 걸친 행과 이미지 포함 행에만 별도 구성기를 사용한다. 기본 보관 줄 예산은 4 MiB다.

**이점·제약:** 순차 바이트 스캔은 여전히 O(N)이지만 파일 전체를 보관할 필요가 없다. 보조 공간은 청크와 보관 중인 최대 줄 크기에 좌우된다. 반환 JSON 객체·adapter·SQLite의 메모리까지 이 상한에 포함되는 것은 아니다.

### 1.2 Codex 공식 decoder: 공통 이벤트 종류로 분기하고 문맥을 유지한다

**최적화 개념:** JSON을 읽을 때마다 전체 대화 이력을 검색하지 않고, 현재 세션·요청·모델 문맥을 작은 상태로 유지한다. Agent Tracker에 대입하면 `type`별 처리기가 필요한 이벤트를 통계 이벤트로 변환하는 구조다. 공식 Codex의 `load_rollout_items`는 행별 JSON decode와 이벤트 decode를 나누고, 복제된 fork metadata가 있어도 첫 `SessionMeta`를 해당 파일의 identity로 선택한다. [Codex rollout recorder](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs)

**예시:**

```text
session_meta(thread=A)          → 파일 identity를 A로 기억
turn_context(turn=T, model=M)   → 현재 요청 T와 모델 M을 기억
token_usage_record(usage=120)   → A/T/M에 토큰 120을 귀속
session_meta(thread=부모)       → 복제된 부모 metadata로 A를 덮어쓰지 않음
```

**현재 코드 연결:** [CodexCurrentParserAdapter](../../src/summary/parsers/codex.ts)와 [ClaudeParserAdapter](../../src/summary/parsers/claude.ts)가 같은 종류의 순차 상태 처리를 한다. Claude는 `promptId`·`uuid`와 tool result 여부를, Codex는 session·root turn·response ID를 해석한다. 이는 공식 구현을 복사했다는 뜻이 아니라, 코드에서 확인한 개념적 대응이다.

**이점·제약:** 각 행을 한 번 순서대로 처리하는 것이 기본이다. 다만 파일 중간부터 재개하려면 마지막 offset만으로 부족하고, 이 상태도 함께 복원해야 한다. 공식 recorder는 파싱한 이벤트를 최종 `Vec`에 모으므로 reader 전체가 상수 메모리인 예시는 아니다.

### 1.3 응답 사용량과 누적 사용량을 구분한다

**최적화 개념:** 같은 사실을 표현한 응답별 값과 요청·스레드 누계를 모두 더하지 않는다. 공식 Codex의 `TokenUsageRecord`는 `usage`·`turn_token_usage`·`thread_token_usage`를 분리한다. 이전 `TokenUsageInfo::new_or_append`도 `total += last`로 누계를 갱신하고 `last`를 별도로 보관한다. [Codex TokenUsageRecord / TokenUsageInfo](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)

**예시:**

```text
응답 1: usage=120, turn_total=120
응답 2: usage=80,  turn_total=200
합계: 120+80=200               # turn_total까지 더하면 중복 집계

누계만 있는 이전 로그: 120 → 200 → 200
차분:                 120     80      0
```

**현재 코드 연결:** 현재 형식에서 adapter는 `usage`를 합산 대상으로, `turn_token_usage`를 검증용 `check`로 내보낸다. 이전 형식은 동일한 total/last 조합을 건너뛰고, `last`가 없으면 high-water와의 차분을 사용한다. counter가 역행하면 오류 플래그를 남기고 기준값은 낮추지 않는다.

**이점·제약:** 중복 이벤트나 누계 반복 때문에 통계가 부풀어 오르는 것을 줄인다. high-water 방식은 counter 초기화와 replay를 완전히 구별하는 보편적 해법은 아니다. 새 parser나 중간 재개를 설계할 때 reset·fork·누락 정책을 따로 정해야 한다.

### 1.4 완성 줄 경계와 Filebeat식 체크포인트

**최적화 개념:** 실시간 로그는 마지막 줄을 쓰는 중일 수 있으므로, 줄 경계까지 확정된 이벤트만 처리한다. 장기적으로는 파일 identity와 마지막 처리 위치를 저장해 추가된 부분만 읽을 수 있다. Filebeat는 LF로 이벤트 경계를 판단하고, filestream은 파일 fingerprint와 읽기 offset 상태를 관리한다. [Filebeat의 마지막 LF 처리](https://www.elastic.co/docs/reference/beats/filebeat/newline-character-required-eof), [filestream: identity와 offset](https://www.elastic.co/docs/reference/beats/filebeat/filebeat-input-filestream)

**예시:**

```text
확정 구간: 0..999 byte = 완성된 10행
미완성:    1000..1049 byte = 쓰는 중인 11행

체크포인트 후보 = 1000
다음 갱신: file identity와 기존 구간의 유효성을 확인하고 1000부터 재개
```

**현재 코드 연결:** `readJsonl`은 마지막 LF가 없는 부분 줄을 유예한다. 그러나 **현재 scanner는 체크포인트 뒤만 이어 읽지 않는다.** 변경된 파일과 영향을 받은 세션의 원본을 다시 읽는다. byte offset 재개는 추가 후보다.

**이점·제약:** 안전하게 append를 판정할 수 있다면 재파싱 범위를 N 전체에서 추가 바이트 ΔN으로 줄일 여지가 있다. offset·parser 문맥·DB 결과의 원자적 저장, 파일 교체·축소·같은 크기 rewrite 검증, fork lineage 및 `.jsonl.zst` 재개 전략이 필요하다. 참고로 JSON Lines 명세 자체는 마지막 LF를 필수로 하지 않는다. LF 유예는 이 제품의 실시간 로그 정책이다.

### 1.5 모델 답변의 깨진 JSON을 뜻한 경우: jsonrepair

**개념:** 따옴표·쉼표·닫는 괄호가 빠진 생성 텍스트는 정상 JSONL decoder와 문제가 다르다. `jsonrepair`는 이런 문법을 보정하는 개발자 공개 구현이며 Node.js 스트리밍 API도 제공한다. [jsonrepair 공식 저장소](https://github.com/josdejong/jsonrepair)

**예시:**

```text
입력: {count: 3,}
보정: {"count": 3}
```

**적용 범위:** 임의 생성 텍스트를 사용자가 검토할 임시 미리보기에는 참고할 수 있다. 현재 `readJsonl`은 원본을 자동 보정하지 않고 파싱 오류를 보고한다. 문법 복구가 원래 의미를 복원했다는 보장은 없고, streaming buffer도 가장 긴 문자열보다 커야 한다.

## 2. 일반 파싱 최적화에서 가져올 개념

아래 연구·라이브러리의 성능 수치는 Agent Tracker에서 측정한 값이 아니다. 현재 구현과 연결한 부분은 적용 가능성에 대한 해석이며, 도입 시 별도 비교가 필요하다.

### 2.1 SAX 이벤트 처리: 전체 객체 트리 대신 필요한 결과만 만든다

**최적화 개념:** 일반 DOM 파서는 JSON 전체를 객체 트리로 만든다. SAX 방식은 키·숫자·객체 시작/끝을 callback으로 전달하고 필요한 통계 레코드만 만든다. RapidJSON은 Reader에서 handler로 이벤트를 전달하고 중간 filter를 두는 실제 예제를 제공한다. [RapidJSON SAX / Filtering](https://rapidjson.org/md_doc_sax.html)

**예시:**

```text
입력: {"type":"usage","usage":{"input":100},"body":"아주 긴 본문"}
이벤트: Key(type), String(usage), Key(input), Uint(100), ...
보관: {type:"usage", input:100}
```

**현재 코드 연결:** adapter가 공통 통계 이벤트를 내보내는 부분은 이벤트 처리와 비슷하다. 다만 문법 파싱 단계는 여전히 `JSON.parse()`로 각 행의 전체 객체를 만든다. SAX로 바꾸는 것은 미적용 후보다.

**이점·제약:** 사용하지 않는 객체를 오래 보관하지 않는다. 그러나 callback 방식 자체가 거대한 문자열의 디코딩·할당까지 없애 준다는 뜻은 아니다. 필드 경로·중첩·escape·잘못된 JSON을 추적해야 하고 callback 호출 비용도 생긴다.

### 2.2 simdjson: 구조 문자를 묶어서 찾고 필요한 값만 늦게 변환한다

**최적화 개념:** SIMD는 여러 바이트를 한 명령으로 검사해 따옴표·괄호 같은 구조 문자를 찾는 비용을 줄인다. On-Demand API는 필요한 문자열·숫자만 실제 값으로 만드는 시점을 늦춘다. [Langdale·Lemire, Parsing Gigabytes of JSON per Second, VLDB Journal 2019](https://arxiv.org/abs/1902.08318), [Keiser·Lemire, On-Demand JSON, 2024](https://arxiv.org/abs/2312.17149)

**예시:**

```text
32만 byte의 로그 행에서 원하는 값 = payload.usage.input
DOM: 전체 값을 객체로 변환 → input 선택
On-Demand: 구조 탐색 → 해당 경로 접근 → input 숫자를 변환
```

**현재 코드 연결:** 현재 reader도 `Buffer.indexOf()`와 구간 복사로 byte별 JavaScript 분기를 줄이고, 일반 줄은 직접 `JSON.parse()`하는 경로를 사용한다. 이는 **구간 단위 처리라는 개념의 대응**이며 현재 simdjson이나 직접 SIMD를 쓰고 있다는 뜻은 아니다.

**이점·제약:** 파싱·할당이 병목이고 사용하는 필드가 적을수록 검토 가치가 있다. C++·Node native 경계와 VS Code 실행 환경별 패키징 비용이 추가될 수 있다. On-Demand는 사용하지 않은 값까지 완전히 검증하지 않으므로, 현재 오류 검출 계약과 맞추는 검토가 필요하다. [On-Demand 설계와 검증 범위](https://simdjson.org/api/3.0.0/md_doc_ondemand_design.html)

### 2.3 Mison: projection·filter를 parser 안으로 밀어 넣는다

**최적화 개념:** DB 조회 후 열을 고르듯, JSON parser가 처음부터 원하는 필드만 추출하고 조건에 맞지 않는 레코드 처리를 일찍 줄인다. Mison은 구조 인덱스와 이전 레코드 패턴을 이용한 필드 위치 예측을 결합한다. [Li 외, Mison: A Fast JSON Parser for Data Analytics, VLDB 2017](https://www.microsoft.com/en-us/research/publication/mison-fast-json-parser-data-analytics/)

**예시:**

```text
목표: type=token_usage_record에서 usage와 response_id만 필요
일반: 행 전체 객체 생성 → type 확인 → 두 필드 선택
후보: type과 구조 확인 → 필요한 두 필드만 변환 → 통계 이벤트 생성
```

**현재 코드 연결:** `JsonlLine`이 원본에서 `data:image/...;base64,`로 시작하는 문자열의 Base64 본문을 `JSON.parse()` 전에 버리는 것은 불필요한 값의 물질화(materialization)를 줄이는 좁은 사례다. 일반 필드 projection·Mison 구조 인덱스는 아직 없다. 별도 `media_type`/`data` 구조나 escape로 작성한 prefix까지 같은 방식으로 제거하는 것은 아니다.

**이점·제약:** 로그 대부분이 본문이고 통계 필드가 작다면 객체 생성·문자열 변환을 줄일 가능성이 있다. `session_meta`·사용자 요청·수명주기·tool capability도 통계에 필요하므로 단순히 usage 이외 모든 행을 버려서는 안 된다. JSON 객체의 키 순서는 고정 계약이 아니므로 위치 예측에는 검증과 fallback이 필요하다.

### 2.4 JSONSki: 필요 없는 중첩 구간을 빠르게 건너뛴다

**최적화 개념:** JSONPath 평가에 관계없는 하위 객체·배열을 세세하게 값으로 바꾸지 않고, 구조 경계를 찾아 다음 관심 구간으로 이동한다. JSONSki는 스트리밍과 bit/SIMD 병렬 처리를 이용한 fast-forward 연구 구현이다. [JSONSki 공식 저장소](https://github.com/AutomataLab/JSONSki), [Jiang·Zhao, JSONSki 논문, ASPLOS 2022](https://par.nsf.gov/servlets/purl/10323318)

**예시:**

```text
원하는 값: $.payload.usage
입력: {"history":[수천 개 객체],"payload":{"usage":120}}
처리: history 내부의 값을 만들지 않고 배열 끝까지 이동 → usage 추출
```

**현재 코드 연결:** 현재 reader는 이미지 Base64 문자열을 버리지만, 임의의 큰 `history` 객체·배열 전체를 건너뛰지는 않는다. 본문이 큰 긴 세션에서 검토할 수 있는 추가 후보다.

**이점·제약:** 건너뛰는 대상이 커야 추가 구조 처리 비용을 상쇄할 여지가 있다. 문자열 안의 괄호·따옴표·escape를 구분해야 하므로 단순 문자열 검색으로 대체할 수 없다. 공개 구현의 요구 환경은 Linux/C++와 특정 SIMD 명령이며, Windows VS Code에 바로 설치할 수 있다는 의미는 아니다.

### 2.5 현재 방식의 핵심: 일반 행은 빠르게, 큰 행은 필요한 부분만 보관한다

**예시:**

```text
일반 짧은 줄             → UTF-8 문자열 → JSON.parse
청크에 걸친 줄           → 제한된 block에 연결 → JSON.parse
이미지 data URI 포함 줄  → 문자열 문법을 추적하며 Base64 본문 제거 → JSON.parse
```

현재 구현은 `JSON.parse()`를 바꾸기보다 그 앞의 줄 구성·복사·버리는 값의 보관 비용을 줄였다. 따옴표/역슬래시 탐색 위치를 재사용해 같은 남은 구간을 반복 검색하지 않는 것도 포함된다. [현재 reader](../../src/summary/jsonl.ts)

기존 저장소의 2026-10-09 보고서는 고정된 실제 입력 53,271행의 **파싱 구간만** 4,941.028→1,718.516 ms(중앙값)로 줄었다고 기록한다. 당시 adapter·파일 I/O·SQLite는 제외했다. 이번 조사에서 새로 실행한 측정이나 전체 갱신 속도가 아니다. [기존 JSONL 파싱 비교](../benchmarks/2026-10-09/JsonlParsingBranches-2026-10-09.md)

후보 비교 시에는 메타데이터·사용량·도구·대형 이미지·대형 중첩 본문을 섞고, UTF-8 청크 경계·escape·미완성 행·오류 offset·중복 집계가 현재 결과와 같은지 함께 확인해야 한다. 읽어야 하는 원본 바이트가 그대로라면 I/O의 O(N) 자체는 사라지지 않는다.

## 3. Dirty flag와 DB 증분 갱신

### 3.0 먼저 구분할 것: 무엇을 조금씩 처리하는가

Dirty flag는 **어디가 달라졌는지 표시하는 방법**이다. 표시된 범위를 어떻게 다시 계산할지는 별도 선택이다. `dirty=true` 자체가 계산량을 변경 행 수만큼으로 줄여 주지는 않는다.

| 단계 | 현재 Agent Tracker | 줄어드는 비용 | 남는 비용 |
| --- | --- | --- | --- |
| 원본 변경 감지 | manifest의 크기·mtime·파서 버전 등 비교 | 변경 없는 세션의 본문 재파싱 | 파일 metadata 확인 |
| 영향 범위 수집 | TEMP `affected(provider, session_id)`와 `INSERT OR IGNORE` | 같은 세션에 대한 중복 작업 | 영향 세션의 모든 관련 원본 재독해 |
| facts 저장 | 큰 세션은 TEMP snapshot과 기존 facts 비교 후 부분 반영 | 적은 변경에 따른 main DB·자식 테이블 쓰기 | 전체 새 snapshot 파싱·비교 |
| 일별 rollup 갱신 | 변경 세션의 이전 집계 행 삭제 후 현재 facts로 재집계 | 무관한 세션의 집계 작업 | 해당 세션의 전체 facts 집계 |

현재 방식은 **영향 세션만 다시 계산하는 증분 처리**다. `SUM += delta`를 사용하는 행 단위 IVM과 구분해야 한다. `processing_position='committed'`는 진단 상태이며 append byte cursor가 아니다.

현재 코드: [scanner.ts](../../src/summary/scanner.ts), [staging.ts](../../src/summary/staging.ts), [sessions.ts](../../src/summary/db/sessions.ts), [sessionChanges.ts](../../src/summary/db/sessionChanges.ts), [rollups.ts](../../src/summary/db/rollups.ts).

### 3.1 Dirty Flag + 변경 키 집합: 같은 대상을 여러 번 계산하지 않기

**쉬운 설명.** 원본이 바뀔 때 바로 비싼 집계를 실행하지 않고, 세션 ID를 작업 목록에 표시한다. 같은 세션이 열 번 바뀌어도 목록에는 한 번만 넣는다. 실제 갱신 때 최신 상태를 한 번 계산한다. Dirty Flag의 본래 개념은 비싼 파생 상태 계산을 필요할 때까지 미루는 것이다. [Robert Nystrom, Dirty Flag 원고](https://raw.githubusercontent.com/munificent/game-programming-patterns/master/book/dirty-flag.markdown)

**예시.** 세션 A의 본문·subagent 파일·이름이 연속해서 바뀌었다.

```text
변경 알림: A, A, A, B
dirty 집합: {A, B}
갱신 실행: A 한 번, B 한 번
```

```sql
-- 현재 구현과 같은 중복 제거 개념을 보여 주는 축약 예시
CREATE TEMP TABLE affected (
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (provider, session_id)
);
INSERT OR IGNORE INTO affected VALUES ('codex', 'A');
INSERT OR IGNORE INTO affected VALUES ('codex', 'A');
-- A는 한 행만 남는다.
```

**현재 대응.** `SummaryStaging.insertAffected`가 이미 이 방식을 사용한다. 새 파일이 이전 세션과 다른 세션에 연결되면 이전·현재 세션을 연결하고, `nextComponent()`의 재귀 CTE가 함께 교체할 연결 성분을 선택한다. 파일 단위로만 표시하면 fork·parent·subagent 기여분이 빠질 수 있어 논리 세션 의존성을 확장한다.

**이득과 한계.** 한 세션에 변경 알림이 k번 몰리면 집계를 k번에서 한 번으로 묶는다. 모든 세션이 계속 바뀌거나 변경마다 즉시 최신값이 필요하면 이득이 작다. 현재 dirty 집합은 갱신 중의 TEMP 상태이므로 영구 작업 큐를 제공하는 구조는 아니다.

### 3.2 Dirty + processing 분리: 처리 중에 생긴 변경을 잃지 않기

**쉬운 설명.** 작업을 시작할 때 dirty 표시를 지우고 `processing`으로 옮긴다. 실행 도중 같은 대상이 다시 변경되면 dirty에 다시 표시한다. 작업 종료 때 dirty가 남아 있으면 한 번 더 실행한다. Kubernetes의 `client-go` workqueue가 중복 제거와 재처리를 이 두 집합으로 구현한다. [공식 queue.go의 Add/Get/Done](https://github.com/kubernetes/client-go/blob/master/util/workqueue/queue.go)

**예시.** A의 10번째 상태를 계산하는 동안 11번째 상태가 도착했다.

```text
1. Get(A): processing에 A 추가, dirty에서 A 제거
2. 10번째 상태 계산 중
3. Add(A): dirty에 A 추가; 이미 processing 중이므로 동시 실행하지 않음
4. Done(A): processing에서 A 제거
5. dirty에 A가 있으므로 A를 다시 큐에 넣음
```

**적용 구분.** 이는 향후 파일 watcher·백그라운드 dirty 큐를 추가할 때 참고할 후보다. 현재 Agent Tracker는 스캔과 Worker, 동기 DB transaction으로 실행 순서를 관리하며 이 큐를 사용하지 않는다. `RefreshController`가 진행 중 Promise를 공유하는 것도 중복 요청 병합이지 지속적인 변경 큐와 동일한 보장은 아니다.

단일 `dirty=false`를 작업 마지막에 무조건 기록하면 처리 중 발생한 새 표시를 덮어쓸 수 있다. 대안으로 `generation`을 캡처하고 계산 후 같은 세대일 때만 clean 처리할 수 있지만, 이는 여기서 도출한 설계 예시이며 위 코드의 구현 방식은 두 집합이다. 큐 연산과 상태 전이는 lock 또는 DB transaction으로 묶어야 한다.

### 3.3 Affected partition recomputation: 바뀐 구역만 정확히 다시 계산하기

**쉬운 설명.** 전체 집계표를 다시 만들지 않고 영향을 받은 구역의 결과만 지운 뒤, 해당 구역의 원본으로 다시 만든다. TimescaleDB continuous aggregates는 원본 변경의 invalidation 범위를 기록하고 영향을 받은 시간 bucket을 다시 계산한다. 이때 transaction의 수정 시각 최소·최대 범위에 걸친 완전한 bucket을 재계산하므로, 중간의 미변경 bucket까지 범위가 넓어질 수 있다. 이는 세션을 구역으로 쓰는 현재 구현과 개념상 대응한다. 제품·DB 엔진이 같은 것은 아니다. [TimescaleDB continuous aggregates: Invalidation engine](https://www.tigerdata.com/docs/learn/continuous-aggregates)

**예시.** 전체 100개 세션 중 A의 기록만 바뀌었다.

```text
전체 facts: 1,000,000개
A의 facts: 10,000개
갱신 대상: A의 이전 일별 행 삭제 → 현재 A 10,000개를 재집계
나머지 99개 세션: 일별 결과 유지
```

```sql
-- 개념 예시: 실제 제품은 provider/model 두 rollup을 함께 처리한다.
BEGIN IMMEDIATE;
DELETE FROM usage_request_daily
WHERE provider = :provider AND session_id = :session;
-- 이어서 같은 세션의 현재 turn_summary를 GROUP BY하여 INSERT한다.
COMMIT;
```

**현재 대응.** `UsageRollupStore.refresh()`는 세션 단위 `DELETE` 후 `aggregateUsageSource()`의 `INSERT ... SELECT ... GROUP BY`를 실행한다. 세션의 날짜나 프로젝트가 바뀌어도 이전 기여분을 제거할 수 있다는 장점이 있다. 시간대·집계 형식이 바뀌면 `read()`가 전체 rollup을 다시 만든다.

**비용.** 전체 원본 크기 B 대신 영향 세션의 원본 크기 B_affected를 읽지만, 긴 세션의 끝에 한 줄이 붙어도 그 세션 전체를 읽는다. metadata 순회는 별도로 O(F)다. 따라서 현재 파싱 경로를 O(추가 byte)라고 설명하면 틀린다. rollup 갱신도 변경 행 수가 아닌 영향 세션의 facts 수에 비례한다.

**확장 후보.** 장기 세션이 병목이라면 `(provider, session, local_day, project)`를 dirty 구역으로 삼을 수 있다. 변경 전 키와 변경 후 키를 모두 표시해야 한다. 예를 들어 11월 4일 요청이 11월 5일로 이동하면 두 날짜를 갱신해야 한다. 일자별 표시만 추가해도 원본 재파싱은 별도로 남는다.

### 3.4 Delta IVM: 이전 기여분을 빼고 새 기여분을 더하기

**쉬운 설명.** 영향 구역도 다시 스캔하지 않고, 바뀐 사실의 이전 값과 새 값만 집계 상태에 반영한다. 수정은 `이전 행 삭제(-1) + 새 행 추가(+1)`로 생각한다. DBSP 논문은 양·음의 가중치를 가진 관계와 데이터 변화로 이 계산을 일반화한다. PostgreSQL `pg_ivm`은 기존 집계 상태와 변경분을 결합하는 실제 구현 레퍼런스다. [DBSP 논문 §4.1](https://arxiv.org/html/2203.16684v1#S4.SS1), [pg_ivm 공식 README: Aggregates](https://github.com/sraoss/pg_ivm#aggregates)

**예시.** 세션 A의 요청 r1이 토큰 100에서 130으로 보정됐다.

```text
기존 일별 합계 S = 1,000, 요청 수 C = 10
이전 기여분: tokens=100, count=1
새 기여분:   tokens=130, count=1
S' = 1,000 - 100 + 130 = 1,030
C' = 10 - 1 + 1 = 10
새 평균 = 1,030 / 10 = 103
```

**현재 대응.** 큰 세션 저장은 이미 이전·새 snapshot의 차이를 구하지만, rollup에 위 수식을 적용하지는 않는다. 각 교체 대상이 기존 1,000건 이상이고 보존 경로가 아닐 때 TEMP에 새 snapshot을 한 번 적재한다. 변경·추가·삭제 합이 `min(32, floor(기존 요청 수 / 10))` 이하이면 facts·달라진 자식·비용만 수정한다. 변경이 전혀 없으면 rollup 쓰기도 생략한다. 기준을 넘으면 snapshot을 일괄 교체한다.

**이득과 제약.** 단순 SUM·COUNT는 변경 k개와 영향 그룹 g개에 가까운 갱신이 가능하다. SQLite B-tree 탐색·쓰기 비용을 포함하면 대략 O(k log N + g log G)로 생각할 수 있으며 모든 SQL·JOIN의 보편적인 복잡도 보장은 아니다. 이전 기여분을 정확히 알아야 하고 재실행 중복을 막아야 한다. `MIN`·`MAX`의 당선 행이 삭제되면 새 최솟값·최댓값을 다시 찾아야 하며, `DISTINCT`도 개별 값의 출현 횟수 같은 보조 상태가 필요하다. [pg_ivm 공식 README: Aggregates](https://github.com/sraoss/pg_ivm#aggregates)

`REAL` 합계·평균을 증감분으로 누적하면 연산 순서에 따른 반올림 차이가 커질 수 있다. 현재 소요 시간 상태도 `REAL`을 사용하므로 원본 재집계와의 비교 기준이 필요하다. [pg_ivm의 부동소수점 집계 제약](https://github.com/sraoss/pg_ivm#aggregates)

AI 로그에서는 부분 응답 보정·중복 제거·fork 재연결로 한 입력 변경이 여러 사실을 바꿀 수 있다. 따라서 원시 JSONL 한 줄을 바로 `SUM += tokens`로 넣는 대신 **정규화·중복 제거가 끝난 facts의 before/after**를 delta 입력으로 잡는 것이 후보 설계다. 아직 도입·측정하지 않았다.

합계·표본 수를 병합하는 평균의 예시와 현재 정책은 4.2절에 정리했다.

### 3.5 Facts·집계·처리 상태 원자적 반영: 재시도해도 의미가 흔들리지 않기

**쉬운 설명.** facts만 저장하고 dirty를 지우기 전에 중단되면 재시도 중복이 생길 수 있다. 반대로 dirty만 먼저 지우면 갱신이 빠진다. 같은 transaction에서 facts·파생 집계·원본 처리 상태를 모두 확정해야 한다. SQLite는 transaction 단위 원자성을 제공하며 `BEGIN IMMEDIATE`는 쓰기 transaction을 먼저 시작한다. [SQLite Transaction](https://www.sqlite.org/lang_transaction.html), [SQLite Atomic Commit](https://www.sqlite.org/atomiccommit.html)

**예시.** 다음은 영속 dirty 큐를 도입할 때의 축약 설계이며 현재 DDL은 아니다.

```sql
BEGIN IMMEDIATE;
-- 1. 같은 논리 요청 키의 facts를 최신 snapshot으로 교체한다.
-- 2. 해당 facts의 파생 집계를 함께 갱신한다.
-- 3. 원본의 확정 상태/버전을 기록한다.
-- 4. 작업 시작 때 잡은 세대가 그대로인 경우에만 dirty를 해제한다.
COMMIT;
-- 1~4 중 실패하면 전부 ROLLBACK.
```

**현재 대응.** `SessionStore.replaceSessions()`가 manifest, facts, 자식·비용, rollup과 이름 정리를 한 transaction으로 묶는다. 논리 요청의 `UNIQUE(provider, session_id, root_turn_id)`와 snapshot 교체가 재시도 시 통계의 중복 누적을 막는다. 단, metadata 방문·TEMP 비교·작은 세션의 재쓰기까지 사라지는 보장은 아니다. 현재에는 영속 dirty 큐나 byte checkpoint를 추가하지 않았다.

**검증 범위.** 이번 작업은 코드와 공개 레퍼런스 조사다. 후보 알고리즘을 구현하거나 신규 성능 실측을 수행하지 않았다. 기존 [IncrementalRefresh 결과](../benchmarks/2026-10-29/IncrementalRefresh-2026-10-29.md)도 증분 저장의 전체 시간 개선이 일관되지 않았다고 기록한다. 비교 비용·재파싱·쓰기량을 함께 측정해야 실제 이득을 판단할 수 있다.

## 4. 월·일·프로젝트·세션·평균 조회: 작은 집계를 다시 합친다

### 4.1. Data Cube / Roll-up: 원본 요청을 매번 읽지 않는다

**쉽게 설명하면:** 주문 영수증을 매번 전부 더하는 대신 하루 매출 장부를 만들고, 월 매출은 하루 장부를 합산한다. 여기서는 `제공자 × 프로젝트 × 세션 × 현지 날짜`별 합계·표본 수를 보관한다. 월·프로젝트·세션 조회마다 필요한 차원만 남겨 다시 `GROUP BY`한다. Gray 등의 원 논문은 여러 차원의 집계와 하위 집계로부터 상위 집계를 만드는 원리를 설명한다. SQLite에 `CUBE` 문법이 있다는 뜻은 아니다. [Gray et al., Data Cube, 1995 기술보고서 §5](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/tr-95-22.pdf#page=10).

**예시용 스키마:** 아래 `fact`, `daily`는 설명과 실행 검증을 위한 작은 별도 모델이다. 제품 테이블은 `turn_summary`, `usage_request_daily`, `usage_model_daily`이며 그대로 복사한 DDL이 아니다. 이 예시는 `Asia/Seoul`에 해당하는 고정 `+09:00`만 사용한다. DST가 있는 일반 시간대 구현에는 이 고정 오프셋 예시를 쓰지 않는다.

```sql
CREATE TABLE fact (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  project TEXT NOT NULL,
  session TEXT NOT NULL,
  started_ms INTEGER,
  tokens INTEGER NOT NULL,
  duration INTEGER,
  completed INTEGER NOT NULL,
  recorded INTEGER NOT NULL
);

INSERT INTO fact VALUES
  (1,'codex','A','S1',unixepoch('2026-10-31 15:30:00')*1000,100,1000,1,1),
  (2,'codex','A','S1',unixepoch('2026-11-01 01:00:00')*1000,100,2000,1,1),
  (3,'codex','A','S1',unixepoch('2026-11-01 02:00:00')*1000,100,NULL,1,1),
  (4,'codex','A','S2',unixepoch('2026-11-02 00:00:00')*1000,1000,4000,1,1),
  (5,'codex','A','S2',unixepoch('2026-11-02 01:00:00')*1000,0,NULL,1,0),
  (6,'codex','A','S2',unixepoch('2026-11-02 02:00:00')*1000,50,100,0,1),
  (7,'codex','B','S3',NULL,25,500,1,1);

CREATE TABLE daily (
  provider TEXT NOT NULL,
  project TEXT NOT NULL,
  session TEXT NOT NULL,
  local_day TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  turns INTEGER NOT NULL,
  completed_tokens INTEGER NOT NULL,
  completed_count INTEGER NOT NULL,
  recorded_completed_tokens INTEGER NOT NULL,
  recorded_completed_count INTEGER NOT NULL,
  duration_sum INTEGER NOT NULL,
  duration_count INTEGER NOT NULL,
  PRIMARY KEY(provider,session,project,local_day)
) WITHOUT ROWID;

INSERT INTO daily
SELECT provider, project, session,
       coalesce(strftime('%Y-%m-%d',started_ms/1000.0,'unixepoch','+9 hours'),'') AS local_day,
       SUM(tokens), COUNT(*),
       SUM(CASE WHEN completed=1 THEN tokens ELSE 0 END),
       SUM(completed=1),
       SUM(CASE WHEN completed=1 AND recorded=1 THEN tokens ELSE 0 END),
       SUM(completed=1 AND recorded=1),
       coalesce(SUM(CASE WHEN completed=1 THEN duration END),0),
       COUNT(CASE WHEN completed=1 THEN duration END)
FROM fact
GROUP BY provider,project,session,local_day;
```

`daily`는 날짜를 알 수 없는 행을 `local_day=''`로 보관한다. 사용자에게 보여줄 때는 `NULLIF`로 별도의 미상 그룹으로 바꾼다. 예시에서 UTC 10월 31일의 1번 요청은 한국 날짜 11월 1일에 포함된다. [SQLite 날짜 함수](https://www.sqlite.org/lang_datefunc.html).

```sql
-- 일별: 전체 상태의 토큰 합계 + 완료 요청 평균
SELECT provider, NULLIF(local_day,'') AS day,
       SUM(tokens) AS tokens,
       SUM(turns) AS requests,
       1.0*SUM(completed_tokens)/NULLIF(SUM(completed_count),0) AS avg_tokens
FROM daily
GROUP BY provider,day
ORDER BY day;

-- 월별: 일별 상태를 병합한다. 미상 날짜는 NULL 월 그룹으로 남는다.
SELECT provider, substr(NULLIF(local_day,''),1,7) AS month,
       SUM(tokens) AS tokens,
       1.0*SUM(completed_tokens)/NULLIF(SUM(completed_count),0) AS avg_tokens
FROM daily
GROUP BY provider,month;

-- 프로젝트별: 날짜·세션 차원을 합친다.
SELECT provider,project,SUM(tokens) AS tokens,SUM(turns) AS requests
FROM daily
GROUP BY provider,project;

-- 세션별: 프로젝트·세션 차원을 유지한다.
SELECT provider,project,session,SUM(tokens) AS tokens,SUM(turns) AS requests
FROM daily
GROUP BY provider,project,session;
```

**기대 결과:** 11월 1일은 `300 tokens / 3요청`, 11월 2일은 전체 상태 합계 `1050 tokens / 3요청`, 미상 날짜는 `25 tokens / 1요청`이다. 월별 알려진 11월 합계는 1350 tokens, 완료 표본 평균은 `1300/5=260`이다. 프로젝트 A 합계는 1350, 프로젝트 B는 25다. 진행 중인 50 tokens는 합계에 포함되지만 완료 요청 평균에서는 제외된다.

**현재 코드 연결:** [rollup-state.ts](../../src/summary/db/rollup-state.ts), [rollup/usage.ts](../../src/summary/db/queries/rollup/usage.ts), [rollup/source.ts](../../src/summary/db/queries/rollup/source.ts). 제품은 제공자 기준·모델 기준 일별 테이블을 별도로 유지한다. 모든 차원의 조합을 미리 만드는 완전한 데이터 큐브를 구현한 것은 아니다. 비용을 포함하는 조회는 현재 원본 경로를 쓴다.

**장점과 제약:** 기간 안의 요청이 N개, 일별 집계 행이 D개라면 읽어 합칠 입력을 N에서 D로 줄일 수 있다. D가 N에 가까운 짧은 세션이 많으면 이점이 작다. `GROUP BY`·집계 결과 정렬 비용은 남는다. 저장 공간과 갱신 비용도 추가된다. 이 복잡도 비교는 해당 구조에 대한 적용 분석이며, 새 성능 측정 결과는 아니다.

### 4.2. 평균은 평균끼리 더하지 않고 합계와 개수를 합친다

**쉽게 설명하면:** 1일에 9건의 평균이 100이고 2일에 1건의 평균이 1000이면, 월 평균은 `(100+1000)/2=550`이 아니다. `(900+1000)/(9+1)=190`이다. 부분 집계에는 `합계, 개수`를 저장하고 마지막에만 나눈다. Gray 논문에서 평균은 고정 크기의 중간 상태로 병합할 수 있는 **algebraic aggregate**다. [Data Cube §5, PDF p.10](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/tr-95-22.pdf#page=10).

```sql
-- 위 daily 예시: 날짜가 알려진 표본만 비교한다.
SELECT
  1.0*SUM(completed_tokens)/NULLIF(SUM(completed_count),0)
    AS avg_all_completed,
  1.0*SUM(recorded_completed_tokens)/NULLIF(SUM(recorded_completed_count),0)
    AS avg_recorded_completed,
  1.0*SUM(duration_sum)/NULLIF(SUM(duration_count),0)
    AS avg_known_duration
FROM daily
WHERE local_day<>'';
-- 기대: 260, 325, 2333.333...ms
```

`COUNT(*)`는 모든 행, `COUNT(duration)`은 시간이 알려진 행만 센다. 분모가 0이면 `NULLIF(...,0)`로 미상 평균을 반환한다. `1.0*`는 정수 나눗셈을 피한다. SQLite의 `AVG`도 NULL을 제외한 표본의 평균을 구한다. [SQLite AVG·COUNT](https://www.sqlite.org/lang_aggfunc.html).

**현재 코드 연결:** [raw/usage.ts](../../src/summary/db/queries/raw/usage.ts)는 완료 요청을 평균 표본으로 삼는다. `excludeEmptyUsage`가 켜지면 완료 요청 중 `total_tokens>0 OR has_model=1`인 표본만 사용한다. 예시의 `recorded`는 이 실제 판정을 단순화한 값이다. [rollup/metrics.ts](../../src/summary/db/queries/rollup/metrics.ts)는 해당 표본별 합계와 분모를 병합한다. 시간 평균의 분모는 알려진 소요 시간 수다. 캐시 합계는 전체 요청에 미상이 하나라도 있으면 NULL을, 캐시 평균은 선택된 완료 표본에 미상이 하나라도 있으면 NULL을 보존한다.

**주의:** ‘요청당 평균’과 ‘하루당 평균’은 다른 지표다. 최근 30일의 일 평균을 원한다면 활동한 날짜 수인지, 활동이 없는 날을 포함한 달력 30일인지 먼저 정해야 한다. 현재 공개 평균 지표를 임의로 일 평균으로 바꾸지 않는다.

### 4.3. 시간 필터: 경계를 먼저 계산하고 원본 숫자를 범위 검색한다

**쉽게 설명하면:** 모든 요청의 날짜 문자열을 만들어 검사하는 대신, ‘한국 11월의 시작과 끝’을 UTC 밀리초 두 개로 바꾸고 그 사이만 찾는다. `[시작, 다음 시작)`의 반열린 범위를 쓰면 월말의 마지막 밀리초를 계산할 필요가 없다. `>=`, `<` 조건은 SQLite B-tree 범위 탐색에 대응한다. [SQLite WHERE 조건 분석](https://www.sqlite.org/optoverview.html#where_clause_analysis).

```sql
CREATE INDEX ref_fact_period ON fact(started_ms,provider);

-- 한국 2026년 11월: 10월 31일 15:00 UTC 이상, 11월 30일 15:00 UTC 미만.
SELECT SUM(tokens) AS november_tokens
FROM fact
WHERE started_ms >= unixepoch('2026-10-31 15:00:00')*1000
  AND started_ms <  unixepoch('2026-11-30 15:00:00')*1000;
-- 기대: 1350. NULL 시각 행은 이 범위 결과에서 제외된다.
```

**현재 코드 연결:** [common/filters.ts](../../src/summary/db/queries/common/filters.ts)는 epoch 밀리초에 `>=`, `<`를 사용한다. [timezone.ts](../../src/summary/db/timezone.ts)는 `Intl.DateTimeFormat`으로 현지 날짜를 얻고 시작·다음 경계를 각각 이진 탐색하므로 DST가 있는 날을 단순한 `24시간`으로 취급하지 않는다. 제품의 일·월 조회는 기본적으로 미상 시각을 별도 그룹에 유지한다. 위 단순 SQL처럼 NULL을 제외하는 예시와 이 정책을 구분한다.

기간이 `11월 1일 12:00~11월 3일 06:00`처럼 날짜 중간에서 시작·끝나면, 현재 [rollup/source.ts](../../src/summary/db/queries/rollup/source.ts)는 완전한 11월 2일만 일별 집계에서 읽고 양끝 부분을 원본에서 읽어 `UNION ALL`한다. 두 영역이 겹치지 않게 나눠 중복 계산을 피한다. 이는 이번 저장소 코드에서 확인한 혼합 전략이며, 위 SQLite 문서가 이 제품 전략 자체를 제안한 것은 아니다.

## 5. 위 조회에 맞춘 인덱싱 레퍼런스

### 5.1. 복합 B-tree: 자주 고정하는 키 다음에 범위 키를 둔다

**쉽게 설명하면:** 사전을 ‘제공자→프로젝트→날짜’ 순서로 정렬하면 제공자·프로젝트가 같은 구간 안에서 날짜를 찾기 쉽다. 전체 제공자의 날짜 조회에서는 날짜 선두 인덱스가 기본 비교 후보가 된다. 동등 조건의 왼쪽 열부터 쓰고, 이어지는 범위 열까지 탐색하는 것이 기본 원리다. 중간 키가 비면 뒤의 날짜까지 항상 탐색 키로 쓰는 것은 아니다. [SQLite WHERE 분석·인덱스 조건 예](https://www.sqlite.org/optoverview.html#where_clause_analysis).

```sql
-- 예시용 스키마의 프로젝트+기간 탐색 경로.
CREATE INDEX ref_fact_project_period ON fact(provider,project,started_ms);

EXPLAIN QUERY PLAN
SELECT SUM(tokens)
FROM fact
WHERE provider='codex' AND project='A'
  AND started_ms>=unixepoch('2026-10-31 15:00:00')*1000
  AND started_ms< unixepoch('2026-11-30 15:00:00')*1000;
```

**현재 존재하는 접근 경로:** [schema.ts](../../src/summary/db/schema.ts), [rollup-state.ts](../../src/summary/db/rollup-state.ts).

| 조회/작업 | 실제 키/인덱스 | 쓰임과 한계 |
| --- | --- | --- |
| 전체 제공자 원본 기간 조회 | `idx_summary_period(started_at_ms,provider)` | 날짜 범위를 먼저 찾는다. 날짜 범위 뒤의 provider가 별도의 연속 탐색 범위를 항상 줄이는 것은 아니다. |
| 제공자·프로젝트 원본 기간 조회 | `idx_summary_project_period(provider,project_key,started_at_ms)` | 동등 조건 두 개 다음 날짜 범위를 찾는다. |
| 원본 세션 조회·중복 방지 | `UNIQUE(provider,session_id,root_turn_id)` | 제공자·세션 범위는 좁히지만 시간순 인덱스는 아니다. |
| 전체 제공자 일별 기간 조회 | `idx_usage_request_daily_day(local_day,provider)` 및 model 대응 인덱스 | 날짜 선두로 찾는다. |
| 제공자·프로젝트의 일별 기간 조회 | `idx_usage_request_daily_project_day(provider,project_key,local_day)` 및 model 대응 인덱스 | 프로젝트 안의 날짜 범위를 찾는다. |
| 일별 세션 교체·조회 | `PRIMARY KEY(provider,session_id,project_key,local_day[,model_key])` | 세션에 해당하는 본체 구간을 찾는다. project_key를 지정하지 않으면 local_day까지 항상 연속 범위 탐색이 되는 것은 아니다. |

프로젝트의 실제 명칭 검색은 `%이름%` 패턴이므로 위 키 인덱스와 별개의 문제다. 또한 `GROUP BY model`이라고 모델 단일 인덱스를 추가하면 토큰 합계까지 즉시 계산되는 것은 아니다. 선택된 값을 읽고 더하는 비용과 그룹 정렬을 함께 본다.

### 5.2. Covering index와 WITHOUT ROWID: 본체 재접근을 줄인다

**쉽게 설명하면:** 찾는 주소만 인덱스에 두면 주소를 보고 원본 행을 다시 읽어야 한다. 검색 조건과 필요한 숫자를 함께 두면 인덱스만 읽고 끝낼 수 있다. [SQLite Covering Indexes](https://www.sqlite.org/queryplanner.html#covering_indexes).

```sql
-- 예시 후보: 프로젝트의 전체 상태 토큰 합계만을 위한 covering index.
CREATE INDEX candidate_fact_cover ON fact(provider,project,started_ms,tokens);

EXPLAIN QUERY PLAN
SELECT SUM(tokens)
FROM fact
WHERE provider='codex' AND project='A'
  AND started_ms>=unixepoch('2026-10-31 15:00:00')*1000
  AND started_ms< unixepoch('2026-11-30 15:00:00')*1000;
```

이 후보가 모든 평균에 covering인 것은 아니다. 완료 여부·시간 평균도 읽으면 그 열까지 필요하다. 집계 상태 수십 개를 모두 넣으면 인덱스가 커지고 쓰기마다 함께 갱신해야 한다. 기존 좁은 인덱스와의 중복 유지 필요성도 검토한다. 위 후보는 제품에 추가한 인덱스가 아니다.

현재 일별 테이블은 `WITHOUT ROWID`이므로 복합 PK 자체가 본체 B-tree의 키다. 세션 교체는 같은 PK 접두사 구간에 모이지만, 날짜 보조 인덱스만으로 모든 지표의 SUM이 covering되는 것은 아니다. 모든 행에 `WITHOUT ROWID`가 더 빠르다는 일반화도 피한다. SQLite 공식 문서는 큰 행에서 fan-out이 줄어 탐색이 불리해질 수 있다고 설명한다. [WITHOUT ROWID §3·4](https://www.sqlite.org/withoutrowid.html).

### 5.3. Partial / expression index: 특정 표본·특정 계산만 자주 찾을 때

**쉽게 설명하면:** 완료되었고 사용량이 기록된 요청만 찾는 화면에는 그 표본만 담은 작은 색인을 만들 수 있다. 쿼리 조건이 부분 인덱스의 조건을 만족한다는 것을 SQLite가 판별할 수 있어야 한다. 전체 상태 합계에는 이 인덱스만으로 답할 수 없다. [SQLite Partial Indexes §2·3](https://www.sqlite.org/partialindex.html).

```sql
-- 예시 후보: 완료+기록 표본 전용.
CREATE INDEX candidate_fact_recorded
ON fact(provider,project,started_ms,tokens)
WHERE completed=1 AND recorded=1;

SELECT SUM(tokens) AS sum_tokens,COUNT(*) AS samples
FROM fact
WHERE completed=1 AND recorded=1
  AND provider='codex' AND project='A';
-- 기대: 1300, 4. 진행 중 요청과 빈 완료 요청을 제외한다.
```

현재 제품의 주 통계는 **전체 상태 합계와 완료 표본 평균을 한 쿼리에서 함께 계산**한다. 따라서 이 부분 인덱스로 원본 전체를 대체하면 의미가 달라진다. 별도 전용 조회가 충분히 자주 있을 때 검토할 후보다. 현재 제품 DDL에는 이 부분 인덱스가 없다.

계산식 인덱스는 같은 계산을 반복하는 조회에 적용할 수 있다. 예를 들어 일별 테이블의 `substr(local_day,1,7)`별로 월을 찾는 전용 조회다. 인덱스 식과 WHERE/ORDER BY 식이 사실상 같아야 하고, 사용자 함수에는 결정성이 필요하다. 현재 월 쿼리는 `substr(NULLIF(local_day,''),1,length(local_day)-3)`를 쓰므로 아래 단순 식과 자동으로 같다고 취급하면 안 된다. [SQLite Indexes On Expressions §1·2](https://www.sqlite.org/expridx.html).

```sql
-- 예시 후보: 미상 날짜를 제외한 특정 월 탐색.
CREATE INDEX candidate_daily_month
ON daily(substr(local_day,1,7),provider)
WHERE local_day<>'';

SELECT SUM(tokens)
FROM daily
WHERE local_day<>'' AND substr(local_day,1,7)='2026-11';
-- 기대: 1350.
```

월 인덱스는 월 구간을 찾는 비용을 줄이는 후보다. 그 월의 모든 집계값을 읽고 더하는 비용 자체를 없애지는 않는다. 월 전용 rollup을 추가하는 선택은 별도의 저장·무효화·갱신 정책까지 필요하다.

### 5.4. 실행 계획과 쓰기 비용까지 확인한다

**쉽게 설명하면:** 인덱스를 만들었다는 사실보다 ‘실제로 어느 구간을 읽었는지’를 본다. `EXPLAIN QUERY PLAN`의 `SEARCH`, `COVERING INDEX`, `USE TEMP B-TREE`를 확인하고 같은 입력의 읽기·쓰기·공간을 비교한다. 출력 문자열은 SQLite 버전에 따라 바뀔 수 있다. [SQLite EXPLAIN QUERY PLAN](https://www.sqlite.org/eqp.html).

기존 [11월 3일 세션 시간 인덱스 A/B](../benchmarks/2026-11-03/SessionTimeIndexAB-2026-11-03.md)는 `(provider,session_id,started_at_ms)` 하나를 **실험 후보**로 추가했다. 합성 1만 요청 DB의 기존 데이터에 처음 생성한 공간은 +424KiB였고, 1,000요청/세션 입력의 요청 추가 갱신은 +3.735~5.933ms였다. 이는 당시 장비·입력의 기존 실측이며 새 측정이 아니다. 현재 schema v16에는 그 인덱스가 없다. 읽기 후보 평가와 갱신 비용을 함께 봐야 한다.

현재 [connection.ts](../../src/summary/db/connection.ts)는 열 때 `PRAGMA main.optimize=0x10002`, 이후 하루 간격·닫을 때 `PRAGMA main.optimize`를 이미 실행한다. 이는 장기간 연결의 통계를 유지하는 SQLite 권장 패턴과 대응한다. 새 기능으로 중복 도입할 필요는 없다. [SQLite ANALYZE §2.1](https://www.sqlite.org/lang_analyze.html#periodically_run_pragma_optimize).

### 5.5. Keyset pagination: 상세 행을 끝까지 넘길 때 앞부분을 반복해서 버리지 않는다

**쉽게 설명하면:** ‘10만 개를 건너뛰고 다음 100개’ 대신 ‘직전 마지막 ID보다 큰 다음 100개’를 가져온다. 정렬 키와 맞는 인덱스가 있을 때 깊은 OFFSET의 반복 건너뛰기를 줄일 수 있다. [SQLite Row Values §3.1](https://www.sqlite.org/rowvalue.html#scrolling_window_queries).

```sql
-- 위 fact 예시: 3번까지 읽었으면 그 다음 100개를 읽는다.
SELECT id,session,tokens
FROM fact
WHERE id>3
ORDER BY id
LIMIT 100;
```

현재 제품의 상세 요청·진단 API와 비용 재계산 ID 순회에는 keyset 경로가 있다. 반면 집계표는 합계·평균 등의 정렬과 전체 개수에 `LIMIT/OFFSET`을 사용한다. 원본 상세 행용 keyset을 집계표에 그대로 적용하면 전체 범위의 집계 비용이 자동으로 사라지지 않는다. 특정 세션 조건까지 붙인 비용 재계산은 기존 세션 UNIQUE 키와 rowid 정렬의 조합을 실제 계획으로 확인해야 하며, 시간 인덱스가 그 ID 커서까지 항상 해결한다고 가정하지 않는다. [reader.ts](../../src/summary/db/reader.ts), [billing.ts](../../src/summary/db/billing.ts).

## 이 저장소에서 레퍼런스를 활용할 때의 판단 순서

| 병목이 확인된 상황 | 먼저 비교할 후보 | 줄이려는 비용 | 함께 확인할 비용·정확성 |
| --- | --- | --- | --- |
| 큰 본문을 읽는데 통계 필드는 적음 | SAX·On-Demand·Mison·JSONSki의 선택 파싱 개념 | 객체·문자열 변환과 할당 | 문법 오류 검출, 도구·수명주기 필드 누락, native 배포 비용 |
| 긴 세션의 끝에 몇 줄만 추가됨 | Filebeat식 identity+offset+parser 문맥 checkpoint | 이미 읽은 원본 재독해·재파싱 | rewrite·축소·fork·압축 파일, DB와 cursor 원자적 확정 |
| 작은 수정에도 세션 집계를 다시 만듦 | dirty 구역 세분화 또는 정규화 facts의 delta IVM | 무관한 facts의 재집계 | 변경 전·후 날짜/프로젝트, MIN/MAX·NULL·부동소수점, 재시도 중복 |
| 같은 세션의 기간·최초 시각 조회가 반복됨 | 세션·시간 복합 인덱스와 SQL 식을 함께 비교 | 세션 내부 탐색·본체 재접근 | 요청 추가 지연, DB/WAL 공간, 다른 조회의 계획 변화 |
| 월·평균 조회에 많은 요청을 읽음 | 현재 일별 상태 재사용을 기준으로 추가 집계 검토 | 집계 입력 행 수 | 세션이 짧으면 일별 행 수가 원본에 가까움, 저장·무효화 비용 |

위 표는 병목에 따른 **조사·비교 순서**이며 새 기능의 채택 결정이나 성능 보장이 아니다. JSON 구조 인덱스(Mison)는 문자 위치를 찾는 자료구조이고, SQLite B-tree 인덱스는 DB 행을 찾는 자료구조다. 둘은 이름이 같아도 대상으로 하는 비용이 다르다.

기존 [JSONL 파싱 비교](../benchmarks/2026-10-09/JsonlParsingBranches-2026-10-09.md), [증분 갱신 비교](../benchmarks/2026-10-29/IncrementalRefresh-2026-10-29.md), [단순 인덱스 비교](../benchmarks/2026-11-03/SimpleIndexAB-2026-11-03.md), [TEMP 묶음 제품 확인](../benchmarks/2026-11-04/TempBatchProduct-2026-11-04.md)는 각 시점·입력의 결과다. 논문의 속도 배수나 과거 실험 수치를 현재 제품 전체의 개선율로 옮기지 않는다.

검증: 4·5절의 SQL **9개 블록**을 Node v24.19.0 / SQLite 3.53.3 메모리 DB에서 실행했다. 일·월·프로젝트·세션 합계, 완료 평균 260, 기록된 완료 평균 325, 알려진 완료 소요 시간 평균 2333.333…ms를 기대값과 대조하고 원본·일별 집계 결과의 일치를 확인했다. 복합 인덱스 `SEARCH`와 `COVERING INDEX` 실행 계획도 확인했다.

현재 소스와 공개 출처를 대조하고, 내부 링크 **56개**의 경로·외부 출처 **32개**의 접근·문서 형식·`git diff --check`를 확인했다. 외부 출처 중 Microsoft의 두 링크는 직접 HTTP 요청이 403을 반환해 웹 열람 도구로 본문을 확인했다. 이번 작업에서 후보 알고리즘 구현·새 성능 벤치마크·실계정 로그 파싱은 수행하지 않았다.
