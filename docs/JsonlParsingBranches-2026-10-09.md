# JSONL 파싱 전용: 적용 전·후 브랜치 비교

2026-10-09 Asia/Seoul. 같은 JSONL Buffer에 대해 줄 분리·문자열 처리·이미지 제거·UTF-8 변환·JSON.parse의 실행 시간을 비교했다. **파일 I/O·adapter·SQLite는 파싱 시간에 포함하지 않는다.** 이전 [reader+adapter 측정 보고서](JsonlReaderTradeoff.md)와 [이전 측정 JSON](benchmarks/JsonlReaderTradeoff.json)은 원본 그대로 보존했다.

이 비교의 규모 기준은 파일 개수가 아니라 JSONL 행 수와 원본·보관 바이트다. 원본 파일 경계는 offset과 부분 줄 처리를 동일하게 검증하기 위한 입력 metadata로만 유지한다.

## 브랜치와 데이터 보존

| 구분 | 브랜치 | 측정한 reader |
|---|---|---|
| 적용 전 | `bench/jsonl-parse-before-20261009` | `3f5b49b3fefd32847399e9042c9fe9ca8ddcab24`의 바이트별 reader |
| 적용 후 | `bench/jsonl-parse-after-20261009` | 같은 commit 위에 현재 `src/summary/jsonl.ts` 개선을 적용한 상태 |

각 브랜치는 별도 worktree에 체크아웃하여 빌드했다. 적용 후 변경은 아직 커밋하지 않았으며 현재 작업 폴더의 reader와 동일한 소스 hash를 사용한다. 두 브랜치의 소스·컴파일 결과 hash를 [새 원시 결과](benchmarks/JsonlParsingBranches-2026-10-09.json)에 기록했다. 측정 시 원래 작업 폴더는 `dev`였으며 미커밋 변경을 유지했다.

이전 고정 사본을 다시 사용하고 모든 입력 Buffer의 크기·SHA-256을 실행 전에 확인했다. 이전 결과를 새 값으로 덮어쓰지 않았다. 이전 측정 JSON의 SHA-256은 측정 전후 모두 다음과 같다.

```text
93856c0fd093652dfe9b24c12c57aae8ea4e1c50d22d9d2edc60af4504758e93
```

기존 보고서·측정 JSON·입력 manifest의 별도 사본과 적용 전후 소스·reader patch는 `tests/.cache/jsonl-parsing-branches-20261009`에 보관한다. 대화 원문과 원본 경로는 이 보고서와 결과 JSON에 넣지 않는다.

## 측정 범위와 조건

실행 환경은 Windows x64 / Node v24.19.0이다. [동일 측정 실행기](../tests/benchmarks/jsonl-parsing-branches.cjs)가 두 브랜치의 실제 빌드된 reader를 호출한다. 제품 reader 소스를 측정을 위해 변경하지 않았다.

입력 전체를 측정 전에 메모리에 준비하고 `node:fs/promises.open`을 해당 Buffer만 읽는 RAM handle로 대체한다. 따라서 reader 실행 중 디스크 open/read/close가 발생하지 않는다. 시간은 reader의 기존 `processBatch(parseRows)` 경계에서 동기 `parseRows()` 실행 시간만 합산한다. RAM 입력에서 재사용 64 KiB chunk로 복사하는 시간과 async await·초기화도 주 지표에서 제외한다.

포함 범위는 LF 탐색, 줄 구성, 이미지 Base64 제거와 문자열 검증, UTF-8 변환, JSON.parse, object schema 검사와 row-count callback이다. adapter와 SQL은 호출하지 않는다. 전체 row·원본 offset·read 결과 digest, JSON.parse 세부 trace와 메모리 관측은 시간 비교와 별도로 실행한다.

각 시간 측정은 새 프로세스에서 입력 1회 워밍업 후 명시적 GC를 하고 실행한다. 3쌍을 전/후 → 후/전 → 전/후 순으로 순차 실행했다. 소량은 500회 반복의 파싱 시간 합계를 500으로 나누고, 나머지는 전체 입력 1회당 값을 비교한다. 따라서 이전 최초 JIT·파일 I/O·adapter를 포함한 시간과 절대값을 직접 비교하지 않는다.

## 입력 규모와 복잡도

N은 원본 byte, B는 이미지 제거·trim 후 JSON.parse에 전달된 전체 byte, L은 이 보관 JSON의 최대 줄 byte, K는 줄 예산, C는 chunk 크기(64 KiB)다. B와 L은 별도 trace 실행에서 양쪽 값이 같음을 확인했다.

