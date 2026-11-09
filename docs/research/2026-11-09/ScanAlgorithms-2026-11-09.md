# 파일 스캔 알고리즘 조사와 적용안

2026-11-09, Asia/Seoul. 사용자 요청에 따른 서브에이전트 조사다. 조사 담당자는 제품 코드를 변경하지 않았으며 자동 테스트·벤치마크·재현 스크립트를 작성하거나 실행하지 않았다. 아래 비용은 코드 구조에서 분석한 상한·목표이고, 실측 성능 개선율이 아니다. 사용자는 `KPL`을 DTO 생성 후 상태를 저장하는 파일로 설명했다. 별도 DTO 캐시 파일은 없으며, SQLite 상태 저장과 스캔 중 DTO 수명은 [DTO 설계](DtoLifetimePlan-2026-11-09.md)에서 구분한다. 통합 단계의 실제 계측·작은 변경은 [계측 보고서](ScanStorageProfile-2026-11-09.md)에 기록했다.

## 1. 현재 코드에서 확인한 비용

| 구간 | 현재 동작 | 개선할 지점 |
| --- | --- | --- |
| [탐색·관련 파일 확장](../../../src/summary/scanner/index.ts) | 매 스캔 전체 디렉터리를 순회하고 파일마다 `lstat`한다. 전체 manifest 행을 `ManifestRow[]`로 읽고 모든 관측 파일의 `FileState`를 만든다. | 본문을 안 읽는 파일도 메타데이터 객체와 검색 비용은 발생한다. |
| 같은 파일 | `fingerprint`가 같으면 본문을 재사용한다. 다만 `expandRelatedSources`가 영향받은 세션·부모 관계에 속한 원본을 다시 읽는다. | 재사용 가능 여부와 관련 원본 재집계를 구분해야 한다. 관련 파일을 무조건 생략하면 winner·부모 귀속이 달라질 수 있다. |
| 관련 원본 확장 | 반복마다 전체 `files` 순회, `resolveLineage`, 미준비 파일 정렬을 수행하고, 경우에 따라 파일 하나만 읽은 뒤 다시 반복한다. | 파일 수를 F, 실제 준비 파일 수를 K라 할 때 탐색·정렬 부분에 대략 `O(K·F log F)` 규모가 생길 수 있다. 계보 계산 자체와 본문 읽기 비용은 별도다. |
| [원본 읽기](../../../src/summary/scanner/sourceReader.ts) | 한 번의 `readJsonl`에서 파싱·원본별 winner 선택·SHA-256을 함께 처리한다. | 현재 일반 경로가 항상 본문을 두 번 읽는다는 설명은 맞지 않는다. |
| [이동 원본 확인](../../../src/summary/scanner/sourceFingerprint.ts) | 새 파일이 이전 snapshot을 포함하는지 추가로 읽으며 이전 길이의 prefix와 새 전체 해시를 검증한다. | 추가 본문 읽기는 이 조건부 경로에 존재한다. 같은 source identity 후보를 찾는 전체 배열 순회도 줄일 수 있다. |
| [JSONL 읽기](../../../src/summary/jsonl/index.ts) | 64 KiB 단위, 완성된 줄 처리, 이미지 본문 제거, 미완성 마지막 행 유예를 이미 구현한다. | 전체 `readFile`·모든 행 배열 적재로 교체할 이유가 없다. |
| [원본별 winner](../../../src/summary/aggregation/sourceWinners.ts) | 사용량은 그룹별 winner 하나를 보유하지만 root 근거·비사용량 metadata도 읽은 원본마다 보유한다. | 파일을 준비한 뒤 전역 집계가 끝날 때까지 살아 있는 원본별 자료의 수명이 피크 메모리에 영향을 준다. 다음 refresh까지 전역 DTO 캐시를 보유하는 구조는 아니다. |

F는 manifest 파일 수, K는 이번 집계에 필요한 파일 수, E는 부모·세션 연결 수, B는 실제 읽은 바이트 수로 정의한다.

## 2. 공식·1차 문헌 레퍼런스

### 변경 집합과 전체 재조정: Watchman, Node.js, Windows

