# 다수의 작은 JSONL을 모두 읽을 때의 I/O 최적화

조사 기준: 2026-11-06, Asia/Seoul. **같은 대상 파일과 같은 원본 바이트를 모두 읽고, 같은 JSON 파싱·집계를 수행하는 조건**의 조사다. 증분 읽기, offset 재개, 변경 파일만 읽기, 파싱 결과 재사용은 최적화 후보에서 제외한다. 이번에는 자료 조사와 코드 대조만 수행했고 구현·성능 측정은 하지 않았다.

## 현재 구현에서 출발할 지점

- [scanner.ts](../../src/summary/scanner/index.ts)는 디렉터리를 `opendir({bufferSize:32})`로 열거하고, 파일별 `lstat`를 직렬로 기다린다. 파싱도 `await parseSource(file)`로 파일 하나씩 진행한다.
- [jsonl.ts](../../src/summary/jsonl/index.ts)는 `open('r')` → 최대 64 KiB씩 `FileHandle.read()` → 파싱 → close 순서다. 읽기 buffer 크기는 `min(64 KiB, 파일 크기)`이며, 한 파일 안에서 재사용한다.
- 따라서 **64 KiB 이하 일반 파일은 보통 본문 read 한 번으로 끝난다.** 짧은 read가 반환되면 추가 호출은 필요하다. 작은 파일 때문에 느린 상황을 64→256 KiB 버퍼 변경만으로 해결하기는 어렵다.
- 읽기 전후 path의 metadata를 확인해 교체·잘림을 검증한다. 이 검사는 단순한 중복 호출로 보고 삭제할 수 없다.
- 통계는 이미 [별도 Worker](../../src/summary/client/worker.ts)에서 실행된다. Worker를 새로 둔다는 사실만으로 I/O가 빨라지는 구조는 아니다.

작은 파일을 직렬로 읽으면 파일마다 경로·metadata 조회, open/read/close, 비동기 작업 전달·완료 처리의 고정 비용이 반복된다. 많은 바이트를 한 파일에서 읽는 문제와 구분해야 한다. 아래에서 공개 문서의 사실과 이 코드에 대한 적용 가설을 구분한다.

## 1. 파일 간 선행 읽기: 다음 파일의 I/O와 현재 파일의 파싱을 겹친다