| 입력 | JSONL 행 | N: 원본 byte | B: 파싱한 JSON byte | L: 최대 보관 줄 byte |
|---|---:|---:|---:|---:|
| 소량 합성 | 40 | 14,300 | 14,260 | 421 |
| 대량 합성 | 8,000 | 18,251,200 | 18,243,200 | 4,266 |
| 큰 이미지 | 2 | 33,554,543 | 109 | 77 |
| 실제 고정 사본 | 53,271 | 208,617,531 | 204,542,380 | 1,268,923 |

| 항목 | 구현 전 | 구현 후 |
|---|---|---|
| 전체 파싱 시간 | O(N + B), 일반적으로 O(N) | 동일; byte별 JS 호출·검사·복사를 줄이는 상수 비용 개선 |
| 원본 전처리 | 모든 byte에 상태 검사·줄 block 쓰기 | native LF 탐색과 일반 줄 직접 파싱, 이미지/경계 줄은 delimiter 캐시·구간 복사 |
| JSON.parse | 보관 JSON B에 비례 | 같은 JSON.parse 사용 |
| parser 보조 공간 | O(C + min(L,K)), 반환 row 제외 | 동일; 일반 줄의 block/concat 생략, 이미지 검사에는 C 이내 임시 문자열 사용 |
| 측정용 입력 공간 | 미리 적재한 O(N) Buffer | 동일, 제품 parser의 공간복잡도에서 제외 |

큰 이미지의 원본 32 MiB를 JSON.parse에 통째로 넣지 않는다. 보관된 JSON은 109 bytes이고 해당 시나리오의 K는 1 KiB이다. 다른 시나리오는 기본 K=4 MiB다. JSON 객체 자체와 GC·런타임 비용은 별도로 발생한다.

## 파싱 시간 결과

아래는 **파싱 구간만의 3쌍 중앙값**이다.

| 입력 | 전 → 후 | 시간 감소 | 전/후 배수 | 전 범위 → 후 범위 |
|---|---:|---:|---:|---:|
| 40행 | 0.422 → 0.124 ms | 70.6% | 3.40배 | 0.413–0.497 → 0.115–0.137 ms |
| 8,000행 | 398.798 → 71.342 ms | 82.1% | 5.59배 | 370.541–458.191 → 54.769–172.269 ms |
| 32 MiB 이미지가 포함된 2행 | 354.863 → 35.343 ms | 90.0% | 10.04배 | 348.373–362.387 → 31.857–35.682 ms |
| 실제 53,271행 | 4,941.028 → 1,718.516 ms | **65.2%** | **2.88배** | 4,419.692–5,681.257 → 1,712.377–1,824.037 ms |

대량 합성의 후 조건은 54.769–172.269 ms로 변동이 있어 중앙값과 범위를 함께 보존했다. 모든 쌍을 결과에 포함했고 유리한 실행만 선택하지 않았다.

JSON.parse만의 별도 1회 진단에서는 실제 입력이 680.797 → 592.503 ms였고 호출 수는 양쪽 모두 53,271회였다. 이 진단은 최초 JIT와 호출별 타이머·byte 계수의 영향을 포함하므로 반복 시간 비교와 합산하지 않는다. JSON.parse 구현을 바꾼 결과가 아니며 같은 입력이라도 문자열 준비·할당·GC 상태에 따라 시간이 달라질 수 있다. 주 개선은 줄 구성·sanitizer·복사 비용을 줄인 데 있다.

## 공간 관측과 트레이드오프

입력 적재 후 GC를 한 기준점부터 chunk 처리 전후에 별도 1회 관측했다. hash나 adapter는 실행하지 않는다. 아래 값은 기준점 대비 관측 peak 증가량이며 MiB=1,048,576 bytes다. 지표별 최대값의 시점은 다를 수 있고, allocator·GC·런타임도 포함한다.

| 입력 | RSS 증가 전 → 후 | heapUsed 증가 전 → 후 | arrayBuffers 증가 전 → 후 |
|---|---:|---:|---:|
| 40행 | 1.75 → 0.10 MiB | 0.19 → 0.11 MiB | 0.06 → 0.00 MiB |
| 8,000행 | 9.66 → 6.10 MiB | 2.33 → 2.32 MiB | 7.44 → 1.75 MiB |
| 큰 이미지 2행 | 4.72 → 2.65 MiB | 2.11 → 2.08 MiB | 0.06 → 0.06 MiB |
| 실제 53,271행 | 59.25 → 42.79 MiB | 16.27 → 16.52 MiB | 40.25 → 9.46 MiB |

측정용 Buffer는 실제 입력에서 약 199 MiB이며 이미 기준 RSS에 포함된다. 전체 입력을 적재한 실험의 절대 RSS를 스트리밍 제품의 메모리 사용량으로 해석하지 않는다. 이전 실험에서 실제 사본의 RSS가 94.14 → 82.07 MiB였던 값도 그대로 보존하며, 이번의 증가량과 같은 지표로 섞지 않는다.

