# 구현 기록

2026-10-04 기준 구현 기록입니다. 설계 기준은 [AgentTracker.md](AgentTracker.md)이며, quota·summary 두 에이전트와 summary 산하 DB 에이전트로 분담했습니다. 서비스 사용량 제한으로 중단된 작업은 주 에이전트가 이어서 통합했습니다.

## 2026-10-05 사용량 카드 변경

하단 사용량 Webview 패널을 제거하고 상태표시줄 항목의 Markdown 툴팁으로 교체했습니다. `src/ui/quotaTooltip.ts`가 모든 quota 기간과 초기화 시간, 조회 상태를 표시하며 새로고침·상세/압축·확장 관리·사용량 통계 명령 링크를 제공합니다. `agentTracker.toggleQuotaTooltip` 클릭 명령을 로컬 VS Code 내부 `ToggleTooltipCommand` 객체에 연결해 클릭으로 열어 유지하고 재클릭으로 닫습니다. 위치·테마·크기는 VS Code가 결정합니다. API 조사와 적용 지점은 [StatusBarPopup.md](StatusBarPopup.md)를 참고하세요.

`scripts/vscode/statusbar-toggle.cjs`가 현재 설치의 내부 구현과 checksum을 확인하고 workbench에 연결 코드를 적용합니다. 원본 workbench와 product 파일, 변경 전후 hash를 보관하고 복원할 수 있습니다. 다른 확장·명령에는 적용하지 않습니다. 일반 빌드·확장 활성화에는 설치 파일 변경이 포함되지 않으며 업데이트 뒤 재적용이 필요합니다.

클릭 전용 패치(v2)는 자동 호버 등록 전에 사용량 항목의 `mouseover`·`focus` 이벤트를 걸러 자동 열기를 제거합니다. 클릭·pointerdown·키보드 토글과 닫기 처리는 유지하며, 다른 항목에는 적용하지 않습니다. 기존 v1 패치는 원본 백업을 보존하며 갱신하고 복원할 수 있습니다.

`npm run check`의 타입 검사·lint와 102개 테스트가 통과했습니다. `npm run test:toggle`로 실제 VS Code 1.140.0에서 hover 지연을 100ms로 설정하고 자동 호버 억제와 클릭을 검증했습니다. 마우스를 올려도 열리지 않고, 첫 클릭으로 상태표시줄 위 카드가 열려 마우스를 옮겨도 유지되며, 재클릭으로 닫힙니다. 닫은 뒤 마우스를 계속 올려 두거나 다시 올려도 닫힌 상태를 유지합니다. 바깥 클릭·Esc로 닫은 뒤에도 한 번 클릭으로 재열기에 성공했습니다. `test-results/statusbar-toggle.json`과 `statusbar-toggle.png`에 결과와 화면을 저장합니다.

아래의 Quota Webview 관련 검증 기록은 교체 전 구현에 대한 기록입니다. 현재 테스트는 Markdown 카드와 명령 링크, quota 동작의 통계 스캔 분리, Usage·Diagnostics Webview를 검증하도록 변경했습니다.

## 코드 구조

| 경로 | 역할 |
|---|---|
| `src/extension.ts` | 활성화, 두 상태 표시줄, 명령, 설정·focus 이벤트, 종료 |
| `src/quota/` | Claude OAuth, 짧은 Codex App Server 실행, provider별 refresh 정책 |
| `src/summary/client.ts`, `worker.ts` | worker 요청·응답, lazy refresh, 조회·취소 |
| `src/summary/scanner.ts`, `jsonl.ts`, `lock.ts` | bounded 순회·스트리밍·파일 잠금 |
| `src/summary/parsers/` | Claude·Codex current/legacy 정규화 |
| `src/summary/staging.ts` | 디스크 임시 테이블, 중복 제거·lineage·root 요청 합산 |
| `src/summary/db/` | 두 영속 테이블, transaction, 페이지·시간대 집계 |
| `src/ui/`, `media/` | Quota Markdown 툴팁, Usage·Diagnostics Webview |
| `scripts/vscode/statusbar-toggle.cjs` | 로컬 VS Code 내장 클릭 토글 연결, 백업·무결성 검사·복원 |
| `scripts/test-statusbar-toggle.cjs` | 격리된 실제 VS Code의 클릭·닫기·재열기 검증 |

## 구현 결정

