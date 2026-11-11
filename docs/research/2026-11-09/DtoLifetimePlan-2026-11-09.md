# 읽은 파일의 DTO만 유지하는 스캔 알고리즘 제안

2026-11-09, Asia/Seoul. 사용자 요청에 따라 DTO 생성 위치·수명과 전체 파일 반복 탐색을 검토했다. 조사 담당자는 테스트·제품 코드를 변경하지 않았다. 통합 단계에서 메인 에이전트가 아래 두 작은 변경을 적용했다. **미귀속 파일 저장에 이번 읽기 조건 추가, finalFile의 명시적 필드 투영**이다. 나머지 구조는 설계안이다. 실행 범위는 [통합 계측 보고서](ScanStorageProfile-2026-11-09.md)를 따른다. 사용자는 `KPL`이 ‘DTO를 만든 후 그 상태를 저장하는 파일’을 뜻한다고 설명했다. 현 코드에는 별도 DTO snapshot/cache 파일을 쓰는 경로가 없으며 SQLite의 manifest와 최종 facts 저장을 구분해 검토한다.

## 1. 현재 상태: 스캔마다 남는 것과 새로 만드는 것

- [refreshSummary](../../../src/summary/scanner/index.ts)의 `files`, `affected`, `links`와 집계기는 함수 호출 안에서 생성된다. 이 파일들에서 사용량 DTO를 다음 스캔까지 전역 캐시하는 경로는 확인되지 않았다. 스캔 횟수만큼 영구 누적된다고 단정할 근거는 없다.
- [discoverSources](../../../src/summary/scanner/index.ts)는 `SELECT * FROM manifest ORDER BY id`의 전체 행을 읽는다. 읽지 않을 파일에도 `FileMetadata`와 `FileState`를 만들고 `previous`로 기존 manifest 행을 참조한다. 사용량 DTO는 아니지만 파일 수에 비례하는 객체·문자열·Map 항목을 매번 할당한다.
- 무거운 [SourceWinners](../../../src/summary/aggregation/sourceWinners.ts)는 `inspectSource()`가 실제 파일을 읽을 때 생성된다. 따라서 **본문을 읽지 않은 파일에 winner DTO를 만드는 문제는 이미 피하고 있다.** 변경하지 않은 파일이어도 변경 세션·부모·fork의 관련 원본이면 이번 스캔에서 실제로 읽기 때문에 DTO가 필요하다.
- 모든 관련 파일을 준비한 뒤 `collectWinners()`를 실행하므로 원본별 winner·근거가 준비 단계 전체에 걸쳐 살아 있다. 최종 [Winners](../../../src/summary/aggregation/winners.ts)는 이벤트를 복사하므로 원본별 winner와 최종 winner가 동시에 존재하는 구간도 있다.
- `SourceWinners.roots`는 usage 이벤트마다 항목을 추가하고, `metadata`는 turn/check/capability 이벤트를 모두 보유한다. 패자 토큰 벡터를 버려도 파일의 이벤트 수에 비례하는 작은 객체는 남는다. `events()`의 전개·정렬 배열도 일시적인 메모리를 추가한다.
- 수정 전 `finalFile()`의 `{ ...file }`은 TypeScript 반환 타입에 없는 `prepared`, `previous`도 실제 객체 속성에 복사했다. 이번에 필요한 metadata 열만 명시해서 만들도록 변경했다. 기존 SQL이 이 속성을 쓰지는 않았지만 영속화 입력이 무거운 스캔 상태를 참조하는 문제를 줄였다.

`heapUsed`가 다음 스캔 직전에 높아 보이는 것만으로 누수를 판단할 수는 없다. 비동기 작업·최종 결과·클로저의 도달 가능성과 GC 시점, 누적 생성 수와 현재 살아 있는 수를 구분해야 한다. 큰 전역 DTO 풀을 도입하면 오히려 살아 있는 객체 수가 늘 수 있으므로 권하지 않는다.

### 이번에 읽지 않은 파일의 상태 저장 생략

수정 전 `finishScan()`의 미귀속 원본 처리 조건은 `selected && !settled && !error && !removed && session === null`이었다. 이번에 실제 읽었다는 조건이 없어, 변경되지 않은 빈 파일처럼 session이 계속 null인 원본도 매 스캔 `finalFile -> replaceMemory -> saveFile`로 metadata DTO와 manifest UPSERT를 다시 만들었다. **이번 읽기를 시도했고 오류가 없는 미귀속 파일만 이 저장 경로에 넣도록 `attempted` 조건을 추가했다.** 오류·deferred·기존 세션 보존 경계는 유지한다.