Watchman은 디렉터리 트리의 인덱스를 유지하고 `since` cursor 이후 변경 파일만 반환한다. cursor가 다른 프로세스의 것이거나 새 cursor라면 fresh instance로 처리한다. 변경 집합의 연속성을 잃으면 전체 상태를 다시 맞춰야 한다는 설계 근거다. [Watchman 공식 파일 질의 문서 원본](https://github.com/meta/watchman/blob/main/website/docs/file-query.md), [Watchman query](https://facebook.github.io/watchman/docs/cmd/query).

Node.js는 `fs.watch`의 플랫폼 차이와 누락 가능한 filename을 명시하며, Windows에서 감시 디렉터리 자체가 이동·변경된 경우의 제약도 설명한다. Windows의 `ReadDirectoryChangesW`는 알림 버퍼가 넘치거나 모든 변경을 기록하지 못한 경우 디렉터리를 다시 열거하도록 안내한다. 따라서 watcher만으로 파일 삭제·불변 여부를 확정하지 않는다. [Node.js fs.watch caveats](https://nodejs.org/api/fs.html#caveats), [Microsoft ReadDirectoryChangesW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw).

### 원본 identity와 offset: Elastic Filebeat filestream

Filebeat는 원본 identity와 읽기 offset을 registry에서 관리한다. `filestream`은 registry에 전체 파일 상태를 반복 직렬화하는 비용을 줄이고, 최근 변경과 offset 갱신 중심으로 기록한다. `harvester_limit`으로 동시 열린 reader 수도 제한한다. 경로·inode·내용 fingerprint의 선택에는 이동·inode 재사용·파일 크기별 제약이 있다. [filestream 공식 문서](https://www.elastic.co/docs/reference/beats/filebeat/filebeat-input-filestream), [file identity 공식 문서](https://www.elastic.co/docs/reference/beats/filebeat/file-identity), [실제 prospector 구현](https://github.com/elastic/beats/blob/main/filebeat/input/filestream/prospector.go).

이 원리를 적용하더라도 Filebeat의 일부 바이트 fingerprint를 현재 전체 snapshot SHA-256 검증과 동등한 보장으로 설명하면 안 된다. fingerprint는 identity 후보 검색 수단이고, 변경되지 않은 prefix 전체의 증명과는 다르다.

### 제한된 파이프라인: Node.js backpressure

Node.js의 stream 지침은 producer가 consumer의 처리 속도를 넘을 때 backpressure를 적용하도록 설명한다. 메모리 소비와 GC 부담을 줄이기 위한 원리이며, `highWaterMark`와 `.write()` 반환값을 고려한다. [Node.js Backpressuring in Streams](https://nodejs.org/learn/modules/backpressuring-in-streams).

현재 [Zstd decoder](../../../src/summary/jsonl/zstd.ts)는 `pipeline`을 사용한다. 제안하는 파일 동시성 제한은 기존 스트림 backpressure를 유지하면서 파일 수·결과 수까지 상한을 확장하는 설계다.

### 압축 파일 checkpoint: Zstandard 형식

Zstd frame은 독립적으로 해제할 수 있지만 frame 내부 block은 앞선 block의 상태에 의존할 수 있다. 형식 자체가 임의 위치 random access를 제공하는 것은 아니다. [RFC 8878 §2–3.1](https://www.rfc-editor.org/rfc/rfc8878.html#section-3.1).

따라서 압축 파일의 임의 byte offset을 JSONL 시작점처럼 사용하지 않는다. frame 경계·사전·압축/비압축 위치의 별도 인덱스가 없다면 현재 전체 frame 스트리밍을 유지한다.

## 3. 권장 적용 순서

### 1순위: 역인덱스와 작업 큐로 전체 재검색 제거

이 단계는 파일 본문 읽기 규칙·저장 형태를 바꾸지 않는 후보다.

1. 탐색 단계에서 `session → file IDs`, `(provider, dev, inode) → manifest IDs`, `source identity → file IDs`를 만든다. 원본 정체성·세션이 바뀌면 old/new 양쪽 인덱스를 갱신한다.
2. 변경 파일·필요 부모 참조·영향받은 세션을 별도 큐로 관리한다. `queued`/`visited` ID 집합으로 같은 파일을 중복 준비하지 않는다.
3. 현재의 세션 연결과 계보가 새로 확정될 때만 관련 후보를 큐에 추가한다. 작업 큐가 비어 있고 더 이상 계보 변화가 없을 때 종료한다.
4. `commitComponents`도 모든 성분마다 전체 `files`를 필터링하지 않고 세션별 멤버 ID를 이용한다.

대상 검색의 목표는 `O(F + E + K)`다. 본문 파싱 `O(B)`, 계보 유효성 판정과 winner 병합의 실제 비용은 남는다. 기존 id 순서·sequence·동점 winner 선택 순서를 유지해야 한다. 부모 thread ID를 manifest에 저장하지 않은 상태에서는 경로에 ID가 포함되는지 확인하는 기존 fallback을 즉시 완전히 제거할 수 없다. identity를 확인한 뒤 thread 인덱스를 채우고, 알 수 없는 후보만 fallback으로 한정한다.

### 2순위: 메타데이터 조회에 작은 동시성 상한 적용

현 `walk → lstat → 다음 파일` 구조에서 `lstat` 대기가 지배적이면 최대 C개 작업만 진행하는 pool을 적용한다. C는 4–8 정도를 출발 후보로 삼을 수 있지만 최적값은 미측정이다. 무제한 `Promise.all`로 모든 파일·버퍼를 동시에 만들지 않는다.

중요한 제약은 I/O 완료 순서와 논리 순서를 분리하는 것이다. 탐색 결과·기존 id를 기준으로 순서를 부여하고, 완료 결과는 그 순서대로 영향 집합에 반영한다. 파일 본문 동시성은 metadata pool과 별도로 더 작게 유지한다. 단일 Worker의 동기 JSON 파싱은 같은 스레드에서 실행되므로 I/O Promise 수를 늘린다고 CPU 파싱이 병렬화되지는 않는다.

메모리는 `O(C·chunk + 진행 중 자료)`로 제한하되, C개 reader 결과를 모두 완료된 DTO 배열로 기다리게 두면 총 결과 크기만큼 다시 늘어난다. producer를 멈출 수 있는 byte/row budget과 완료된 성분 즉시 저장이 함께 필요하다. 현재 [sourceWinners.events()](../../../src/summary/aggregation/sourceWinners.ts)는 metadata와 winner를 합쳐 정렬하므로, reader 수 제한만으로 전체 보유 DTO 수가 상수가 되는 것은 아니다.

### 3순위: dirty 경로 집합과 주기적 전체 재조정

새 의존성을 필수로 도입하기보다 Watchman의 변경 집합 원리를 참고해 `dirtyPaths`와 `fullRescanRequired`를 관리한다. 정상 갱신에서는 dirty 후보를 stat하고 영향받은 성분만 확장한다. 새 프로세스·root 변경·watcher error·filename 누락·디렉터리 이동·연속성 의심 시 전체 탐색을 수행한다. Node.js watcher가 모든 OS의 overflow를 동일한 형태로 노출한다고 가정하지 않고, 주기적 전체 재조정도 유지한다.

관측되지 않은 파일과 삭제된 파일은 구분한다. 부분 탐색에서 보지 못한 manifest 행을 삭제/소실로 처리하지 않고, 성공적으로 전체 열거한 root에서만 소실 판정을 한다. 스캔 시작 시 dirty 집합을 교체하고 작업 도중 새 이벤트는 다음 집합에 보관해 유실을 막는다.

정상 경로의 metadata 비용은 변경 경로 수 D에 비례하는 것이 목표이며, 전체 재조정은 여전히 `O(F)`다. 영구 watcher·상태 cursor·재시작 처리의 구현 복잡성과 정확성 비용이 있으므로 1·2순위 이후에 선택한다.

### 4순위: append checkpoint와 DB에 보존한 원본별 상태

긴 로그에 소량 append만 되는 경우 가장 큰 장기 개선 후보지만, offset 하나만 저장해서는 현재 결과를 보존하지 못한다.

필요한 상태는 마지막으로 commit한 완성 줄 끝의 byte offset, parser 버전·원본 identity, parser의 root/turn/model/billing/legacy high-water 문맥, 생성 호출-자식 참조, 원본별 winner와 제외 근거다. [Codex parser](../../../src/summary/parsers/codex.ts)는 행 사이의 문맥을 보유하므로 파일 중간에서 빈 parser로 다시 시작할 수 없다. 전역 요약만으로 원본별 winner를 복원할 수도 없다. 이전 원본이 줄어들거나 삭제될 때 차감·대체할 근거가 필요하다.

제안은 checkpoint·원본별 기여분을 DB에 두고 이번에 읽은 원본의 필요한 상태만 로드하는 것이다. 읽지 않은 파일의 숫자 DTO는 만들지 않고, SQLite가 해당 원본의 기여분을 유지한다. suffix에서 winner가 바뀌면 `(new − old)` delta를 원자적으로 반영한다. checkpoint와 facts를 같은 transaction에서 commit하여 실패 후 중복 반영을 방지한다.

적용 조건과 fallback은 다음과 같다.

| 상황 | 정책 |
| --- | --- |
| 완성된 UTF-8 JSONL 줄 | newline 직후의 원본 byte offset만 commit한다. 문자 개수로 seek하지 않는다. |
| 미완성 마지막 줄 | 이전 완성 줄 경계부터 다시 읽는다. 원문 tail 전체를 장기 DTO 캐시에 보관할 필요가 없다. |
| truncate·파일 identity 교체·parser 버전 변경 | 원본별 이전 기여분을 transaction 안에서 대체하고 전체 재파싱한다. |
| rewrite 후 파일이 더 커진 경우 | `size >= oldSize`는 append 증명이 아니다. 정합성 정책에 따라 prefix 전체 재검증 또는 신뢰 가능한 append 계약이 필요하다. |
| SHA-256 | 이전 digest 문자열에 새 bytes를 이어 hash하면 전체 파일 SHA-256이 되지 않는다. 완성 digest와 내부 hash 상태는 다르다. 새 checksum 규칙·상태 보존·다시 읽기 중 하나를 명시적으로 선택해야 한다. |
| Zstd | 압축 byte offset과 비압축 JSONL offset을 혼용하지 않는다. 우선 전체 재파싱한다. frame checkpoint는 별도 형식·인덱스 설계가 필요하다. |

정확한 arbitrary rewrite 탐지를 보장하면서 이전 prefix를 전혀 읽지 않는 `O(ΔB)` 알고리즘으로 표현하지 않는다. 부분 fingerprint나 head/tail 표본으로는 읽지 않은 중간 구간의 rewrite를 놓칠 수 있다. append 보장 또는 저장 장치의 신뢰할 수 있는 변경 저널 등 추가 조건이 있어야 한다. 조건이 없으면 파싱 비용은 줄여도 prefix 검증 I/O는 `O(oldB)`로 남는다.

## 4. 먼저 수집할 구간 수치

아래는 계측 설계이며 이 문서에서는 실행하지 않았다.

| 수치 | 확인할 가설 |
| --- | --- |
| discovery elapsed, manifest rows, stat calls | 파일 본문보다 전체 열거·메타데이터가 느린가 |
| read/parse elapsed, source bytes, parsed/related source counts | append 한 파일 때문에 관련 세션 전체를 많이 다시 읽는가 |
| related expansion elapsed, queue attempts, files examined | 반복된 전체 검색·정렬이 주된 CPU 비용인가 |
| reconnect elapsed, verification bytes | 이동 검증에서 추가 읽기가 실제로 많이 발생하는가 |
| aggregation elapsed, prepared source count, winner count | 원본 준비 후 합산·정렬 또는 DTO 동시 보유가 큰가 |
| SQL transaction elapsed와 rollup/COMMIT 분리 | 마지막 저장 지연이 fact insert·집계 유지·디스크 commit 중 어느 쪽인가 |

읽기 대기·파싱·hash는 현재 한 루프 안에서 섞여 있으므로 외부 `readSource` 타이머만으로 각각의 순수 시간을 주장하지 않는다. row/chunk별 타이머를 추가하면 계측 오버헤드도 함께 보고한다. 소스 경로·대화 본문·토큰/credential을 계측 로그에 넣을 필요는 없다.

## 5. 결론과 검증 범위

권장 순서는 **구간 계측 → 역인덱스·작업 큐 → 제한된 metadata 동시성 → watcher와 전체 재조정 → 조건을 명시한 append checkpoint**다. 현재 단일 읽기와 JSONL/Zstd 메모리 상한은 유지한다. 읽지 않은 파일의 숫자 DTO를 만들지 않는 요구는 DB에 원본별 기여분을 남기는 방식과 함께 설계해야 하며, 삭제·winner 대체·부모 귀속 보정의 근거까지 제거하면 안 된다.

검증은 실제 코드·참조 경로 검토와 공식 문서 확인으로 제한했다. 처리 시간·메모리·개선율은 미측정이고, 제안의 기능 정합성 검증은 수행하지 않았다.