- 별도 native npm binding 대신 worker 안에서 Node 내장 `node:sqlite`를 사용합니다. 동기 SQL은 Extension Host에서 실행하지 않습니다. 로컬 설치된 VS Code의 Electron Node 24.21.0에서 `DatabaseSync` 로딩을 확인했습니다. 최소 지원 런타임은 Node 22.15로 잡았습니다.
- SQLite WAL, 메인·임시 cache 각각 4 MiB, `temp_store=FILE`, `mmap_size=0`을 설정합니다. 전체 이벤트 수와 무관하게 JS에서는 metadata와 조회 page만 보유합니다.
- 새 CLI credential을 직접 발급하거나 인증 내용을 쓰지 않습니다. Codex는 account 조회만 수행하고 thread/turn이나 모델 호출을 만들지 않습니다.
- Webview 동적 문자열은 `textContent`로 렌더링하고 nonce CSP와 message allowlist를 사용합니다. 프로젝트·세션 filter나 기간 변경은 JSONL 재집계를 일으키지 않습니다.
- 사용자가 제외한 루트는 삭제 판정에서 제외합니다. 같은 논리 세션의 일부가 그 루트에 남아 있으면 재집계에 필요한 원본을 함께 읽으며, 읽을 수 없으면 세션의 이전 수치를 보존합니다.
- 이벤트 삽입은 JSONL 64 KiB chunk마다 동기 TEMP transaction으로 묶고 고정 SQL의 prepared statement를 재사용합니다. 파일 읽기는 transaction 밖에서 수행하며, TEMP 처리 중 다른 연결의 영속 DB 쓰기를 막지 않는지 검증했습니다. 세션 교체 시 삭제는 `(provider, session_id)` index를 사용합니다.
- 갱신 직렬화에는 `${dbPath}.refresh-lock.sqlite`의 `BEGIN EXCLUSIVE`를 사용합니다. 이 파일에는 테이블·데이터가 없고 실제 통계 DB의 쓰기 transaction과 분리됩니다. `busy_timeout=0`과 취소 가능한 비동기 대기를 사용하며 연결 종료·worker 종료·process 종료 시 해제됩니다. 기존 JSON owner 파일 방식의 빈 파일 잔류와 stale lock 삭제 경쟁을 없앴고, 이전 `.lock` 파일은 읽거나 삭제하지 않습니다. 새 잠금 파일은 재사용을 위해 남깁니다.

## 오류 처리 보완

- Claude HTTP 오류 응답 정리에 실패해도 401 credential 재확인과 429 Retry-After 분류를 유지합니다. Codex는 응답 뒤 process 정리 도중 발생한 취소·timeout도 실패로 반환합니다.
- 파싱에 실패한 파일에서 이미 확인한 session/parent identity는 임시 staging에 남겨 관련 세션 전체의 이전 통계를 보존합니다. 세션 귀속이 바뀌다 실패하면 이전·새 세션을 함께 보존합니다.
- 일부 세션 저장 후 취소하면 저장된 세션은 정상 상태로 두고, 아직 끝내지 못한 세션의 변경·재사용 원본에 중단 상태를 남깁니다.
- 일·월 조회의 날짜 필터가 시각 미상 그룹을 숨기지 않으며 결과 page 수에도 포함합니다. 잘못된 시간대는 시스템 시간대와 설정 오류 안내를 사용합니다.
- Quota 카운트다운은 숫자·문구만 갱신해 카드·버튼 focus를 보존합니다. Diagnostics에 재진입하면 첫 페이지와 버튼 상태를 함께 초기화하며 늦게 도착한 이전 조회는 폐기합니다.

## 검증 범위

자동 검증은 parser·SQLite·worker·대체 CLI process·VS Code API mock과 실제 Extension Development Host를 사용합니다. 실제 계정 token과 개인 대화 본문은 테스트 fixture에 사용하지 않습니다.