이와 별개로 모든 이전 selected 원본의 `last_seen_scan_id`를 UPDATE하는 부분은 원본 존재의 관측 기록이다. 사용량 DTO snapshot 저장과 다르다. 장기적으로 관측 ID를 별도 compact set/페이지에 모으고 accepted metadata는 실제 읽은 파일만 갱신하도록 분리할 수 있다. 현재의 삭제 후보 조회·진단이 관측 ID에 의존하는 범위부터 확인해야 하며 기존 facts·manifest 행 자체를 삭제해서는 안 된다.

따라서 사용자 의도의 저장 규칙은 다음과 같이 명세한다. **이번에 본문을 읽지 않은 원본은 새 사용량 DTO·파싱 snapshot을 만들거나 다시 저장하지 않는다. 기존 정상 집계와 관측에 필요한 최소 식별자는 유지한다.** 사용량 DTO 캐시 측면에서는 이미 이 방향이며, 미귀속 원본의 불필요한 manifest 재저장도 이번 조건 변경으로 생략한다.

## 2. 권고 구조: 작은 목록 + 필요한 파일만 활성화

세 종류의 데이터를 분리한다.

| 데이터 | 보유 내용 | 생성 시점과 수명 |
| --- | --- | --- |
| 파일 목록 `catalog` | manifest ID, provider, path/root, 이전 session, 변경 판정에 필요한 크기·시각·identity/version/status | 관측·변경 판정·관련 파일 조회용. 전체 파일에 필요하지만 사용량·파서·winner를 포함하지 않는다. |
| 작업 집합 `workset` | 새 metadata, 이전 session, 실제 읽기 순번, 오류·삭제·deferred 상태, 필요할 때의 `PreparedSource` | 변경·삭제·관계 확장으로 처리가 필요한 파일에만 생성한다. 관측만 한 파일은 이 집합에 넣지 않는다. |
| 연결 성분의 집계 | 원본 근거, winner, root·모델·Skill 집계, 최종 SQL 입력 | 해당 연결 성분이 확정될 때만 만들고 저장·실패 처리 후 참조를 제거한다. |

전체 manifest를 `SELECT *`로 JS에 적재하는 대신 두 대안을 단계적으로 선택할 수 있다.

1. 우선 필요한 열만 조회하고 compact record와 ID 기반 색인을 만든다. 문자열·기존 행을 여러 객체에 spread해서 중복 보유하지 않는다. 현재의 경로 기반 비교를 유지하기 쉬우나 여전히 JS 메모리는 `O(N)`이다.
2. 파일 수가 더 커지면 기존 `(provider,path)` UNIQUE와 `(provider,session_id,id)` 인덱스로 manifest를 필요할 때 조회하고, 관측 ID는 페이지 단위로 DB에 반영한다. 삭제 후보는 선택 root의 전체 발견 성공 뒤에만 조회한다. JS 상주 목록을 줄이는 대신 파일마다 DB 호출이 늘 수 있으므로 compact 일괄 조회와 실제 소요 시간을 비교해야 한다.

두 대안 모두 원본의 존재를 확인하는 manifest·관측 ID는 유지해야 한다. **읽지 않은 파일의 사용량 DTO를 없앤다는 이유로 manifest나 기존 facts를 지우면 삭제 보존과 관련 파일 발견이 깨진다.**

## 3. 전체 재순회를 없애는 작업 큐

현재 `expandRelatedSources()`는 파일 하나를 읽을 때마다 전체 파일을 돌고 pending을 정렬한다. 최악에는 `R`개를 읽으며 `N`개 목록을 반복 조사한다. 관련 세션 큐와 중복 방문 집합으로 바꾼다.