공식 근거: [Node fs threadpool usage](https://nodejs.org/docs/latest-v22.x/api/fs.html#threadpool-usage), [libuv thread pool](https://docs.libuv.org/en/v1.x/threadpool.html).

Node의 비동기 파일 API는 libuv thread pool을 사용한다. libuv는 pool이 event loop 사이에 공유되며 기본 크기가 4라고 설명한다. 이는 파일 I/O를 여러 개 진행할 수 있는 실행 수단이며, 특정 동시성의 성능을 보장하는 자료는 아니다.

**적용 가설:** 현재의 `A 읽기 대기 → A 파싱 → B 읽기 대기 → B 파싱`에서 B·C의 원본 읽기를 먼저 요청하고 A를 파싱한다. 입력 파일 수와 읽는 byte·파싱량은 유지하면서 대기 시간을 겹친다. 시작 비교값으로 동시 읽기 1·2·4·8을 사용할 수 있으며 최적값은 미측정이다.

작은 파일은 파일 전체 raw Buffer를, 큰 파일은 제한된 수의 청크를 선행 읽는 방식이 가능하다. 준비 큐와 진행 중 읽기를 합친 byte 예산·handle 수를 함께 제한하고, 파싱·정규화·DB 반영은 현재 순서를 유지한다. JSONL 경계와 source별 parser도 유지해야 한다.

현재 `parseSource()` 전체를 `Promise.all()`로 실행하는 것은 별도 문제다. 공용 staging·DB·세션 연결을 동시에 변경하게 되므로 **원본 바이트를 공급하는 단계의 병행**부터 검토하는 편이 작다. 또한 비동기 함수 호출만 미리 해 놓으면 충분하다고 단정할 수 없다. 다음 실제 read 요청을 파싱 전에 제출하거나, 전용 I/O event loop가 공급을 계속하도록 해야 동기 파싱 중에도 I/O가 진행된다.

이 방식은 open/close 호출 수나 JSON.parse CPU를 줄이지 않는다. SSD에서 대기를 겹칠 여지가 있지만 HDD에서는 여러 파일 접근이 seek를 늘릴 수도 있어 비교가 필요하다. 취소 후 pending read 종료·buffer 수명·읽기 전후 원본 검증도 보존해야 한다.

## 2. 디렉터리 열거와 파일 metadata를 함께 얻는다

공식 근거: [GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex), [FILE_ID_BOTH_DIR_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_both_dir_info), [FindFirstFileExW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-findfirstfileexw).

Windows는 디렉터리 handle에 `FileIdBothDirectoryInfo`를 요청할 수 있다. 반환 항목에는 파일명, 수정 시각, EOF/크기, 속성, 파일 ID와 다음 항목 위치가 들어 있다. `FindFirstFileExW`의 `FIND_FIRST_EX_LARGE_FETCH`도 큰 디렉터리 조회 buffer를 사용해 열거 성능을 높일 수 있는 옵션이다. 두 API는 별도 경로이므로 하나의 옵션으로 혼동하지 않는다.

**적용 가설:** 현재 `디렉터리에서 이름·종류 얻기 → 파일별 lstat`의 발견 단계를, 여러 항목의 metadata를 한 번의 열거 batch에서 받는 구조로 바꾼다. 모든 파일을 여전히 조사하면서 파일별 별도 metadata 요청을 줄이는 방향이다. 큰 native 변경 없이 할 수 있는 선행 후보는 현재 직렬 `lstat`의 제한된 병행이다.

Node 표준 `Dirent`가 제공하는 이름·종류만으로 size·mtime·identity를 모두 대체할 수는 없다. Windows의 풍부한 열거 결과를 사용하려면 native addon 또는 batch helper와 다른 OS용 fallback이 필요하다. 파일마다 별도 프로세스를 실행해 조회하면 새 고정 비용이 생기므로 한 helper가 여러 항목을 반환해야 한다.

열거 결과는 원자적 파일 snapshot이 아니다. 읽는 동안의 변경 검증은 남겨야 하고, 파일 ID와 Node `dev/ino`의 대응·symlink/reparse point·대용량 ID·시각 정밀도도 맞춰야 한다. [FileHandle.stat](https://nodejs.org/docs/latest-v22.x/api/fs.html#filehandlestatoptions)처럼 실제 열린 handle을 기준으로 검증하는 구조는 함께 검토할 수 있지만, path 교체 감지까지 자동으로 해결하는 것은 아니다.

## 3. 파일 API의 호출·비동기 전달·할당 비용을 낮춘다

공식 근거: [Node callback example](https://nodejs.org/docs/latest-v22.x/api/fs.html#callback-example), [readFile performance considerations](https://nodejs.org/docs/latest-v22.x/api/fs.html#performance-considerations).

Node 공식 문서는 최대 실행 성능·최소 할당이 필요할 때 callback API가 Promise API보다 적합하다고 설명한다. 또한 `readFile()`의 내부 chunk 처리 비용을 설명하고, 최대 속도가 필요하면 직접 `fs.read()`를 관리하는 방법을 제시한다.

**적용 가설:** 다수의 작은 파일에서 `fs/promises`·async generator·완료 처리의 고정 비용이 크면, 여러 파일을 처리하는 callback 기반 reader와 고정 크기 buffer pool을 비교한다. 외부 완료 Promise는 한 번만 두고 내부 open/read/close마다 Promise를 다시 만드는 구조를 줄이는 후보다. callback을 매 호출 `promisify`해서 같은 구조로 되돌리면 기대한 변경이 작다.

현재도 직접 read와 파일 내부 buffer 재사용을 하고 있으므로 `readFile()`로 바꾸면 빨라진다는 결론은 나오지 않는다. 파일 간 buffer 재사용은 추가 후보지만, 이는 주로 할당·GC 비용이며 디스크 접근 수 감소와 구분해야 한다. 파서가 buffer를 참조하는 동안 재사용하거나 선행 읽기로 덮어쓰면 안 된다.

이미 별도 Worker이므로 sync read와의 비교도 가능하지만 우선순위는 낮다. sync API는 그 Worker의 event loop를 막아 취소 메시지·다른 작업 전달과 I/O 겹치기를 어렵게 한다. 전체 API를 기계적으로 sync로 바꾸는 제안은 아니다.

## 4. 디렉터리 조회를 더 큰 batch로 처리한다

공식 근거: [Node opendir bufferSize](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisesopendirpath-options).

`bufferSize`는 디렉터리 항목을 내부에 보관하는 개수다. Node 문서는 더 큰 값이 성능과 메모리 사용을 함께 높인다고 설명한다.

**적용 가설:** 현재 32를 128·256 등과 비교한다. 이것은 작은 JSONL 각각의 본문 버퍼 크기를 바꾸는 것과 다르다. 한 디렉터리에 항목이 많으면 열거 batch의 고정 비용을 분담할 수 있다. 폴더마다 파일이 몇 개 안 되거나 파일별 metadata·파싱이 지배하면 이득은 작을 수 있다.

전체 경로 배열을 만들지 않는 현재 iterator 구조와 메모리 상한은 유지할 수 있다. 디렉터리 batch만 키워서는 파일별 lstat·open·read·close가 없어지지 않는다.

## 5. 입력 배치를 통제할 수 있으면 작은 파일을 큰 컨테이너에 묶는다

원 논문: Beaver 외, OSDI 2010, [Finding a Needle in Haystack: Facebook’s Photo Storage](https://www.usenix.org/events/osdi10/tech/full_papers/Beaver.pdf).

공식 실험: [SQLite — 35% Faster Than The Filesystem](https://www.sqlite.org/fasterthanfs.html).

Haystack은 여러 작은 객체를 큰 파일에 묶고 metadata를 줄이는 저장 구조다. SQLite의 작은 BLOB 비교도 개별 파일마다 반복되는 open/close 비용을 성능 차이의 원인으로 추정한다. 서로 다른 부하의 자료이며 논문의 배수나 문서 제목의 35%를 현재 제품의 예상 개선율로 사용할 수 없다.

**적용 가설:** 입력이 처음부터 segment/tar/컨테이너나 DB BLOB으로 주어지면, 모든 내용을 매번 읽고 파싱하더라도 수많은 경로 조회·open/close를 적은 수의 순차 읽기로 바꿀 수 있다. 파싱 결과 cache나 증분 수집을 전제로 하지 않는 저장 배치 최적화다.

**현재 제약:** Claude·Codex 원본의 생성·배치는 확장이 통제하지 않는다. 매 수집마다 원본을 전부 읽어 임시 tar를 만들고 다시 읽으면 원본 파일 접근에 쓰기·재독까지 더한다. 생성 측에서 묶어 주거나, 이미 만들어진 고정 snapshot을 반복 처리하는 조건에서 검토할 방법이다. 별도 컨테이너를 계속 동기화하는 설계는 이번 전수 읽기 최적화와 구분한다.

현재 외부 원본 파일 배치를 유지하고 매번 각각 새로 열어 읽는 조건에서는 대상 수에 비례하는 open/close 자체를 없앨 수 없다. 선행 읽기는 그 대기를 겹치고, native 열거는 발견 metadata 요청을 줄이며, 저장 배치 변경은 파일 접근 수 자체를 줄인다는 차이가 있다.

## 6. Windows 파일 필터와 시스템 캐시의 비용을 확인한다

공식 근거: [Defender Performance Analyzer](https://learn.microsoft.com/en-us/defender-endpoint/performance-analyzer-reference), [Dev Drive performance mode](https://learn.microsoft.com/en-us/defender-endpoint/microsoft-defender-endpoint-antivirus-performance-mode), [Windows file caching](https://learn.microsoft.com/en-us/windows/win32/fileio/file-caching), [WPA 그래프 목록](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/list-of-wpa-graphs).

Microsoft는 파일 열기에 따른 동기 보안 검사와 Dev Drive의 비동기 검사 모드를 구분하며, Performance Analyzer로 영향이 큰 경로·파일·프로세스를 찾는 방법을 제공한다. 현재 PC에서 검사가 병목인지는 조사하지 않았다. 먼저 해당 비용을 확인한 뒤 환경 후보로 판단할 항목이다. Dev Drive 사용은 저장 위치·보호 정책의 선택도 수반한다.

Windows는 기본적으로 파일 데이터를 시스템 캐시에 보관한다. 따라서 같은 파일들을 다시 전부 읽어도 warm cache에서는 물리 디스크보다 API·metadata·메모리 복사·파싱 비용이 드러날 수 있다. cold/warm 상태를 구분하고 WPA의 File I/O와 Disk Usage를 함께 본다. `fs.read` 시간만으로 SSD가 느리다고 결론 내리지 않는다.

## 작은 파일에 대한 효과를 과장하기 쉬운 후보

| 후보 | 이번 조건에서의 한계 |
| --- | --- |
| 64→256 KiB 본문 buffer | 64 KiB 이하 파일이 이미 한 번의 read로 끝나면 호출 수가 줄지 않음. 중간·큰 파일에는 별도 실험 가치가 있음 |
| `readFile()`로 전환 | 전체 파일을 읽는 편의 API이며 단일 OS read를 뜻하지 않음. 현재 직접 read 경로와 비교해야 함 |
| `readv()` | 한 파일 descriptor의 데이터를 여러 메모리 buffer로 받는 API. 서로 다른 파일 여러 개의 open/read를 하나로 합치지 않음 |
| 무제한 Promise.all | 대기 요청·handle·buffer만 늘고 디스크·pool·DB의 병목은 남을 수 있음 |
| handle을 계속 보관 | 한 번씩 순회하는 scan의 최초 open 비용을 없애지 못함. 재사용에는 handle 수 제한과 path 교체 검증도 필요 |
| `FILE_FLAG_SEQUENTIAL_SCAN` | 주로 파일 안의 순차 접근 hint. 작은 파일 사이의 경로·open 비용을 없애지 않음 |
| unbuffered/direct I/O | 시스템 캐시 이점을 포기하고 정렬 조건이 추가됨. 작은 파일·warm cache의 기본 후보로 삼을 근거가 부족함 |

추가 근거: [Node readv](https://nodejs.org/docs/latest-v22.x/api/fs.html#fsreadvfd-buffers-position-callback), [CreateFileW의 접근 hint](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew), [Windows file buffering](https://learn.microsoft.com/en-us/windows/win32/fileio/file-buffering). `FILE_FLAG_SEQUENTIAL_SCAN`의 세부 cache heuristic은 OS 버전별 구현 사항이므로 오래된 설명을 최신 Windows의 고정 규칙으로 사용하지 않는다.

## 이 저장소에서의 우선순위와 검증 기준

원본 파일 배치를 유지하는 첫 후보는 **제한된 파일 선행 읽기**, **디렉터리 buffer·metadata 조회 병행**, **callback 기반 reader의 고정 비용 비교**다. metadata가 큰 비중이면 Windows native batch 열거를 후속 후보로 둔다. native 도입과 원본 컨테이너화는 구현·배포 범위가 더 크다. 이 순서는 현재 직렬 코드와 변경 범위를 바탕으로 정한 검토 순서이며 개선율 순위가 아니다.

후속 비교에서는 4·16·64 KiB 파일 다수와 중간·큰 파일 혼합을 나누고 파일 수·총 byte를 고정한다. A/B 모두 동일 원본을 전부 읽고 같은 parser·집계 경로를 사용한다. 다음 항목으로 효과를 판단한다.

- 발견·metadata 시간, open/read/close 횟수와 대기, read에 반환된 byte, 순수 파싱 시간, TEMP·DB 반영 시간을 구분한다.
- cold/warm cache와 실제 장치·파일 시스템을 명시한다. warm 상태와 cold 상태를 섞어 속도 배수를 만들지 않는다.
- 동시성별 전체 시간·RSS·열린 handle 최대 수·취소 지연을 기록한다. 선행 읽기 큐의 총 byte도 확인한다.
- 집계뿐 아니라 raw hash·원본 byte offset·UTF-8 경계·미완성 마지막 줄·교체/잘림 오류·취소를 대조한다.

자료만으로 최적 동시성이나 효과를 확정할 수는 없다. 이번 조사에서는 실제 입력의 크기 분포·I/O 시간·병목을 새로 계측하지 않았다.