- quota focus/polling/backoff/강제 재실행/stale 유지, 응답 notification
- App Server handshake, API key·미로그인·RPC 오류·비정상 종료·잘못된 응답·timeout·취소 후 PID 종료
- SQLite 이름 테이블 정규화, 기존 DB 전환, rollback, session 이동, 미방문·제외된 루트와 삭제 처리
- Claude vector dedup과 tool result, Codex current/legacy·중첩 lineage·검증된 fork prefix
- append/truncate/delete와 full rebuild 결과 일치, 변화 없음 body read 0, 부분 줄, 오류 보존·재요청, 취소
- 일·월 집계 및 DST, 완료 요청 평균과 NULL 소요 시간 분모
- 확장 활성화 시 스캔 없음, 상태 표시줄 command와 선택 카드, provider별 refresh, 설정 클릭, Webview message 검증
- 실제 VS Code light/dark에서 stylesheet 로드, 선택 provider focus, Quota → Usage → Diagnostics, 요청·세션·날짜 filter, 빈 결과와 pagination 동작
- child 강제 종료·worker 강제 종료 뒤 여러 waiter의 단일 잠금 획득, 대기 중 취소, 통계 DB 쓰기와의 분리
- 실제 Webview에서 잘못된 시간대 안내와 복구, focus 상태에서 countdown 갱신·reset 이후 quota 보존, Diagnostics 페이지 재진입

Node 24.14.1과 최소 지원 Node 22.15.0에서 83개 테스트를 통과했습니다. 타입 검사와 lint도 통과했습니다. 실제 VS Code 1.101.0 / Electron Node 22.15.1 및 설치된 VS Code 1.140.0 / Electron Node 24.21.0에서 합성 로그의 150 token이 worker → Webview까지 전달되고 양쪽 테마의 DOM 상호작용이 통과했습니다. 스크린샷에 기반한 가독성 평가는 포함하지 않습니다.

로컬 Codex 실제 조회는 약 1.43초에 quota window 두 개를 읽고 process 종료까지 완료했습니다. token·계정 식별자·quota 수치는 출력하지 않았습니다. Claude 실제 조회는 인증 오류가 반환되어 CLI 재로그인 후 재검증이 필요합니다. 원격 환경과 실제 CLI peak RSS는 아직 검증하지 않았습니다. GitHub Actions workflow를 작성했지만 원격 CI 실행 결과는 로컬 테스트 결과와 구분합니다.

## 측정

`npm run benchmark`가 최초·변화 없음·append를 실행하고 정확한 합계와 변화 없는 경우 0 byte read를 검증합니다. 파일·요청 규모, 소요 시간, 실제 읽은 byte, host+worker process RSS는 `benchmark-results/summary.json`에 기록됩니다. 시간은 환경에 따라 달라지므로 고정 성능 배수나 worker 단독 메모리 절감을 주장하지 않습니다.

Windows / Node 24.14.1, 파일 2,001개(소규모 파일 2,000개와 20,000 요청의 큰 세션 1개), 본문 약 8.84 MB에서 확인한 결과입니다.

| 조건 | 처리 시간 | 본문 read | 파싱 파일 |
|---|---:|---:|---:|
| 최초 | 21.95초 | 8,835,340 bytes | 2,001 |
| 변화 없음 | 0.36초 | 0 bytes | 0 |
| 큰 세션에 요청 1개 append | 1.89초 | 8,027,073 bytes | 1 |

동일 실행의 host+worker peak RSS는 약 110.9 MiB(10ms 간격 표본)였습니다. 최적화 전 동일 입력의 최초·append는 각각 33.79초·15.60초였고, 최적화 후 두 실행의 append는 1.30초·1.89초였습니다. 다른 작업과 디스크 부하에 따라 측정값은 달라집니다. 추가된 한 줄만 읽는 방식이 아니므로 append도 큰 세션 전체를 다시 집계합니다. 최초 합계 7,700,000 token, append 후 7,700,350 token을 모두 확인했습니다.

`npm run benchmark:quota`는 별도로 합성 App Server의 성공·오류·timeout·취소를 측정합니다. handshake 단계별 시간과 child process RSS, 종료 확인을 기록하며 기본 실행에는 CLI 로그인이나 네트워크 조회가 필요하지 않습니다. 상세 조건은 [QuotaBenchmark.md](QuotaBenchmark.md)를 참고하세요.

## 확인한 공식 자료

- [Codex App Server](https://learn.chatgpt.com/docs/app-server): initialize/initialized, account/read, account/rateLimits/read. 설치 CLI의 generated TypeScript schema와 함께 확인했습니다.
- [Node SQLite](https://nodejs.org/api/sqlite.html): 내장 DatabaseSync와 동기 SQL API.
- [SQLite File Locking](https://www.sqlite.org/lockingv3.html): 별도 파일에서 동작하는 exclusive lock과 thread/process 간 직렬화.
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview): CSP, resource 제한, 메시지 통신.