- `bySession: sessionKey -> fileId[]`: 이전·현재 session 둘 다 색인한다. 세션 귀속이 바뀌면 이전 session을 제거하지 않고 영향 범위에 포함한다.
- `byThread: threadId -> fileId[]`: 새로 확인한 thread·parent·fork 관계를 찾는다. manifest에는 현재 parent/thread 열이 없으므로 기존 데이터만으로 완전한 색인을 만들 수 있다고 가정하지 않는다.
- `bySourceIdentity: (provider,sourceIdentity) -> fileId[]`: 이동 후보와 유일한 활성 원본 여부를 빠르게 찾는다. 같은 identity가 여러 파일에 있으면 임의로 하나를 고르지 않는다.
- `queued`, `attempted`: 같은 파일을 여러 세션·부모 경로에서 발견해도 한 번만 읽게 한다.
- `componentMembers`, `summariesBySession`: 연결 성분별 전체 files·summaries filter를 없앤다.

```text
discover selected roots
  compare observed metadata with compact manifest entry
  unchanged -> record presence only
  changed/new/deleted -> activate a small work item; enqueue affected sessions

while pending sessions or referenced parents exist:
  dequeue the next session/reference in deterministic order
  resolve related file IDs from catalog/DB indexes
  for each not-attempted file ID:
    activate the work item just before processing
    read one fixed source snapshot; collect identity, evidence, source winners
    index old/new sessions, thread references and source identity
    enqueue newly affected dependencies

freeze relation closure; resolve parent requests and move candidates
for each independent component in deterministic order:
  create an aggregation for this component
  feed source winners in the existing file/event order
  release each source winner after its events are consumed
  materialize this component only
  commit accepted facts and derived rollups in one transaction
  release prepared evidence, aggregate state and final SQL input
finish presence/name updates and diagnostics
```

`byThread`만으로 부모 파일을 못 찾는 신규·이동·오래된 파일은 현재의 경로 단서·원본 검사를 보수적인 fallback으로 남긴다. 이 경로를 반복 전체 검색으로 처리하지 않도록 missing-reference 큐와 조회 결과를 이번 스캔 안에서만 기억한다. 유효성 검증이 끝난 compact identity 관계를 manifest의 별도 metadata로 저장하는 방안은 후속 스키마 변경 후보이며 사용량 DTO의 영구 캐시와 구분한다.

## 4. 연결 성분별 해제의 효과와 한계

먼저 전역 관계 확장을 완료한 뒤 **성분마다 최종 집계·SQL 저장**하면 전체 최종 summaries를 한꺼번에 만들지 않아도 된다. 완료한 성분의 prepared winner·근거도 즉시 해제할 수 있다. 파일별 원본 winner를 최종 집계기에 전달한 직후 참조를 끊으면 원본/최종 winner가 중복되는 시간도 줄어든다. 최종 winner가 참조하는 `SourcePlan`·identity·진단 근거는 집계가 끝나기 전까지 필요하므로 무작정 `clear()`하면 안 된다.

다만 현재처럼 관계를 실제 본문을 읽은 후 알게 되는 구조에서는 관계 확장 완료 전까지 모든 읽은 파일의 winner가 남을 수 있다. 이 단계의 피크가 자동으로 ‘가장 큰 연결 성분 크기’로 내려간다고 주장해서는 안 된다. 처음부터 성분 하나씩 읽으려면 다음 중 하나가 추가로 필요하다.

- 변경·신규 파일까지 포함한 관계가 완전하고 유효함을 입증할 metadata 목록.
- identity/evidence를 먼저 수집하고 본문을 다시 읽는 두 단계 방식. I/O·파싱이 늘므로 스캔 속도 개선을 주장할 수 없다.
- 이번 스캔에 한정된 임시 backing store로 미확정 prepared 데이터를 내보내는 메모리 예산 방식. 종료 시 폐기·취소 정리가 필요하고 복잡도와 I/O가 증가한다.

따라서 **우선 compact 목록·큐·성분별 집계·조기 해제부터 적용**하고, 실제 피크가 관계 확장 단계에 집중될 때 다음 구조를 결정한다. 임의의 파일 수만큼 읽은 후 commit하는 방식은 아직 발견하지 못한 부모·이동·중복 그룹과 충돌할 수 있다.

## 5. 정확성을 유지해야 하는 조건