Buffer 복사는 줄었지만 문자열 경계 캐시·일반 줄/이미지/escape 경로를 관리하는 구현 복잡성이 추가됐다. 이미지 유효성 검사에는 chunk 크기 이내 임시 Latin-1 문자열이 필요하며 실제 사본의 heapUsed 증가량은 소폭 높았다. 한 번의 메모리 관측과 chunk 경계 sample만으로 최대 메모리의 고정 상한이나 정확한 할당량 감소를 단정하지 않는다.

## 정확성·검사

양쪽은 모든 입력의 전체 JSON row·원본 byte offset·부분 줄 여부·읽은 byte·행 수 digest가 일치했다. JSON.parse에 전달한 B와 호출 수도 같다. 합성 입력의 독립 기대 행 수 40·8,000·2를 확인했다. 시간 실행에서도 처리 행 수가 정확성 실행과 일치한다.

추가 정합성 확인에서는 1·2·3·7·63·1,024·65,535·65,536 byte의 짧은 읽기를 RAM handle로 재현해 1,216개 입력 조건을 구 reader와 비교했다. 이미지 안의 모든 control byte·유효/무효 escape, UTF-8, 64 KiB 전후 snapshot, 줄 예산, 조기 중단과 seeded JSON byte 변형을 포함하며 JSON row·원본 offset·부분 줄·오류 code/offset·callback/batch 횟수·handle 닫기가 모두 일치했다. 이는 확인한 입력에서의 동일성 검증이며 모든 가능한 입력의 무결함을 증명하지 않는다.

같은 경계 테스트 8개를 두 worktree의 실제 reader에 각각 실행해 통과했다. 이미지 헤더의 chunk 경계, UTF-8, 줄 예산, escape/control 오류, 오류 offset, seeded 중첩 JSON, 부분 snapshot, 조기 중단, 취소·파일 축소를 확인했다. 제품 구현은 앞서 검증한 구간 처리와 동일하며 추가 기능 변경은 없다. 최종 `npm run check`의 타입 검사·린트·230개 테스트를 통과했다. 새 측정 실행기의 구문·실제 소량/이미지 smoke 실행·전체 3쌍 비교·스킬 형식 검증·보고서 링크와 `git diff --check`도 확인했다. VS Code 화면·전체 DB 갱신·서버 quota는 이번 파싱 전용 측정 범위에 포함하지 않는다.

## 재현과 보존 위치

측정에는 다음 두 worktree를 사용했다. 사용자의 정리 요청으로 2026-10-09에 두 worktree와 실험용 브랜치를 제거했다. 현재 작업 폴더와 측정 데이터·입력·소스 사본은 유지한다.

- `../Agent-Tracker-bench-jsonl-before-20261009`: 적용 전 브랜치
- `../Agent-Tracker-bench-jsonl-after-20261009`: 적용 후 브랜치와 현재 reader patch

새 측정 setup은 `tests/.cache/jsonl-parsing-branches-20261009/setup.json`, 입력은 이전 `tests/.cache/jsonl-reader`의 고정 사본을 사용한다. 정리한 worktree 경로는 당시 실행 기록이며 현재 존재하지 않는다. reader 변경·입력 변경은 hash 검사에서 거부한다. 기존 setup을 다시 덮어쓰거나 결과 파일을 교체하지 않도록 prepare와 결과 쓰기는 생성 전용이다.

```powershell
# 정리한 worktree를 아래 설명에 따라 복원한 뒤 새 결과 파일로 재측정
node tests/benchmarks/jsonl-parsing-branches.cjs --output tests/results/benchmarks/jsonl-parsing-rerun.json
# 소량·이미지의 짧은 확인
node tests/benchmarks/jsonl-parsing-branches.cjs --cases small,image --pairs 1 --output tests/results/benchmarks/jsonl-parsing-smoke.json
npm run check
```

재측정하려면 기록한 commit에서 두 worktree를 같은 경로에 다시 만들고 각각 `before.ts`·`after.ts`를 `src/summary/jsonl.ts`에 복원한다. 당시 컴파일 결과도 cache의 `before.reader.cjs`·`after.reader.cjs`에 보관했으므로 각 worktree의 `dist/src/summary/jsonl.js`에 복원하면 기존 setup의 소스·모듈 hash 검사를 유지할 수 있다. 입력 사본과 setup이 없는 환경에서는 `--prepare` 전에 두 브랜치 worktree·빌드·고정 입력을 새로 준비해야 한다. 소스와 컴파일 결과의 SHA-256은 새 원시 결과에서 확인할 수 있다. 저장소의 `tests/fixtures/jsonl-byte-reader.ts`는 적용 전 reader에 설명 주석만 붙인 차등 테스트용 사본이다.
