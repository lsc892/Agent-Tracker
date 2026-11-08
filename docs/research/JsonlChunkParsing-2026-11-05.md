# JSONL 청크 파싱의 개선 원인과 추가 최적화 후보

조사 기준: 2026-11-05, Asia/Seoul. 현재 제품 코드·같은 날짜의 A/B 결과와 공식 문서·원 논문을 대조했다. 추가 후보는 이 문서에서 구현하거나 새로 성능 측정하지 않았다.

## 1. 이번에 바뀐 부분

변경 전에도 파일을 최대 64 KiB씩 읽었다. 이번 변경은 **같은 청크 안의 완성된 줄들을 한 번에 UTF-8 문자열로 변환하는 것**이다. [현재 코드](../../src/summary/jsonl/index.ts#L192), [A/B 보고서](../benchmarks/2026-11-05/JsonlChunksAB-2026-11-05.md)

| 작업 | 변경 전 A | 변경 후 B |
| --- | --- | --- |
| 파일 읽기 | 최대 64 KiB씩 | 최대 64 KiB씩 |
| 청크 안의 완성된 일반 줄 | 줄마다 Buffer.toString → JSON.parse | 완성 구간당 Buffer.toString 한 번 → split → 줄마다 JSON.parse |
| 이전 청크에서 이어지는 첫 줄 | JsonlLine에 원본 바이트를 이어 붙임 | 동일 |
| LF 뒤의 미완성 끝줄 | 다음 청크까지 보관 | 동일 |
| 이미지 후보 | 문자열 문법을 추적하며 이미지 본문 폐기 | 동일 |

실제 흐름은 다음과 같다.

```text
현재 청크: [이전 줄의 나머지]\n [완성 줄 A]\n [완성 줄 B]\n [다음 줄의 앞부분]
             ↓                   └───────┬─────────┘                 ↓
       기존 줄과 바이트 연결       한 번 UTF-8 변환 → split       다음 청크까지 보관
             ↓                           ↓
        JSON.parse                 줄마다 JSON.parse
```

완성된 일반 줄이 한 청크 안에 200개 있으면 그 구간의 UTF-8 변환 호출은 200회에서 1회로 줄지만 JSON.parse는 여전히 200회다. 디코딩하는 총 바이트 양도 비슷하다. **변환 호출의 고정 비용을 여러 줄이 나눠 부담하는 것**이 코드에서 확인되는 이득이다. Buffer.toString은 지정 범위를 해당 인코딩으로 디코딩한다. [Node Buffer.toString](https://nodejs.org/download/release/v24.19.0/docs/api/buffer.html#buftostringencoding-start-end)

청크 양 끝에서 잘리는 UTF-8은 원본 바이트로 이어 붙인다. 원본 offset도 문자열 길이가 아닌 Buffer의 LF 위치로 계산한다. 한글·이모지와 잘못된 UTF-8의 치환 때문에 문자열 길이와 원본 byte 수가 달라질 수 있다.

## 2. 무엇이 실제로 개선됐는가

| 측정 | A → B | 해석 |
| --- | --- | --- |
| 짧은 줄 10,000행 읽기·파싱 | 24.485 → 22.726ms | 중앙값 7.2% 감소, 9/10쌍에서 B가 빠름 |
| 128 KiB 본문의 긴 줄 100행 | 74.704 → 74.682ms | 차이 거의 없음 |
| 실제 로그 전체 갱신 | 14,969.050 → 14,931.459ms | 0.25% 감소, 3/10쌍에서만 B가 빠르므로 개선 확인 못함 |
| 실제 Claude 요청 한 건 추가 | 212.805 → 230.108ms | 중앙값 8.1% 증가 |
| 짧은 줄 10,000행 프로세스 최대 RSS | 49.63 → 49.83 MiB | 메모리 절감 확인 못함 |

코드상 UTF-8 변환 호출을 줄인 사실과 리더의 실행 시간 감소는 확인됐다. 정확히 어느 함수의 CPU·할당·GC 시간이 얼마나 줄었는지는 계측하지 않았다. 줄 배열의 추가 할당과 중복 탐색은 비용 후보지만 Claude 추가가 느려진 원인으로 확정할 수 없다.

전체 갱신에는 JSON.parse, 제공자 이벤트 해석, fingerprint 계산, SQLite 임시 적재·집계·저장 비용이 그대로 남는다. 이 사실은 리더의 개선율을 전체 갱신에 그대로 적용할 수 없는 이유다. 각 구간의 실제 시간 비중은 후속 프로파일링이 필요하다. A/B 모두 시간 O(N), reader 보조 공간 O(C + min(L,K))이며 B의 청크 문자열·줄 배열은 O(C) 임시 공간을 쓴다.

## 3. 현재 구현에서 먼저 실험할 후보

### 3.1 짧은 줄이 많을 때만 묶어서 디코딩

**방법:** 모든 완성 구간을 같은 방식으로 처리하기보다, 여러 짧은 줄이 모인 경우에만 묶음 디코딩을 적용하고 줄이 적거나 긴 경우에는 줄별 직접 파싱을 비교한다. 긴 줄·이미지의 기존 경로는 유지한다.

**기대 효과:** 묶음 처리의 고정 비용을 나눌 줄이 적을 때 줄 배열 생성 비용을 피한다. 이번 입력별 A/B 결과에서 도출한 **적용 가설**이며 공개 자료가 특정 분기 기준이나 개선율을 보장하는 것은 아니다.

**비용·검증:** 줄 수를 알아내려고 청크 전체를 추가로 스캔하면 이득이 사라질 수 있다. 이미 찾은 LF·첫 줄 길이 등 재사용 가능한 정보로 판단하고, 모든 입력에서 분할 정책이 결과·오류·offset을 보존하는지 확인해야 한다. Claude 한 건 추가의 회귀와 짧은 줄 이득을 함께 본다.

### 3.2 청크 크기를 32·64·128·256 KiB로 비교

**방법:** 한 번 읽는 크기를 바꿔 파일 읽기·비동기 대기·디코딩 호출 횟수와 청크에 걸리는 줄의 비율을 함께 측정한다. 현재 일반 파일은 직접 filehandle.read를 호출하므로 Buffer 크기를 조절하는 실험이다. createReadStream으로 바꿔야만 가능한 최적화는 아니다. [Node FileHandle.read](https://nodejs.org/download/release/v24.19.0/docs/api/fs.html#filehandlereadbuffer-offset-length-position)

**기대 효과:** 충분히 큰 파일에서 매번 버퍼를 채워 읽는다면 64 KiB에서 256 KiB로 늘릴 때 읽기 호출 수는 대략 1/4이 된다. 긴 줄을 구성하는 조각 수도 줄 수 있다. 이는 호출 횟수의 산술적 변화이며 실제 실행 시간의 4배 개선을 뜻하지 않는다.

**비용·검증:** 청크 문자열·줄 배열이 커지고 한 배치를 처리하는 시간도 늘어 취소 응답이 늦어질 수 있다. 일반 파일 입력 크기와 Zstd 해제 출력 크기는 별도다. 처리량뿐 아니라 peak RSS·가장 느린 배치·취소 지연을 함께 측정해야 한다. 파일보다 청크가 이미 큰 소량 입력에는 효과가 작다.

### 3.3 복사와 재할당을 줄이되 버퍼 수명을 지킨다

**방법:** 같은 읽기 버퍼를 재사용하고 즉시 소비하는 범위는 subarray로 전달한다. 여러 청크에 걸친 줄은 매번 전체 누적 내용을 concat하지 않고 조각을 유지하다 완성 시 결합한다. 현 제품도 읽기 버퍼 재사용·구간 복사·블록 누적을 이미 하므로 남은 복사와 할당을 먼저 계측한다. [Node Buffer.subarray](https://nodejs.org/download/release/v24.19.0/docs/api/buffer.html#bufsubarraystart-end), [simdjson parser/buffer 재사용 지침](https://github.com/simdjson/simdjson/blob/master/doc/performance.md)

**기대 효과:** 같은 줄의 길이가 늘 때 앞부분을 반복 복사하는 일을 피하고 할당/GC 비용을 줄인다. 일정 크기 조각을 붙일 때마다 누적 전체를 복사하는 구현은 긴 줄에서 초선형 복사 비용을 만들 수 있다. 현 구현의 블록 누적은 이미 이 문제를 피한다.

**비용·검증:** subarray는 원본 메모리를 공유한다. 읽기 버퍼를 덮어쓴 뒤에도 조각을 보관하면 데이터가 바뀐다. 현재 압축 입력의 Buffer.from은 decoder의 선행 읽기에 대비한 복사이므로 수명 설계 없이 제거할 수 없다. 작은 view가 큰 버퍼 전체를 오래 붙잡거나, 풀에 큰 줄 버퍼를 무한히 남기지 않도록 총 보유량을 제한한다.

### 3.4 다음 청크 한 개만 미리 읽는 두 버퍼 구조

**방법:** 버퍼 A의 청크를 파싱하는 동안 버퍼 B에 다음 청크의 비동기 읽기를 요청한다. 대기 중인 청크는 한 개처럼 고정된 수로 제한한다. 소비 속도에 맞춰 공급을 멈추는 backpressure가 필요하다. [Node stream buffering/backpressure](https://nodejs.org/download/release/v24.19.0/docs/api/stream.html#buffering)

**기대 효과:** I/O 대기와 현재 청크의 CPU 작업을 겹칠 수 있다는 **적용 가설**이다. 이미 OS 캐시에서 읽거나 SQLite 작업이 지배하면 효과가 작을 수 있다.

**비용·검증:** 버퍼 메모리가 늘고 조기 종료·취소 후 미리 읽은 바이트의 집계, onChunk fingerprint, 관측 파일 크기, 파일 닫기와 pending read의 수명을 정해야 한다. file read는 processBatch의 DB 트랜잭션 밖에 둬야 한다. highWaterMark는 일반적으로 엄격한 전체 메모리 상한이 아니라 공급을 멈추는 임계값이다.

## 4. 파서 구조를 바꾸는 추가 후보

### 4.1 필요한 필드만 실제 값과 객체로 만든다

**방법:** 전체 행의 객체를 만든 뒤 usage를 고르는 대신, 구조를 읽으면서 type·session·turn·model·usage·수명주기·이름·도구 집계에 필요한 필드만 결과로 구성한다. 큰 도구 출력은 값으로 만들지 않고 통과시킨다. SAX 토큰 API나 On-Demand 파싱이 참고 구현이다. [stream-json 공식 저장소](https://github.com/uhop/stream-json), [simdjson On-Demand 설계](https://github.com/simdjson/simdjson/blob/master/doc/ondemand_design.md)

**기대 효과:** 청크 분할의 호출 비용을 넘어 JSON 객체·큰 문자열의 생성량을 줄일 수 있다. 현재는 data:image의 Base64 본문에만 좁게 적용한 개념이다. JavaScript로 토큰 callback을 많이 호출하면 native JSON.parse보다 느릴 수도 있으므로 속도 개선은 미확인이다.

**비용·검증:** 키 순서·중첩·escape에 대응해야 하며 usage 행 외에도 요청·모델·수명주기·tool 정보가 필요하다. 단순 부분 문자열 검색으로 이벤트를 생략하면 본문 안의 같은 문자열과 혼동할 수 있다. On-Demand는 사용하지 않은 값의 완전한 검증을 생략할 수 있어 현재 손상 JSON 오류 정책과 맞추는 비용도 비교해야 한다.

### 4.2 여러 JSON 문서를 한 번의 native 호출로 파싱

**방법:** simdjson의 iterate_many/parse_many처럼 여러 줄을 한 묶음으로 넘기고 파서와 작업 버퍼를 재사용한다. SIMD 구조 탐색과 Node/native 경계를 넘는 호출 비용을 여러 문서가 나눠 부담하도록 설계한다. SIMD는 여러 바이트의 구조 문자를 병렬로 검사하는 방식이다. [simdjson iterate_many 설계](https://github.com/simdjson/simdjson/blob/master/doc/iterate_many.md), [Parsing Gigabytes of JSON per Second](https://arxiv.org/abs/1902.08318)

**기대 효과:** 구조 문자 탐색과 반복 파서 초기화·할당을 줄일 수 있다. 한 줄마다 native 함수를 호출하고 전체 객체를 다시 JS 객체로 옮기는 방식보다, 여러 줄에서 필요한 숫자·ID만 반환하는 구조를 비교할 가치가 있다. Agent Tracker에서의 개선율은 미측정이다.

**비용·검증:** 읽기 청크 크기와 파서 배치 크기는 같은 개념이 아니다. 긴 JSON 문서·이미지·미완성 끝단을 지원하고 문서/배치 용량 조건을 맞춰야 한다. 오류 위치·전체 입력 소비·검증 범위를 보존해야 하며 VS Code용 운영체제·아키텍처별 바이너리 배포 비용이 생긴다.

### 4.3 문법 파싱을 병렬화하고 이벤트 적용 순서를 보존

**방법:** CPU가 병목으로 확인되면 고정 Worker 풀에서 파일 또는 완성된 문서 묶음을 파싱하고 정규화·DB 반영으로 전달한다. 매 청크마다 Worker를 새로 만들지 않는다. [Node Worker threads](https://nodejs.org/download/release/v24.19.0/docs/api/worker_threads.html), [simdjson의 문서 경계 분할](https://github.com/simdjson/simdjson/blob/master/doc/iterate_many.md#parsing-on-many-threads)

**기대 효과:** 독립적인 JSON 문법 파싱의 CPU 작업을 여러 코어가 나눌 수 있다. Node 공식 문서는 Worker가 CPU 작업에 유용하며 일반적인 I/O 작업에는 큰 도움이 되지 않는다고 설명한다.

**비용·검증:** JSONL 문서의 문법 파싱은 독립적이어도 이벤트 해석은 순서에 의존한다. 현재 Codex adapter는 session·turn·model·legacy 누계를, Claude adapter는 현재 요청 문맥을 유지한다. 임의의 청크부터 adapter를 시작하면 잘못 집계할 수 있다. 파일 내 순서·결과 재정렬 큐의 byte 상한·Worker 메모리·단일 SQLite writer의 처리량을 함께 관리해야 한다.

## 5. 우선 확인할 계측과 유지할 계약

먼저 읽기 대기, 줄 구성/디코딩, JSON.parse, adapter, TEMP 적재·저장 구간을 나누고 짧은 줄/긴 줄/이미지/실제 Claude 추가의 비용을 확인하는 것이 적절하다. 그 결과에 따라 선택적 묶음 처리와 청크 크기를 작은 후보로 비교하고, 객체 생성이 지배하면 필드 선택·문서 묶음 native 파싱을 검토한다. 이 순서는 현재 A/B 결과와 구현 비용을 고려한 제안이다.

필수 보존 항목은 UTF-8 경계, CRLF, 미완성 마지막 줄 유예, 이미지의 escape/control 검증, 보관 줄 예산, 원본 byte offset, 관측 파일 크기, 취소, raw fingerprint, 요청 순서와 집계 결과다. StringDecoder는 청크 끝의 미완성 멀티바이트 문자를 내부에 보관하는 공식 API이지만, 이것으로 바꾸는 것 자체를 성능 개선으로 보지 않는다. 이 제품은 이미지 제거·byte 예산과 offset도 함께 다뤄야 한다. [Node StringDecoder](https://nodejs.org/download/release/v24.19.0/docs/api/string_decoder.html)