1. winner는 토큰 합이 큰 후보를 고르고 동점이면 기존 ordinal 순서의 뒤 후보를 고른다. 읽기 병렬화나 큐 전환 후 완료 순서를 ordinal로 사용하면 안 된다. 기존 파일 순번·파일 내부 index를 유지한다.
2. [SourceEvidence와 prepareSources](../../../src/summary/aggregation/sourceEvidence.ts)의 current 우선, legacy 복사 접두사, Claude request ID 보정, capability 중복 제외를 유지한다. 패자 root·최소 진단 위치가 사라지면 안 되므로 `roots`는 단순히 winner root만 남기도록 축소할 수 없다.
3. Codex parent·fork·다단계 subagent·충돌·순환의 관계 폐쇄가 끝나기 전에는 성분을 저장하지 않는다. 부모 생성 호출의 root 귀속도 확정해야 한다.
4. 같은 thread/identity의 여러 활성 파일은 그대로 다중 후보로 유지한다. source 이동은 기존 [includesSourceSnapshot](../../../src/summary/scanner/sourceFingerprint.ts)의 원본 snapshot 포함 검증을 통과한 경우에만 연결한다.
5. 실패·취소·부분 행으로 deferred된 성분은 기존 정상 facts를 보존한다. 성공한 다른 독립 성분의 commit은 현재와 같이 유지할 수 있다.
6. 삭제 원본의 사용량 보존 설정, 선택하지 않은 root의 원본, 빈 파일·미귀속 파일을 별도로 처리한다. 관측하지 못했다는 사실은 해당 root의 전체 발견 성공 뒤에만 삭제 판단에 쓴다.
7. 최종 facts·모델·Skill·비용·manifest·rollup 갱신은 기존 성분 트랜잭션 경계 안에서 함께 완료한다.
8. 이벤트 metadata 압축은 별도 작업으로 한다. turn의 최초 title·시작 최소값·종료 최댓값·최신 outcome, check의 최신 ordinal, capability의 복사/중복 제외, legacy root별 cutoff를 보존하는 reducer를 먼저 명세해야 한다.

## 6. 비용과 적용 순서

`N`=전체 manifest 파일 수, `R`=이번에 실제 읽는 파일 수, `E`=파일·세션 관계 수, `C`=영향 연결 성분 수, `T`=최종 요청 수로 둔다. `W`는 원본 winner·metadata·근거의 전체 크기이며 단순 winner 개수와 다르다.

| 부분 | 현재 구조의 비용·보유 | 제안 후 기대 경계 |
| --- | --- | --- |
| 발견 | 전체 manifest 행 + FileState, `O(N)` | compact 목록 `O(N)` 또는 DB 조회 기반 작은 페이지 + `O(R)` workset |
| 관련 파일 확장 | 읽을 때마다 전체 목록 재검색·정렬, 최악 `O(NR + NR log N)` 부근 | 완전한 관계 색인이 있는 경로는 파일·간선 한 번 방문. 초기 정렬을 포함해 `O(N + E + R log R)`. fallback 탐색 비용은 별도. |
| 성분별 멤버·요청 찾기 | `O(C(N+T))` 전체 filter | 색인 구축과 성분 방문에 `O(N+T+E)` 부근 |
| prepared 수명 | 읽은 전체 원본의 `W`와 최종 집계가 겹침 | 성분 완료·source 소비마다 해제. 관계 확정 전의 `O(W)` 피크는 남을 수 있음. |
| 최종 요청 materialize | 전체 `T`개 한꺼번에 보유 | 가장 큰 성분의 요청 수에 비례 |

우선순위는 다음과 같다.

1. 미귀속 파일의 최종 저장을 이번 실제 읽기 성공 원본으로 제한하기. 필요한 manifest 열만 읽기, 읽지 않을 파일의 work item 생성을 미루기, `finalFile`의 명시적 열 투영.
2. session/source identity/old-new membership 색인과 pending 큐로 반복 순회 제거. SQL 쿼리 수·관계 fallback 횟수도 함께 계측.
3. 관계 확정 뒤 성분별 집계와 즉시 참조 해제. source winner를 소비한 뒤 원본 보유분 해제.
4. `roots`·turn/check/capability metadata를 의미 보존 reducer로 축소. 사용량 winner 재사용은 이미 구현되어 있으므로 다시 객체 풀을 추가하지 않는다.
5. 계측으로 필요한 경우에만 검증 가능한 관계 metadata 또는 이번 스캔 한정 backing store를 설계한다.

이 문서의 시간·메모리 개선은 구조 분석에 따른 예상이며 수치로 검증하지 않았다. 검증은 현 코드·참조 검토에 한정했다.
