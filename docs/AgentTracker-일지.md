# Agent Tracker 설계 결정 일지

> 기준 문서: [Agent Tracker 설계 명세](./AgentTracker.md). 각 항목의 결과에 설계 명세 또는 실제 구현의 반영 범위를 기록한다.

## 현재 설계 결정 요약

- **작업 하네스와 기록**: 저장소 루트의 [AGENTS.md](../AGENTS.md)를 로컬 작업 지침으로 사용하고, 작업 완료 보고 전에 이 일지에 의사결정·근거·결과·검증을 기록한다. 근거: 세션이 바뀌어도 기존 선택과 변경 이유를 이어서 확인할 수 있어야 한다.
- **검증과 패키징**: 상세 테스트 항목은 [CI/CD 계획](./CI-CD.md)에서 관리하고 기능 구현과 함께 테스트 코드를 작성한다. PR·push에서는 자동 검증, 정기·수동 실행에서는 대용량 benchmark, 릴리스 tag에서는 검증된 VSIX 패키징을 수행하도록 계획한다. 근거: 설계 본문을 간결하게 유지하면서 반복 검증을 자동화한다. 실제 로그인·화면 확인은 수동으로 남기며 workflow는 구현 코드와 테스트 명령이 준비된 뒤 연결한다.
- **기능 범위**: 현재 구독 quota와 일·월·프로젝트·세션별 token 총량, 완료한 대화 turn별 평균 token·시간을 보여 준다. 근거: agent별·모델별 분석과 비용 계산은 사용하지 않으므로 이를 위한 영속 데이터는 관리하지 않는다.
- **사용량 도표**: 총 토큰은 `Input / Output / Cache Write / Cache Read`를 항목별 고정 테마 색상으로 쌓은 누적 막대로 표시하고 별도의 토큰 구성 지표는 두지 않는다. 도표는 표 페이지와 독립적으로 계산하며 일·월은 최대 30개 기간 구간, 프로젝트·세션은 선택 지표의 상위 10개, 사용자 요청은 최근 60개를 표시한다. 근거: 총량과 구성을 함께 읽고 큰 조회 범위에서도 화면·메모리 사용량을 제한한다.
- **실시간 경로와 누계 경로 분리**: 5시간·장기 quota는 실시간으로 갱신하지만 과거 JSONL 누계는 Usage 화면을 열거나 사용자가 새로 고칠 때만 갱신한다. 근거: quota는 즉시성이 필요하지만 과거 합계는 상시 watcher와 전체 인덱스를 메모리에 유지할 가치가 낮다.
- **현재 quota의 근거**: Claude는 기존 OAuth usage adapter, Codex는 App Server의 서버 조회 결과를 사용한다. 근거: JSONL의 quota는 마지막 관측값이고 로컬 token 합계에서 실제 구독 한도를 정확히 역산할 수 없다.
- **Codex process 수명**: 조회할 때 App Server를 실행하고 응답·오류·timeout·취소 뒤 종료한다. 근거: 기본 15분 주기에서 대기 메모리를 줄이는 대신 매번 시작·handshake하는 비용과 조회 사이 notification 미수신을 감수한다.
- **갱신 정책**: 활성 창에서 제공자별 기본 15분 조회, 복귀 시 5분 debounce, 실패한 제공자의 복귀 재시도는 30초부터 최대 15분 backoff, 수동 강제 조회와 single-flight 병합을 사용한다. 근거: 호출 예산과 비활성 자원을 아끼는 대신 polling 사이 최신성이 떨어지고 강제 조회의 재실패 가능성이 있다.
- **카드 갱신 시각**: `사용량` 제목과 `상태 표시줄` 선택 사이에 추적 중인 제공자들의 가장 최근 성공 갱신 시각을 한 번 표시한다. 성공 이력이 없으면 `—`로 표시한다. 근거: 공통 갱신 주기를 사용하는 카드에서 제공자별 시각의 반복을 줄인다.
- **사용량 화면과 설정**: Claude 왼쪽·Codex 오른쪽의 두 상태바 항목을 클릭해 공통 Quota 화면으로 이동하고 provider별 새로 고침·설정도 클릭으로 실행한다. 근거: 상세 통계와 조작을 명시적으로 제공하는 대신 상태바·Webview·설정 간 연결을 관리해야 한다.
- **인증 범위**: 자체 로그인·계정 추가·삭제·전환 UI 없이 기존 CLI 로그인과 data home을 재사용하며 제공자 VS Code 확장 설치는 필수가 아니다. 근거: 인증 관리 UI를 줄이는 대신 기존 credential 만료·실행 파일 탐색·환경 불일치 처리는 필요하다.
- **실패와 오래된 값**: 마지막 성공 값·시각과 갱신 실패 안내를 유지하고, 성공 이력이 없거나 유지 기한이 지나면 조회 불가를 표시한다. 근거: 일시 실패에도 정보를 보존하되 오래된 값을 현재 값으로 오인시키지 않는다.
- **영속 저장소와 이름**: 원본은 provider JSONL과 제목 metadata, SQLite 영속 table은 manifest·projects·sessions·turn_summary로 둔다. 이름은 프로젝트·세션당 한 번 저장하고 요청별 통계는 ID로 연결한다. 근거: 요청마다 이름을 반복 저장하는 양과 이름 변경 비용을 줄이는 대신 조회 시 metadata 연결과 기존 DB 전환을 관리한다.
- **갱신 단위**: manifest 발견·비교는 최대 n개씩, 재집계와 summary 교체는 영향 session 단위로 수행한다. 중복 제거·agent 연결은 임시 디스크 staging에서 처리한다. 근거: candidate를 영속화하지 않아 구조가 단순해지는 대신 append도 해당 session 원본 전체를 다시 읽어야 한다.
- **파일 조회·삭제·이동 판정**: 파일은 (provider, path)로 조회하고 source_root로 삭제 범위를 제한하며, 신뢰 가능한 dev/inode로 이동을 판단한다. 근거: 순회한 루트의 미방문 파일만 삭제하고 경로가 바뀐 파일의 동일성을 확인한다.
- **삭제 판정과 수동 재실행**: 전체 순회 성공 후 이번 실행에서만 미방문 파일을 삭제 대상으로 판단하고 summary 교체와 함께 삭제한다. 오류·중단 후 자동 재시도 없이 다음 화면 진입·수동 새로 고침에서 새로 조사한다. 근거: 삭제 상태나 재처리 대기열을 영속화하지 않아도 transaction으로 기존 통계와 metadata를 보존할 수 있다.
- **provider별 parser**: Claude와 Codex에 하나의 중복 제거 공식을 강제하지 않고, provider와 log version에 맞는 adapter에서 공통 turn schema로 변환한다. 근거: Claude의 response duplicate와 Codex의 response/cumulative snapshot은 발생 원인과 식별자가 다르다.
- **turn 식별과 평균의 분모**: Claude는 `promptId`, Codex는 `root_turn_id`를 우선하고 (provider, session_id, root_turn_id)당 summary 한 행을 둔다. 표시 순번은 turn_index로 분리한다. 근거: subagent·tool result를 독립 사용자 요청으로 세면 turn 평균이 잘못된다.
- **subagent 귀속**: 파싱 중 main과 subagent의 token을 사용자 요청에 합산하고 시간은 main/root 값 하나만 summary에 저장한다. 근거: token 합산에는 agent 구분이 필요하지만 agent별 영속 row와 자체 시간은 현재 조회에 필요하지 않다.
- **token 정규화**: parser 내부에서 cache·reasoning component를 정규화한 뒤 summary에는 input/output/total 합계만 저장한다. 근거: provider별 포함 관계로 인한 이중 집계를 방지하되 사용하지 않는 세부 component는 영속화하지 않는다.
- **평균과 디버깅**: 평균 token·시간은 완료 요청을 대상으로 하고 누락 duration은 분모에서 제외한다. manifest 진단은 상태·처리 위치·기록 시각·오류 네 column, summary는 문제 원본 정보로 제한한다. 근거: 사용자 issue 보고에 필요한 최근 상태만 기록하고 자동 복구용 cursor와 전체 처리 이력은 관리하지 않는다.
- **메모리 경계**: Extension Host에는 최신 quota snapshot, refresh 상태와 현재 Webview page·제한된 도표 결과만 유지하고 worker는 n개 파일 metadata와 byte 예산 내 parser/row buffer를 관리한다. 근거: 전체 경로·manifest·본문·집계 map의 적재를 피하되 한 줄 크기와 DB cache·임시 작업은 별도로 제한해야 한다.
- **개인정보 경계**: SQLite에는 식별자, 표시 이름, 숫자, 시각과 품질 정보를 보존하며 prompt·response·tool 본문은 저장하지 않는다. 세션 제목은 원본 metadata에서만 가져온다. 근거: 읽을 수 있는 이름을 제공하면서 분석에 불필요한 대화 본문과 credential을 장기 저장하지 않는다.

---

## 2026-10-06 — 사용자

### 카드 갱신 시각·사용량 도표·설치 기록의 목적별 커밋

- **의사결정**: 사용자의 요청에 따라 Codex 전역 `commit` 스킬로 커밋한다. 세부 선택으로 카드 공통 갱신 시각과 사용량 도표를 각각 구현·테스트·명세·일지와 함께 별도 기능 커밋으로 나누고, 두 로컬 설치 기록과 이번 커밋 기록은 문서 커밋으로 분리한다.
- **근거**: 두 기능은 서로 독립적으로 검토하고 되돌릴 수 있다. 설치 기록은 소스 변경이 아니라 로컬 설치 작업의 결과이므로 기능 커밋에 섞지 않는다. 명세와 일지는 한 파일에 두 기능의 변경이 섞여 있어 중간 버전을 만들어 hunk별로 stage했다.
- **결과**: `dev` 브랜치에 카드 갱신 시각, 사용량 도표, 로컬 설치 기록과 이번 커밋 기록을 순서대로 커밋하고 작성자명 `lsc892`와 AI 협업 표기 제외 규칙을 적용한다. push와 PR 생성은 수행하지 않았다.
- **검증**: 두 기능 커밋의 staged 내용을 각각 별도 임시 디렉터리에 펼쳐 `npm run check`를 수행해 타입 검사·린트와 150개·159개 테스트를 통과했다. 각 커밋의 `git diff --cached --check`와 일지의 상대 링크를 확인했다. 실제 VS Code 화면 검증은 앞선 구현 작업의 결과를 따르며 이번 커밋 작업에서는 반복하지 않았다.

### 사용량 도표를 포함한 최신 소스의 로컬 VS Code 설치

- **의사결정**: 사용자가 호출한 [agent-tracker-install 스킬](../.agents/skills/agent-tracker-install/SKILL.md)에 따라 사용량 도표 구현을 포함한 현재 소스를 잠금 의존성으로 빌드·패키징하고 VS Code 기본 프로필에 강제 설치한다. 기존 설치 방식을 유지하고 현재 확장 버전 `0.1.0`을 사용한다.
- **근거**: 앞선 구현·테스트가 완료된 도표를 실제 설치본에도 반영한다. 같은 버전의 기존 설치가 있으므로 설치 목록뿐 아니라 도표 화면 자산·집계 실행 파일의 내용도 비교한다.
- **결과**: 저장소 루트의 `agent-tracker-0.1.0.vsix`를 생성하고 `agent-tracker.agent-tracker@0.1.0`의 설치를 확인했다. 설치된 도표 화면·집계 파일은 현재 소스의 자산·빌드와 일치한다. 열려 있는 사용자 VS Code 창의 새로 고침과 설치 후 대시보드 실행 확인은 사용자 단계로 남긴다.
- **검증**: 설치 스크립트의 Node.js·VS Code 요구 버전, VSIX 식별자·버전·실행 파일·화면 자산 검사와 설치 목록 확인을 통과했다. 설치된 `dashboard.js`·`dashboard.css`·DB 집계·worker·HTML 실행 파일의 SHA-256을 현재 자산·빌드와 비교해 모두 일치를 확인했다. 앞선 구현은 타입 검사·린트·159개 테스트와 격리된 실제 VS Code 밝은·어두운 테마 검증을 통과했으며, 이번 설치에서는 해당 검사를 반복하지 않았다. 일지의 상대 링크와 `git diff --check`를 확인했다.

### 표 페이지와 독립된 사용량 누적 막대 도표 구현

- **의사결정**: 사용자가 확정한 도표 설계를 일지에 남기고 구현하라는 지시에 따라, 필터 아래·표 위에 `Input / Output / Cache Write / Cache Read` 누적 막대와 지표 선택을 추가한다. 세부 선택으로 일·월은 최대 30개 기간 구간의 제공자별 세로 막대, 프로젝트·세션은 선택 지표의 상위 10개 가로 막대, 전체는 제공자별 가로 막대, 사용자 요청은 최근 60개를 시작 시각순으로 표시한다. 외부 라이브러리 없이 SVG와 VS Code 테마 색상을 사용한다.
- **근거**: 총량·구성을 함께 표시하면서 전체 조회 범위와 표 페이지를 분리하고, 큰 범위도 worker의 SQLite 집계와 제한된 화면 결과로 처리한다. 여러 기간을 묶을 때도 원래 완료 요청의 token·시간에서 평균을 계산해 표본 수가 다른 기간의 평균을 동일 비중으로 섞지 않는다. 미확인 구성은 중립색 총량으로 보존하고 미확인 시간은 막대로 0을 표시하지 않는다.
- **결과**: Webview 지표·누적 막대·범례·조회 범위·마우스 및 키보드 상세 정보를 구현하고 worker 조회 결과에 도표 데이터를 연결했다. 총 토큰·요청 수·평균 토큰·평균 시간을 선택하며 사용자 요청별은 총 토큰·개별 소요 시간만 표시한다. 현재 설계 요약·명세·README를 실제 동작에 맞췄다. 구현과 격리된 실제 VS Code 실행 확인을 완료했으며 VSIX 패키징·사용자 프로필 설치는 수행하지 않았다.
- **검증**: `npm run check`의 타입 검사·린트·159개 테스트를 통과했다. 새 9개 테스트로 전체 범위 순위·페이지 독립·긴 기간 합산·제공자별 구간 정렬·평균 분모·최근 요청 순서·누적 구성·미확인 값·지표 경계를 확인했다. `npm run test:vscode`는 VS Code 1.140.0의 밝은·어두운 테마에서 여섯 조회 단위, 네 색상, 지표 전환, 키보드 상세 정보와 필터·진단 화면 연결을 통과했으며 도표 조작이 원본 재스캔을 시작하지 않음을 확인했다. 문서 링크와 `git diff --check`도 확인했다.

### 총 토큰 도표에 네 가지 토큰 구성을 함께 표시

- **의사결정**: 사용자의 지시에 따라 총 토큰 표시 자체를 `Input / Output / Cache Write / Cache Read` 네 항목을 색상으로 구분해 합친 누적 막대로 정한다. 앞선 제안의 별도 ‘토큰 구성’ 선택 항목은 제외한다. 세부 선택으로 항목별 색상은 조회 단위·제공자에 관계없이 동일하게 유지하고, 제공자는 막대의 위치와 이름으로 구분한다.
- **근거**: 같은 막대에서 총량과 구성 비중을 동시에 읽을 수 있으며 별도 지표 전환 없이 캐시 사용량도 확인할 수 있다. 화면의 Input은 cache를 제외한 값이므로 네 항목을 합쳐도 중복 집계하지 않는다.
- **결과**: 현재 설계 결정 요약과 명세의 도표 계획에 선택을 반영했다. 구성이 미확인인 경우는 총량을 중립색 막대로 표시하고 ‘구성 미확인’으로 구분하며 미확인 값을 0으로 채우지 않는 기존 규칙을 유지한다. 이번 작업은 설계 확정과 문서 반영이며 화면 구현·패키징·설치는 수행하지 않았다.
- **검증**: 명세의 token 정규화·미확인 값 처리 규칙과 제안의 일관성, 변경 문서의 상대 링크와 `git diff --check`를 확인했다. 문서만 변경해 코드 테스트와 실제 차트 화면 검증은 수행하지 않았다.

### 사용량 표의 조회 단위에 맞춘 도표 구성 제안

- **의사결정**: 사용자는 사용량 통계 표 위에 놓을 도표의 표현 방식을 문의했다. 이번 작업은 설계 제안으로 진행하며, 세부 제안으로 일·월별은 제공자별 세로 막대, 프로젝트·세션별은 사용량 순위 가로 막대, 사용자 요청별은 시간순 토큰·소요 시간 추이, 전체는 제공자별 토큰 구성 누적 막대를 사용한다. 기본 지표는 총 토큰으로 두고 요청 수·평균 토큰·평균 시간·토큰 구성은 필요에 따라 선택한다.
- **근거**: 현재 표의 토큰 구성·총량·완료/전체 요청·평균과 기존 조회 단위를 활용하면 시간 변화와 대상별 비교를 각각 읽기 쉬운 모양으로 표현할 수 있다. 단위가 다른 토큰과 시간을 한 축에 섞지 않고, 요청별 조회는 평균 대신 개별 값을 표시한다.
- **결과**: 필터 아래·표 위에 도표를 배치하고 표와 같은 조회 조건을 적용하는 안을 제안한다. 차트의 집계 범위는 현재 표 페이지가 아니라 선택한 전체 조회 범위로 두며 순위는 상위 항목이라는 범위를 명시한다. 미확인 cache·시간은 0으로 채우지 않고, 시각 미상은 시간축에서 별도로 다룬다. 이번 작업에서는 화면 구현·명세 변경·패키징·설치를 수행하지 않았다.
- **검증**: 현재 Webview 표 렌더링, 조회 결과 형식, SQLite의 그룹·평균 계산과 설계 명세를 대조했다. 일지 내용·문서 링크와 `git diff --check`를 확인했다. 실행 코드 변경이 없어 코드 테스트와 실제 차트 화면 검증은 수행하지 않았다.

### 공통 갱신 시각 표시를 포함한 최신 소스의 로컬 VS Code 재설치

- **의사결정**: 사용자가 호출한 `agent-tracker-install` 스킬에 따라 최신 소스를 잠금 의존성으로 빌드·패키징하고 기본 VS Code 프로필에 재설치한다. 확장 버전은 현재 `package.json`의 `0.1.0`을 사용한다.
- **근거**: 기존 설치에는 카드 상단의 공통 마지막 갱신 시각과 최신 parser version 9가 반영되지 않아 최신 소스에서 만든 VSIX로 업데이트한다.
- **결과**: `agent-tracker-0.1.0.vsix`를 생성하고 `agent-tracker.agent-tracker@0.1.0`을 강제 설치했다. 설치된 툴팁·scanner 빌드가 현재 소스의 빌드와 일치한다. 열려 있는 창의 새로 고침과 실제 카드 화면 확인은 사용자 실행 단계로 남긴다.
- **검증**: 설치 스크립트의 Node.js·VS Code 요구 버전, VSIX 식별자·버전·실행 파일·화면 자산 검사와 설치 목록 확인을 통과했다. 설치된 `quotaTooltip.js`·`scanner.js`의 SHA-256을 현재 빌드와 비교해 일치를 확인했다. 기존 변경은 앞선 타입 검사·린트·150개 테스트를 통과했고, 이번 설치 작업의 일지와 `git diff --check`를 확인했다.

### 마지막 갱신 시각을 카드 상단의 공통 한 줄로 이동

- **의사결정**: 사용자의 요청에 따라 제공자별 마지막 갱신 시각을 카드 상단 `사용량` 제목과 `상태 표시줄` 선택 사이의 한 줄로 모은다. 세부 선택으로 추적 중인 제공자들의 가장 최근 성공 시각을 사용하고, 성공 이력이 없으면 `—`로 표시한다.
- **근거**: Claude·Codex는 공통 갱신 간격을 사용하므로 카드에서 같은 정보의 반복을 줄일 수 있다. 실제 완료 시각은 조회 지연·실패·알림에 따라 다를 수 있어 성공 이력의 최신값을 표시 기준으로 정한다.
- **결과**: `createQuotaTooltip`의 공통 헤더에 시각을 추가하고 각 제공자 영역의 중복 시각을 제거했다. 현재 설계 요약·카드 명세·툴팁 구현 문서를 같은 배치에 맞췄다.
- **검증**: `npm run check`의 타입 검사·린트·150개 테스트를 통과했다. 합성 카드 렌더링에서 두 제공자·한 제공자·성공 이력 없음·유효하지 않은 시각·갱신 실패의 경우를 확인했고, 공통 시각이 제목과 상태 표시줄 선택 사이에 한 번 표시되며 실패 안내가 유지됨을 확인했다. 문서 링크와 `git diff --check`도 확인했다. VSIX 재설치와 실제 VS Code 화면 확인은 수행하지 않았다.

### 목적별 커밋과 파서 변경별 캐시 재계산

- **의사결정**: 사용자의 `$commit` 요청에 따라 이미지 파싱·중단 요청 집계·부모 메타데이터 수정을 각각 별도 커밋으로 나누고, 프로젝트 하네스와 전역 스킬 적용 기록도 목적별로 분리한다. 세부 선택으로 각 파서 수정의 version을 7·8·9로 순차 증가시킨다.
- **근거**: 관련 구현·테스트·명세·일지는 함께 검토하거나 되돌릴 수 있어야 한다. 파서 version을 각 수정에서 올려야 중간 커밋을 적용한 환경도 이전 결과를 그대로 사용하지 않고 원본을 재집계한다.
- **결과**: `dev` 브랜치에서 세 버그 수정과 두 문서 변경을 각각 커밋하고 작성자명 `lsc892`와 AI 협업 표기 제외 규칙을 적용한다. Codex 전역 스킬 파일은 저장소 밖에 유지하며 적용 결정만 이 일지에 기록한다. 앞서 설치한 VSIX는 parser version 7의 빌드이고, 이번 변경의 소스는 version 9다.
- **검증**: 세 코드 커밋의 staged 내용을 각각 별도 임시 디렉터리에 펼쳐 `npm run check`를 수행해 타입 검사·린트와 145개·148개·150개 테스트를 통과했다. 문서의 상대 링크와 `git diff --check`도 통과했다. 커밋 작업은 로컬 범위로 수행하며 완료 시 해시·작성자·메시지·남은 변경을 확인한다.

### Codex 전역 커밋 스킬과 기능·버그 수정 단위의 커밋 분리

- **의사결정**: 사용자의 요청에 따라 Claude 전역 `commit` 스킬을 Codex 전역 `C:\Users\safi2\.codex\skills\commit\SKILL.md`에 추가한다. 커밋 하나는 기능 추가 하나·버그 수정 하나·응집된 개선 하나로 구성하고, 해당 목적의 구현·테스트·문서·설정은 함께 포함하도록 명시한다. 세부 선택으로 제목을 제공했다는 이유만으로 무관한 변경을 합치는 원본의 예외를 제거하고, Unity `.meta` 규칙은 Unity 저장소에만 적용한다.
- **근거**: 목적별 커밋은 변경을 검토하거나 되돌릴 범위를 명확히 한다. 전역 스킬은 여러 저장소에서 사용하므로 특정 프로젝트가 Unity라는 가정을 유지할 수 없다.
- **결과**: Codex용 `$commit` 호출과 커밋 요청에 맞춰 지침을 옮겼다. 원본의 작성자명 `lsc892`, AI 협업 표기 제외, 저장소 메시지 관습과 별도 push·PR 요청 원칙을 유지했다. 같은 파일의 변경도 목적에 따라 hunk로 나누고 기존 staged 상태를 보존하도록 했다. Claude 원본은 변경하지 않았으며, 이번 요청은 스킬 추가이므로 저장소 커밋은 생성하지 않았다.
- **검증**: 임시 `uv` 실행 환경에 PyYAML을 제공해 `skill-creator`의 `quick_validate.py`를 통과했다. 설치된 Codex CLI 0.152.0의 App Server `skills/list`에서 해당 경로가 활성화된 `user` 스킬로 조회되고 오류가 없음을 확인했다. 문서 링크·내용과 `git diff --check`를 확인했으며, 실행 코드 변경이 없어 코드 테스트와 실제 커밋 생성은 수행하지 않았다.

### 프로젝트 하네스와 작업 완료 후 의사결정 기록

- **의사결정**: 사용자의 요청에 따라 로컬 프로젝트 작업 시작 시 읽는 하네스 문서로 루트 `AGENTS.md`를 추가하고, 작업 완료 보고 전에 이 일지에 의사결정을 기록하도록 한다. 파일명은 Codex가 프로젝트 지침을 읽는 기본 형식인 `AGENTS.md`로 정했다.
- **근거**: 채팅의 설명만으로는 다음 세션에서 기존 선택을 찾기 어렵다. 시작 지침과 결정 이력을 저장소에 함께 두면 작업 방식과 설계 변경의 이유를 이어서 확인할 수 있다.
- **결과**: 시작 시 일지 요약·최근 항목을 확인하고 관련 명세를 참고하도록 했다. 완료 후에는 날짜별 섹션에 의사결정·근거·결과·검증을 기록하며, 코드·문서·분석·설치 작업에도 적용한다. 이번 하네스 추가 결정도 같은 형식으로 기록했다.
- **검증**: 문서의 상대 링크와 `git diff --check`를 확인했다. 실행 코드 변경이 없어 코드 테스트는 수행하지 않았다.

### 복제된 부모 메타데이터와 파일 소유 thread 구분

- **의사결정**: 원본의 최초 `session_meta`가 파일 소유 thread를 정하고, 다른 thread의 복제된 부모 metadata는 소유 식별자·프로젝트·lineage를 바꾸지 않는다. 같은 thread의 반복 metadata는 누락된 정보를 유지하면서 제공된 제목 등을 갱신한다.
- **근거**: fork 로그의 복제된 부모 metadata로 자식 식별자와 lineage를 바꾸면 부모 파일이 존재해도 `missing-parent` 경고가 남는다.
- **결과**: 자식 thread의 부모·fork·프로젝트 정보를 유지하고, 상속된 사용량은 검증된 부모 prefix만 제외한다. 이 수정의 parser version을 9로 올려 기존 원본을 다음 통계 갱신에서 재계산한다.
- **검증**: 자식 식별자·부분 metadata 병합의 단위 테스트와 상속 사용량의 통합 테스트를 확인했다. 앞선 세 수정의 통합 검증에서는 타입 검사·린트·150개 테스트를 통과했고, 실제 원본 311개를 임시 DB에 재집계해 오류 0건과 기존 오류 파일 4개·`missing-parent` 경고의 해소를 확인했다. 이번 커밋의 staged 상태에서 타입 검사·린트·150개 테스트를 통과했다.

### 중단된 Codex 요청 제외와 이후 누적 token 보존

- **의사결정**: Codex main/root의 최신 결과가 `turn_aborted`이면 요청 summary와 token·turn·시간 집계에서 제외한다. 중단 이전 누적 token 카운터는 이후 요청의 delta 계산에 유지한다.
- **근거**: 중단된 대화는 완성된 turn으로 세지 않으며, 카운터까지 제거하면 이후 완료 요청에 중단 요청의 사용량이 다시 합산된다.
- **결과**: 나중에 같은 root를 다시 시작해 완료하면 최신 결과로 재집계한다. subagent만 중단된 경우 완료한 main/root의 사용량은 유지한다. UI와 명세의 안내도 맞추고 이 수정의 parser version을 8로 올린다.
- **검증**: main/root 중단과 후속 delta, 중단 후 같은 root의 완료 재시도, 중단된 subagent의 완료 main 귀속을 통합 테스트로 확인했다. 이번 커밋의 staged 상태에서 타입 검사·린트·148개 테스트를 통과했다.

### JSONL 이미지 본문 건너뛰기와 원본 byte offset 보존

- **의사결정**: JSONL의 `data:image/...;base64,` 문자열은 헤더와 JSON 경계만 유지하고 본문을 스트리밍 중 버린다.
- **근거**: 이미지 본문은 사용량 통계에 필요하지 않으며 정상 이미지 줄이 기존 4MiB 제한을 넘겨 전체 session 집계를 막았다.
- **결과**: 이미지 본문을 제외한 JSON만 줄 byte 예산에 포함하고 원래 byte offset과 JSON 문자열 검증·마지막 줄 보류를 유지한다. 이 수정의 parser version을 7로 올려 기존 오류 파일도 다음 통계 갱신에서 재계산한다.
- **검증**: 이미지 header와 body의 chunk 경계, 원본 offset, 마지막 줄 보류, 일반 본문 byte 제한과 잘못된 JSON 문자열을 네 회귀 테스트로 확인했다. 이번 커밋의 staged 상태에서 타입 검사·린트·145개 테스트를 통과했다.

## 2026-10-05 — 사용자

### 프로젝트·세션 이름을 ID로 연결하는 별도 테이블로 정규화

- **의사결정**: projects는 project_key당 프로젝트명 한 행, sessions는 (provider, session_id)당 세션명 한 행을 저장하고 turn_summary에는 식별자와 요청별 수치를 둔다. 같은 프로젝트 안에서 AI가 같은 세션명을 붙여도 이름으로 묶지 않는다.
- **근거**: 요청마다 프로젝트명과 세션명을 반복 저장하면 요청 수에 비례해 문자열 저장량이 늘고 제목 변경도 여러 행에 반영해야 한다. 이름을 한곳에서 관리하는 대신 조회 시 metadata 연결과 기존 SQLite schema 전환 비용을 감수한다.
- **결과**: 실제 저장 schema와 명세를 네 table로 변경하고 기존 DB의 요청 ID·통계·파일 참조를 보존하는 전환을 추가했다. 통계 화면은 원본 제목과 프로젝트명으로 표시·검색하고 특정 행 선택은 ID를 사용한다. Codex 제목 변경은 변경 없는 대화 로그를 다시 읽지 않고 반영한다.

## 2026-10-03 — 사용자

### 원안 비교표를 일지로 통합

- **의사결정**: 설계 명세의 「원안과 비교한 수정 사항」 15개 항목을 기존 결정 이력과 대조하고, 기록이 부족한 내용만 이 일지에 보완한 뒤 본문의 비교표를 제거한다.
- **근거**: quota와 token 구분, 클릭 Webview, provider별 중복 제거, 사용자 요청 grouping과 식별자·순번 분리, 요청별 summary, subagent 시간 미합산, cache 정규화, 모델·비용 분석 제외, lazy 누계, manifest 묶음·session 단위 반영, 두 영속 table은 이미 기존 결정 이력에 기록되어 있다. 본문과 일지에서 같은 변경 설명을 반복할 필요가 없다.
- **결과**: Claude 비공개 quota API의 제약, Codex 응답 필드·notification·인증 유형 처리, 초기 hover progress bar의 CSS 제약을 아래에 보완했다. 설계 명세에서는 비교표를 제거하고 후속 절 번호를 정리했다. 현재 기능과 데이터 처리 규칙은 각 설계 절에 유지한다.

---

### Claude 사용량 API 변경·실패 대응

- **의사결정**: Claude OAuth usage endpoint는 교체 가능한 `ClaudeQuotaProvider`로 감싸고, 안정성이 보장된 공개 API 계약으로 취급하지 않는다.
- **근거**: 동작 사례가 있어도 인증 위치·응답 형식·endpoint가 계속 유지된다는 보장은 없다. 조회 실패를 실제 사용량 0으로 표시하면 사용자가 quota 상태를 잘못 해석한다.
- **결과**: 현재 설계는 마지막 정상 snapshot과 시각, 오래된 값·조회 실패 안내를 유지한다. 성공 이력이 없거나 유지 기한이 지나면 `조회 불가`를 표시한다. 이 내용은 기존 로그인 재사용과 snapshot 유지 결정의 제약을 보완한다.

---

### Codex 사용량 응답 해석과 알림 처리

- **의사결정**: 짧은 App Server 조회에서 `rateLimitsByLimitId`를 우선하고, 없을 때만 호환용 `rateLimits`를 사용한다. `account/read`의 인증 유형을 확인하고 조회 중 도착하는 `account/rateLimits/updated`는 반영할 수 있게 한다.
- **근거**: 계정별 quota window와 인증 방식이 달라질 수 있으므로 5시간·7일 window나 API key 계정의 구독 quota를 고정 가정하지 않는다. 조회 사이에는 process가 없어 notification을 수신할 수 없다.
- **결과**: 기존 실행·handshake·조회·종료 결정에 응답 해석 기준을 명시했다. window label은 `windowDurationMins`로 만들고, `resetsAt`은 Unix timestamp 초 단위로 해석한다. API key rate limit과 ChatGPT 구독 quota를 구분한다.

---

### 초기 마우스 올림 안내의 진행 막대 표시 제한

- **의사결정**: 초기 `MarkdownString` hover progress bar 검토에서는 임의 CSS에 의존하지 않고 허용된 span color 범위로 표시하는 방향을 검토했다.
- **근거**: hover의 HTML sanitizer가 `font-size` 같은 style을 제거할 수 있어 원하는 progress bar 모양을 보장하기 어렵다.
- **결과**: 현재 설계는 기존 VS Code 표시 구조 결정에 따라 hover에는 짧은 안내만 표시하고 상세 quota와 조작은 클릭 Webview에서 제공한다. CSS 제한은 초기 hover 방식에 대한 검토 이력으로 보존하며 현재 Webview 전체의 CSS 제약으로 적용하지 않는다.

---

## 2026-10-02 — 사용자

### 상세 테스트 계획을 CI/CD 문서로 이동

- **의사결정**: 설계 명세의 독립 테스트 계획 절을 제거하고 상세 검증 목록과 실행 구분을 `docs/CI-CD.md`에서 관리한다.
- **근거**: 설계 본문은 기능·데이터 처리·완료 조건에 집중하고 반복 검증은 CI에서 실행한다. CI 실행을 위해서는 테스트 코드가 필요하므로 각 기능 구현과 함께 작성한다. 실제 인증·원격 quota와 화면 가독성은 별도 수동 확인이 필요하다.
- **결과**: 기존 테스트 항목을 새 CI/CD 문서에 보존하고 PR·push 검증, 정기·수동 benchmark, 릴리스 VSIX 패키징을 구분했다. 설계 명세의 후속 절 번호와 구현 순서를 수정했다. 현재는 문서 단계이므로 실제 workflow 구성과 외부 배포 연결은 구현 단계의 작업으로 남긴다.

---

### 요청 시 갱신의 오류·파일 변경 처리 단순화

- **의사결정**: 파일 삭제·통계 반영 실패·agent 실행 중 파일 변화는 별도의 방어 기능으로 확장하지 않고 기존 lazy 갱신의 기본 규칙으로 처리한다. 요청 시 읽은 해당 session 데이터를 보여 주고, 이후 변화나 실패한 반영은 다음 Usage 진입·수동 새로 고침에서 다시 조사한다.
- **근거**: 누계는 사용자 요청 때만 갱신하므로 요청 이후 변화를 계속 추적하거나 별도의 자동 복구를 둘 필요가 없다. 파일 부재가 확인되면 삭제로 처리하고 정상 반영에 성공했을 때만 manifest를 갱신하면 된다. 다음 요청 전까지 표시 값이 최신 원본과 다를 수 있다는 lazy 방식의 제약을 받아들인다.
- **결과**: 명세 4.4에서 통계·manifest 불일치, 삭제 오인, 읽기·파싱·DB 반영 실패, agent 실행 중 파일 변경의 네 독립 문제 설명을 제거했다. 메모리·DB 잠금, session 귀속 변경, 동시 갱신, 중단·부분 성공 항목만 남겼다. 전체 조사 후 삭제 판정, summary와 정상 manifest의 같은 transaction 반영, 기본 오류 기록, 미완성 JSONL 마지막 줄 보류 규칙은 유지한다.

---

### 파일 식별 설계를 변경 전 상태로 복원

- **의사결정**: source_root와 dev/inode에 대한 질문 직전의 manifest 설계로 복원한다. source_root, dev, inode와 루트·identity index를 유지하고 삭제 조회는 루트별 id keyset 방식으로 되돌린다.
- **근거**: 사용자가 지정한 복원 기준은 두 영속 table과 진단 네 항목으로 간소화한 뒤의 상태다. path만으로 삭제 범위를 구분하는 변경과 이후 identity 판정 확장은 되돌리되, 루트·파일 identity를 별도로 저장하는 기존 구조의 비용은 유지한다.
- **결과**: 4.3·4.4·8절, 관련 테스트 계획과 구현 순서를 변경 전 사본에 맞춰 복원했다. manifest와 turn_summary 두 table, 간소화한 진단 항목, n개 묶음 처리는 유지하며 최근 추가한 summary index의 한글 주석도 보존했다.

---

### 파일 교체 감지용 dev/inode 복원

- **의사결정**: manifest에 마지막 정상 반영한 dev와 inode를 복원하고 교체 판정에 사용한다. 유효한 identity의 이동 후보가 하나면 파일 id를 유지하며, identity가 누락·0·중복이면 이동 최적화 없이 session을 재집계한다.
- **근거**: path·size·mtime만 비교하면 동일 경로에 크기와 수정 시각을 보존한 다른 파일이 들어와도 unchanged로 오인할 수 있다. 이동 비용뿐 아니라 교체 감지가 필요하므로 두 column과 identity index를 관리하는 비용을 선택했다. 같은 파일 내부의 수정은 inode가 그대로일 수 있으므로 identity를 내용 검증 hash로 취급하지 않는다.
- **결과**: 명세의 manifest 목록과 SQL에 한글 주석을 포함한 dev/inode 및 이동 후보 조회 index를 다시 추가했다. reused 조건, 같은 path 교체, 이동 후보의 유일성, 읽기 중 교체 검증과 테스트 계획을 수정했다. 두 영속 table과 진단 네 항목, path 기반 삭제 범위는 유지했다.

---

### 파일 경로로 조회·삭제하고 이동 최적화 제외

- **의사결정**: source_root, dev, inode를 manifest에서 제거한다. 파일 조회와 삭제 범위는 정규화된 절대 path로 판단하고 이동·이름 변경은 removed + new로 처리한다.
- **근거**: source_root는 현재 조회 폴더와 path의 디렉터리 경계에서 판단할 수 있는 값이다. dev는 장치 번호이므로 단독으로 파일을 식별하지 못하며 inode와 함께 사용하는 목적은 이동 최적화였다. 현재는 영향 session을 다시 집계하므로 그 최적화를 위한 영속 필드와 신뢰성 분기를 관리하지 않는 편이 단순하다. 경로가 바뀌면 파일 id를 재사용하지 않고 session 원본을 재파싱하는 비용을 감수한다.
- **결과**: 명세의 manifest 목록·SQL column과 identity/루트 index를 제거했다. (provider, path) 유일 index로 경로 범위와 keyset pagination을 처리하고, 같은 접두어의 다른 폴더를 삭제 대상에 포함하지 않도록 폴더 경계 규칙과 검증 항목을 추가했다.

---

### 진단 항목을 4개로 줄이고 실패 후 수동 재실행

- **의사결정**: manifest 진단을 processing_status, processing_position, recorded_at, last_error 네 column으로 줄인다. 부재 flag·재처리 대기 상태·별도 처리 단계와 여러 offset/처리 시각 column을 제거하고 오류·중단 후 자동 재시도를 하지 않는다.
- **근거**: 사용자 로컬 SQLite에서 확인할 정보는 최근 상태, 어디까지 처리했는지, 기록 시각과 오류면 충분하다. 삭제 대상은 전체 순회 후 이번 실행에서 판단하고 summary 교체·manifest 삭제를 같은 transaction으로 처리할 수 있다. 자동 복구와 처리 이력 보존은 제공하지 않으며 다음 화면 진입·수동 새로 고침에서 다시 조사하는 비용을 선택한다.
- **결과**: 명세의 진단 네 column에 한글 주석을 붙이고 삭제·session 변경 목록을 임시 staging으로 옮겼다. mtime_ms는 파일 변경 비교용, recorded_at은 진단 기록 시각으로 구분했다. agent 실행 중에는 읽기로 정한 범위만 집계하며 불완전한 마지막 줄은 보류하고 이후 append는 다음 사용자 조회에 반영하도록 정리했다.

---

### 통계 범위를 줄이고 저장 테이블을 2개로 단순화

- **의사결정**: 과거 통계는 일·월·프로젝트·세션 token 총량과 대화 turn 평균 token·시간으로 한정한다. 영속 table은 manifest와 사용자 요청당 한 행인 turn_summary 두 개로 두며 project/session 정보를 summary에 직접 저장한다.
- **근거**: 사용하지 않는 agent별·모델별·비용 분석을 위해 정규화 table과 response candidate를 관리할 필요가 없다. 사용자 요청 최종 합계로 GROUP BY와 평균 조회가 가능하다. 대신 후보를 저장하지 않으므로 파일이 변경되거나 삭제되면 영향 session의 원본 전체를 다시 읽어 중복 제거·합산해야 한다.
- **결과**: 명세의 project/session/agent/turn/candidate/scan_runs table을 두 table schema로 대체했다. 변경 없는 session만 재사용하고 영향 session의 summary와 정상 처리 metadata를 함께 교체하도록 4.3·4.4를 수정했다. tail append 최적화와 비용 계산을 제외하고 성능 기준을 영향 session 본문 크기로 바꿨다.

---

### 사용자 요청별 집계와 오류 위치 기록

- **의사결정**: main/subagent 정보는 파싱 중에만 사용하고 token 합계와 main/root 시간 하나를 summary에 저장한다. manifest에는 정상 완료 offset과 최근 시도 단계·offset, summary에는 문제 파일·위치·원인을 기록한다. 평균은 완료 요청으로 계산하고 누락 시간은 제외한다.
- **근거**: agent별 row를 평균의 분모에 넣으면 사용자 대화 turn 평균이 왜곡된다. 두 table의 현재 상태만으로 어디서 중단됐는지 설명할 수 있으며 모든 처리 이력을 저장할 필요는 없다. 디버깅은 최근 상태로 제한되고 이전 정상값을 보존한 session은 별도로 표시해야 한다.
- **결과**: 사용자 요청 유일 key, 일·월 시작 시각 귀속, 총량·평균 query와 유효 시간 표본 수를 명세했다. manifest/summary에 한글 column 주석과 오류 위치를 추가하고 별도 diagnostics·scan 이력 저장을 제외했다.

---

### 파일 목록을 나눠 처리하고 통계·처리 위치 함께 저장

- **의사결정**: manifest는 SQLite에 유지하되 전체 적재와 refresh 전체 write transaction을 대신해 최대 n개씩 조회·처리·commit한다. 파일별 정상 통계와 cursor는 같은 transaction에 넣고 큰 파일의 정규화 결과는 디스크 staging을 사용한다.
- **근거**: manifest는 파일당 한 행이지만 세션·subagent 파일 증가로 전체 적재 메모리도 커진다. 묶음·byte 예산은 작업 메모리를 제한하며 staging은 파싱 실패 때 이전 정상값을 보존한다. 대신 staging disk I/O와 여러 commit 비용, refresh 중 부분 반영 상태를 감수한다. CSV 읽기 비용만으로 저장소를 선택하면 통계와 cursor를 함께 반영하는 계약을 별도로 구현해야 한다.
- **결과**: 명세 4.3·4.4를 iterator 순회·묶음 조회·디스크 staging·짧은 transaction으로 수정했다. 초기 n=256과 byte 예산, 묶음 간 backpressure를 명시하고 manifest 목록 및 SQL column마다 한글 주석을 붙였다. 성능·테스트 계획과 완료 조건도 이 경계에 맞췄다.

---

### 전체 파일 조사 후 삭제 판정과 중단 상태 관리

- **의사결정**: `source_root`와 `last_seen_scan_id`로 삭제 범위를 제한하고, 파싱 실패 파일도 방문을 기록한다. 대상 루트를 모두 순회한 scan에서만 미방문 파일을 묶음 삭제한다. 중단 후에는 새 scan ID로 재조사하고 진행 중 Usage는 기존 화면을 유지한다.
- **근거**: 묶음 처리 도중 아직 방문하지 않은 파일을 삭제하거나 파싱 실패를 부재로 해석하면 정상 통계를 잃는다. scan 상태와 refresh 직렬 실행은 이를 방지하지만 변경 없는 파일에도 방문 표시 쓰기가 필요하며 refresh 전체의 원자성은 제공하지 않는다.
- **결과**: `scan_runs`와 manifest의 방문 표시·소속 루트, 이동 조회 및 루트별 keyset 조회 index를 schema에 추가했다. 순회 실패 시 삭제 금지, 새 실패 파일 재처리, 삭제 중 종료 후 재스캔, 일부 commit 상태의 완료 표시 제한을 명세했다.

---

### 현재 구독 사용량은 서버에서 조회

- **의사결정**: 현재 quota는 서버가 보고한 사용률·window·reset을 사용하고, JSONL은 과거 token 통계의 근거로 사용한다. token 합계에서 역산한 값을 정상 quota로 채우지 않는다.
- **근거**: JSONL `rate_limits`는 관측 당시 서버 값을 읽는 경로이며 token 역산과 다르다. 모델·context·reasoning·tool use·caching·공유 사용·reset 경계가 달라지므로 고정 token 분모를 가정할 수 없다. 서버 조회의 네트워크·인증 비용을 감수하는 대신 조회 시점의 계정 quota를 얻는다.
- **결과**: 명세에는 현재 quota의 서버 조회와 과거 통계의 증분 처리 방식을 명시했다. 서버 조회·로그 관측·token 역산의 상세 비교는 이 일지의 근거로 보존했다. quota refresh가 통계 스캔을 호출하지 않는 경계를 유지하고 JSONL quota fallback 추가는 별도 결정으로 남겼다.

---

### Codex App Server를 조회할 때만 실행

- **의사결정**: Codex는 quota 조회마다 App Server를 실행하고 결과 저장 후 종료한다. 현재 초안의 한 번 실행·상주 재사용 방식을 대체한다.
- **근거**: 기본 조회 간격은 15분이고 필요한 결과는 작은 quota snapshot이므로 대기 중 process 메모리를 유지할 이점이 작다. 매번 process 시작·handshake·인증 확인 비용이 생기고 종료된 동안 notification은 받을 수 없다. 전체 비용이 훨씬 작다는 주장은 실측 전에는 확정하지 않는다.
- **결과**: 명세 3.2의 흐름을 실행·초기화·계정 확인·rateLimits 조회·snapshot 저장·종료로 바꿨다. 성공·오류·timeout·취소 모두 정리하며 중복 조회는 process 하나에 합친다. 조회 사이 상주 재시작 loop는 제거했다.

---

### App Server·JSONL의 처리 시간과 메모리 비교 기준

- **의사결정**: App Server와 JSONL의 비용은 기능·입력 크기·최초/증분 갱신을 맞춰 비교하고, theoretical complexity와 실제 지연·RSS를 구분한다.
- **근거**: App Server의 quota 응답 처리는 `O(W)`지만 초기화·네트워크 시간이 있으며, manifest는 본문 재읽기를 줄여도 파일 metadata 비교 `O(F)`가 남는다. 통계 인덱스의 load/save, 집계·중복 검증도 비용이어서 JSONL 전체 갱신을 무조건 `O(ΔB)`로 설명할 수 없다. worker 종료는 작업용 메모리를 회수하지만 peak 메모리가 자동으로 작아지는 것은 아니다.

상세 비교 근거:

서로 다른 세 경로를 구분한다. 5시간/7일은 예시이며 실제 window는 응답에 따라 결정한다.

| 방식 | 실제 얻는 값 | 정확도와 한계 |
|---|---|---|
| App Server `account/rateLimits/read` | 조회 시점에 서버가 보고한 계정 quota 사용률·window·reset | 현재 quota의 기준값. 네트워크·인증 실패가 가능하고 polling 사이에는 오래된 값이 됨 |
| JSONL의 `rate_limits` | 과거 서버 응답에서 기록된 사용률·window·reset | 해당 관측 시점의 근거. 새 기록이 없으면 다른 기기·클라우드 소비나 reset을 반영하지 못함 |
| JSONL token 합계로 quota 역산 | 로컬 기록과 가정한 환산식으로 만든 추정값 | 공개된 고정 token 분모·환산 규칙과 완전한 계정 기록이 없어 실제 quota와 일치 보장 불가 |

ClaudeCodeUsage의 Codex quota는 두 번째 경로다. `used_percent`를 읽는 것이므로 token 합계에서 현재 quota를 역산하는 것으로 설명하지 않는다. 100만 token 소비와 10% 관측으로 최대 1,000만 token을 계산해도 이는 해당 사용 패턴의 추정일 뿐 고정 구독 한도가 아니다. 모델·context·reasoning·tool use·caching·공유 사용·reset 경계를 고려해야 한다. 최근 5시간/7일 token 합계를 provider의 quota window와 무조건 동일시하지 않는다.

시간·메모리 비교에 사용하는 기호:

- `F`: 발견하는 JSONL 파일 수; `B`: 전체 본문 byte 수; `ΔB`: 추가분과 재처리 파일의 byte 수.
- `I`: 전체 통계 인덱스의 직렬화 크기; `W`: quota window 수; `L`: 읽기 buffer와 처리 중인 한 줄의 크기.
- 아래는 정적 코드·알고리즘 분석이다. 실제 실행 시간이나 RSS를 실측한 결과가 아니다.

| 비교 항목 | 짧게 실행하는 App Server | JSONL + manifest |
|---|---|---|
| 최초 취득 | process 시작·초기화·인증·네트워크 대기 + `O(W)` quota 처리 | 전체 발견·스캔 기준 `O(F + B)` |
| 이후 갱신 | 매번 시작·초기화·인증·네트워크 대기 + `O(W)` quota 처리 | 이상적인 metadata 비교·증분 본문 처리 `O(F + ΔB)` |
| 인덱스 부가 작업 | 통계 인덱스 불필요 | 전체 인덱스를 읽고 저장하면 `O(I)`가 추가되고 집계·중복 검증·정렬 비용도 별도 |
| quota 표시 | 저장된 작은 snapshot `O(W)` | 저장된 마지막 관측 snapshot `O(W)` |
| 작업 중 메모리 | child process + protocol buffer + snapshot | quota 전용이면 worker + `O(F + L + W)`; 전체 통계 인덱스를 올리면 인덱스 크기에 따른 메모리도 필요 |
| 작업 후 | child process 종료, snapshot·refresh 상태 유지 | worker 종료 후 snapshot·metadata를 유지하거나 디스크에서 재사용. 전체 통계 구현은 집계가 host에 남을 수 있음 |
| 네트워크 | 필요. 인증 갱신·재시도 가능 | 로그 읽기는 오프라인 가능. 최신 quota를 얻는 기능은 아님 |

App Server의 quota 응답 처리량은 로그 크기와 무관하지만 전체 process 초기화 비용까지 무조건 `O(1)`이라고 보장하지 않는다. JSONL의 `O(F + ΔB)`도 읽기 단계의 이상적인 기준이며 실제 전체 통계 refresh는 index load/save와 중복 제거 등을 포함한다. worker는 실행 위치와 수명을 제어하는 수단이지 peak 메모리를 자동으로 줄이는 수단은 아니다.

- **결과**: 최초 `O(F+B)`, 이상적인 증분 읽기 `O(F+ΔB)`, 전체 인덱스 처리 `O(I)`의 상세 비교를 이 일지에 보존했다. 명세 10.1에는 process 평균 메모리 계산과 실제 benchmark 항목을 두고 100 MiB·2초 사례를 가정값으로 표시했다.

---

### Orca에서 가져올 기능과 제외할 기능

- **의사결정**: Orca에서 Codex의 짧은 App Server 조회, quota와 과거 통계의 분리, append·중복 제거 원칙만 참고한다. backend HTTP fallback, Claude CLI fallback·statusline hook, 다중 계정 관리와 메모리 기반 전체 통계 cache는 초기 범위에 포함하지 않는다.
- **근거**: 필요한 부분만 채택하면 quota 조회와 JSONL 통계를 분리하면서도 인증 경로·hook·계정 전환·가격표 관리 책임을 늘리지 않을 수 있다. 대신 App Server나 Claude OAuth 조회가 실패했을 때의 추가 fallback, statusline을 통한 즉시 반영, 확장 내부 계정 전환 편의는 포기한다. 과거 통계는 Orca의 JSON cache 대신 transaction·삭제 복구·기간별 질의에 적합한 SQLite를 사용하며 native module 배포와 migration 비용을 감수한다.
- **결과**: 비교표는 설계 명세에서 제거하고 채택·제외 근거는 이 일지에 보존했다. 명세에는 선택된 App Server 조회, lazy manifest 갱신과 SQLite 저장 방식만 남겼다.

---

### 구독 사용량을 15분마다 갱신하고 비활성 창에서는 중지

- **의사결정**: 시작 시 최초 조회, 활성 창에서 기본 15분 polling, 비활성·최소화·숨김 중 정기 조회 생략, 복귀 시 마지막 정상 조회가 5분 이상 지났으면 재조회한다. 복귀 실패는 provider별 30초부터 최대 15분 backoff로 제한한다.
- **근거**: 초기 60초 공통 polling보다 endpoint 호출과 비활성 자원 소비를 줄일 수 있다. 대신 사용 중 quota 변화가 다음 정기·복귀·수동 조회 전까지 늦게 보일 수 있다. 실패 backoff는 복귀 이벤트의 허용 간격이며 비활성 중 별도 고빈도 재시도는 하지 않는다.
- **결과**: 명세 3.3에 Orca 정책을 반영하고 provider별 기본 900초·최소 30초 설정을 추가했다. 수동 조회는 해당 provider를 강제로 조회하고 실행 중 강제 요청은 한 번의 후속 실행으로 합친다.

---

### 조회 실패 시 마지막 성공값 유지와 수동 강제 갱신

- **의사결정**: 일반 실패 snapshot은 마지막 성공 이후 최대 30분, `429`는 최대 24시간 유지하고 오래된 값·마지막 성공 시각·실패 안내를 표시한다. 명시적 수동 강제 조회는 Orca처럼 debounce와 Retry-After 게이트를 우회할 수 있다.
- **근거**: 일시적 실패마다 숫자를 없애면 사용량 확인이 끊기지만, 이전 숫자만 보여 주면 최신값으로 오인할 수 있다. 안내와 유지 기한을 관리하는 복잡성을 감수한다. 수동 재시도는 복구 기회를 제공하는 대신 rate limit 중에는 다시 실패할 수 있으므로 연속 클릭을 병합한다.
- **결과**: 초기 실패 시 즉시 조회 불가 표시를 보완했다. 정상 핵심 quota 값은 유지하면서 갱신 근거를 함께 표시하고, 성공 이력이 없거나 유지 기한이 지나면 조회 불가로 전환한다. reset 시각만 보고 사용률을 0으로 만들지 않도록 명세했다.

---

### 클릭으로 상세 조회·새로 고침·설정 실행

- **의사결정**: 사용량 상세·provider별 새로 고침·오른쪽 끝 설정 버튼은 모두 클릭으로 동작한다. 사용률/남은 비율과 간략/상세는 공통 설정, 상태바 표시/숨김과 갱신 간격은 provider별 설정으로 둔다.
- **근거**: 두 provider를 나란히 비교하고 필요한 조작을 직접 선택할 수 있다. 공통 표시 기준은 읽는 방식을 통일하지만 각 provider의 표시와 조회 주기는 별도로 관리해야 한다. hover에서 상세 조작하는 편의보다 클릭 화면의 명시성을 선택했다.
- **결과**: 명세 3.4·3.5에 두 StatusBarItem과 공통 Quota 카드, 클릭 설정, 상세 Usage 이동을 기록했다. hover는 안내만 표시하며 상태바 숨김과 provider 비활성화를 구분했다.

---

### 터미널 CLI 사용자의 기존 로그인 재사용 조건

- **의사결정**: 기존 로그인 재사용 범위에 Claude/Codex 확장 없이 터미널 CLI만 사용하는 사용자도 포함한다. 자체 로그인 UI 제외와 credential 읽기·만료 처리는 별개로 취급한다.
- **근거**: ClaudeCodeUsage는 기존 Claude OAuth credential과 CLI 로그를 사용하고, Codex는 credential을 읽지 않고 로그의 마지막 quota를 표시한다. 우리 Codex는 기존 login cache를 사용하는 App Server 조회이므로 별도 CLI 실행 파일과 동일 환경이 필요하다. 제공자 확장 설치만으로 어떤 환경의 credential도 자동 공유된다고 가정하지 않는다.
- **결과**: 명세 3.6에는 선택된 Codex App Server 호출만 남기고, 터미널·API key·미로그인·별도 data home·ephemeral 인증의 제약과 credential 처리의 미검증 사항은 이 일지에 판단 근거로 보존했다.

---

### 구독 사용량 화면에 사용량·한도·초기화 시각 표시

- **의사결정**: Claude와 Codex의 각 quota window에서 핵심적으로 표시할 값은 현재 사용량, 최대 사용량, 초기화 시각으로 제한한다.
- **근거**: `ok`, `stale`, `rate_limited` 같은 내부 통신 상태는 사용자가 확인하려는 quota 자체가 아니다. 다만 조회 실패를 0%로 오인시키지 않기 위해 값을 만들지 않고 `조회 불가`로 표시하는 제약은 감수한다.
- **결과**: 정상 상태의 UI 계약은 세 값으로 단순화되었고, provider가 백분율만 반환하면 현재 사용량은 `usedPercent`, 최대 사용량은 `100%`로 해석하도록 명세했다.

---

### 별도 계정 관리 없이 CLI 로그인·실행 환경 재사용

- **의사결정**: 별도의 계정 관리 화면을 만들지 않고 같은 실행 환경에 있는 Claude/Codex CLI의 기존 로그인과 data home을 사용한다.
- **근거**: 인증을 다시 구현하거나 다른 VS Code 확장의 비공개 API에 의존하지 않을 수 있다. 대신 Windows, WSL, SSH, container처럼 credential과 log 경로가 분리된 환경은 자동으로 하나의 계정·이력으로 합칠 수 없으며 CLI 실행 파일 탐색과 만료 credential 처리가 필요하다.
- **결과**: Claude는 기존 OAuth credential과 `/usage` 경로를 adapter로 감싸고, Codex는 App Server의 `account/read`와 `account/rateLimits/read`를 사용한다. 세션을 저장하지 않은 실행과 다른 data home의 기록은 사후 통계에서 제외된다.

---

### 실시간 구독 사용량과 과거 통계의 갱신 경로 분리

- **의사결정**: quota는 provider별 polling·notification·수동 refresh로 갱신하고, 이 동작이 SQLite 누계 refresh를 호출하지 않게 한다.
- **근거**: quota의 작은 원격 snapshot과 과거 JSONL corpus는 갱신 빈도와 비용이 다르다. 두 경로를 결합하면 상태 표시줄을 최신으로 유지하려고 불필요한 disk scan까지 반복하게 된다.
- **결과**: quota에는 provider별 single-flight를 적용하고, 과거 사용량은 Webview 진입 또는 명시적 refresh가 있을 때만 manifest를 검사하는 구조가 되었다.

---

### 상태바에 Claude·Codex 요약, 클릭 화면에 상세 표시

- **의사결정**: Claude와 Codex를 상태 표시줄 오른쪽의 별도 항목으로 보여 주고, 클릭하면 공통 Webview의 해당 provider quota 카드로 이동한다.
- **근거**: 짧은 상태 표시줄에서는 두 provider를 즉시 비교할 수 있고, 상세 기간·프로젝트·turn 표는 제한된 `MarkdownString` hover보다 Webview가 적합하다. 항목과 Webview를 추가로 관리하는 UI 복잡성은 감수한다.
- **결과**: 상태 표시줄은 요약값, Webview는 quota 및 상세 usage 조회를 담당하도록 역할이 분리되었다.

---

## 2026-10-01 — 사용자

### 프로젝트·세션·사용자 요청별 토큰·시간 분석

- **의사결정**: 전체 token 합계뿐 아니라 프로젝트·session·사용자 요청 turn 단위의 token, model, 시작 시각과 소요 시간을 영속화한다.
- **근거**: 월간 총량이 증가해도 프로젝트 작업량이 늘어서인지 모델·prompt 사용 방식의 효율이 달라져서인지 구분할 수 없다. turn 단위 자료는 저장량과 schema 복잡성을 늘리지만 기간별 평균, model별 차이와 동일한 종류의 작업 비교를 가능하게 한다.
- **결과**: `project_name`, `session_id`, `root_turn_id`, `agent_id`, `agent_role`, `turn_id`, `turn_index`, timestamp, duration, token component, model, billing 정보를 갖는 turn 중심 schema를 설계했다. `request_count`는 분석 목적에 직접 필요하지 않아 제외했다.

---

### 프롬프트 본문 없이 입력 방식을 비교할 때의 한계

- **의사결정**: 개인정보 보호를 위해 prompt 본문은 SQLite에 저장하지 않는다.
- **근거**: 본문을 저장하면 입력 방식 변화의 자동 분류에는 유리하지만 대화 내용의 중복 보관과 유출 위험이 커진다. 숫자와 구조 metadata만 저장하는 쪽을 선택했다.
- **결과**: 현재 schema만으로 model별 token·시간 비교는 가능하지만, “prompt 작성 방식 A/B”를 자동으로 구분할 명시적 field는 아직 없다. 이 비교가 필요하면 이후 본문 대신 수동 `experiment_tag`나 비식별 prompt 특성치를 별도 결정해야 한다.

---

### 과거 통계는 사용량 화면을 열거나 새로 고칠 때 갱신

- **의사결정**: 과거 누계는 Usage 화면 진입 또는 사용자의 새로 고침 요청 시에만 lazy 갱신하고, extension 시작 시 전체 corpus를 메모리 index로 복원하지 않는다.
- **근거**: 비교 대상 ClaudeCodeUsage의 Claude 경로는 Extension Host에 per-file index와 materialized aggregate를 유지하지만, Codex 경로는 이미 disk persistent index를 사용한다. 우리 요구에서 실시간성이 필요한 것은 quota이고 과거 누계는 사용자가 볼 때만 최신이면 된다. 이 선택은 평상시 메모리·CPU·disk activity를 줄이는 대신 Usage 화면 최초 진입이 느릴 수 있고 화면을 열기 전 합계가 즉시 최신이 아닐 수 있다.
- **결과**: extension 활성화 시 SQLite schema와 quota 기능만 준비하고, 누계는 Usage 화면 진입과 수동 refresh에서만 manifest를 비교해 변경분을 반영하도록 정했다.

---

### 파일 처리 기록으로 변경을 찾고 변경분만 처리

- **의사결정**: JSONL 파일별 `path`, `size`, `mtime`, 가능한 경우 `dev/inode`, 발견 순서, 안전한 byte offset과 tail hash를 manifest로 저장한다.
- **근거**: 매번 전체 파일 내용을 읽는 비용을 피하면서 append, rewrite, truncate, delete와 move를 구분해야 한다. manifest metadata 자체는 매 refresh에 비교·갱신해야 하고, filesystem에 따라 inode를 신뢰할 수 없으며, 중간 수정이나 불완전한 마지막 줄을 검증하는 로직이 추가된다.
- **결과**: unchanged는 body 0 byte, 안전한 append는 tail만, 교체·truncate는 해당 파일 전체, 삭제는 해당 파일 contribution 제거, 새 파일은 전체 parse로 처리한다. 신뢰할 수 없는 move는 `removed + new`로 보수적으로 처리한다.

---

### 파일 처리 기록과 통계를 함께 저장

- **의사결정**: manifest를 별도 JSON 파일이 아니라 SQLite `source_files` table에 두고 candidate 변경과 같은 transaction에서 commit한다.
- **근거**: 별도 manifest는 DB 반영과 파일 쓰기 사이에 crash가 나면 cursor와 실제 aggregate가 어긋날 수 있다. SQLite에 결합하면 transaction과 복구를 얻는 대신 schema migration 책임이 늘어난다.
- **결과**: parse 실패 시 이전 정상 contribution과 cursor를 유지하고, 부분 결과를 새 정상 상태로 commit하지 않는 구조가 되었다.

---

### 주 저장소로 SQLite 선택

- **의사결정**: CSV는 주 저장소로 사용하지 않고 SQLite를 정규화·조회 DB로 사용한다.
- **근거**: CSV의 쉼표 escaping이나 한 줄 parsing 자체가 결정적인 병목은 아니다. 문제는 변경 파일의 기존 row 삭제·교체, 중복 candidate의 재선정, 기간·프로젝트별 index query, 원자적 갱신과 동시 읽기를 위해 결국 파일 전체 rewrite 또는 별도 index가 필요하다는 점이다. SQLite는 native binary packaging, page cache, migration, locking과 worker 연동 비용을 추가하지만 이 작업을 DB engine에 맡길 수 있다.
- **결과**: manifest, project, session, agent, turn과 usage candidate를 SQLite table로 나누고 index를 둔다. 대량 DB 작업은 worker에서 실행하며 Extension Host에는 현재 page만 가져오는 방향을 선택했다.

---

### Claude 중복 응답에서 토큰 집계 후보 선택

- **의사결정**: Claude usage row는 기본적으로 `message.id + requestId`를 response identity로 사용하고, 같은 identity의 후보 중 가장 완전한 token vector 하나를 채택한다.
- **근거**: 하나의 과금 응답이 thinking/text row, partial/final snapshot, proxy placeholder, 다른 transcript의 clone으로 여러 번 기록될 수 있어 JSONL 행을 그대로 더하면 과다 집계된다. 반대로 애매한 ID를 무조건 합치면 서로 다른 요청을 잃는다.
- **결과**: 네 token bucket 합이 가장 큰 후보를 winner로 선택한다. `requestId`가 없을 때 같은 message에 알려진 request가 정확히 하나인 경우만 결합하고, 여러 후보면 추측하지 않고 품질 flag를 남긴다.

---

### 파일 삭제 후 복구를 위해 중복 후보 보존

- **의사결정**: 중복에서 탈락한 source candidate도 SQLite에 보존하고 조회·재구성 시 winner를 선택한다.
- **근거**: 현재 winner가 들어 있는 JSONL이 나중에 삭제되거나 교체되면 이전 runner-up이 유효한 근거가 될 수 있다. 후보 보존은 DB 크기와 winner query 비용을 늘리지만 파일 삭제 후 전체 corpus 재검사 없이 정확한 합계를 복구할 수 있다.
- **결과**: candidate는 `source_file_id`, offset, response key와 함께 저장되고 source file 삭제 시 cascade 제거 후 남은 후보에서 winner가 다시 정해진다.

---

### Codex 응답·누적 토큰의 중복 집계 방지

- **의사결정**: Claude의 composite key 규칙을 Codex에 재사용하지 않는다. 최신 Codex는 `response_id`와 response별 `usage`, legacy Codex는 `last_token_usage` 또는 component high-water delta를 사용한다.
- **근거**: Codex의 `turn_token_usage`와 `thread_token_usage`는 누계 snapshot이므로 각 row를 더하면 같은 사용량이 반복 합산된다. 구형 log는 response별 값이 없을 수 있어 누적 counter 감소와 replay도 처리해야 한다.
- **결과**: 최신 log는 response별 `usage` 합계를 마지막 `turn_token_usage`로 검산하고, legacy log는 동일 vector replay를 0 delta로 처리하며 counter regression을 품질 flag로 남긴다.

---

### 사용자 요청 식별자와 표시 순번 분리

- **의사결정**: 공통 key를 `(provider, session_id, agent_id, turn_id)`로 두고, 여러 agent를 한 요청으로 묶는 `root_turn_id`를 별도로 저장한다.
- **근거**: `turn_id`가 모든 provider·session·agent에서 전역 유일하다는 계약이 없고, Claude transcript의 user row에는 실제 사용자 prompt 외에 tool result도 있다. 식별자를 더 저장하는 비용보다 잘못된 turn 결합 위험이 크다.
- **결과**: Claude는 `promptId`, Codex는 기록된 `root_turn_id`를 우선하며 세션 내 표시 순서는 `turn_index`로 분리했다.

---

### 주·하위 에이전트 구분과 사용자 요청별 토큰 합산

- **의사결정**: `agent_role`은 `main | subagent`만 표현하고, Claude `agent_id`와 Codex `thread_id`를 공통 `agent_id`로 정규화한다. 구체적인 Explore·reviewer 같은 이름은 `agent_type`으로 분리한다.
- **근거**: provider별 이름 차이를 숨기면서 main과 descendant를 질의할 공통 축이 필요하다. 단일 root 합계만 저장하면 agent별 비용 분석과 잘못된 lineage를 검증할 근거가 사라진다.
- **결과**: agent별 turn row는 유지하면서 root summary에서 `main + Σ descendants` token을 계산한다. Codex child/fork가 부모 token prefix를 복제한 legacy log는 검증된 lineage prefix만 한 번 제외하고 부모를 찾을 수 없으면 임의 차감하지 않는다.

---

### 요청 소요 시간은 주 에이전트 기준으로 계산

- **의사결정**: root 요청의 `duration_ms`는 main/root turn 하나에서만 가져오고 subagent duration은 더하지 않는다.
- **근거**: subagent는 동시에 실행될 수 있어 각각의 경과 시간을 합하면 실제 사용자 대기 시간보다 커진다. 이 방식은 개별 agent의 총 compute-time을 보여 주지 않지만 사용자가 느낀 요청 소요 시간을 더 정확히 표현한다.
- **결과**: root 집계는 token에는 descendant를 포함하고 duration에는 `agent_role = main` 값만 사용한다. main 종료 뒤 계속되는 background subagent 시간도 사용자 응답 시간에서는 제외한다.

---

### 기록된 소요 시간이 없을 때 계산 기준

- **의사결정**: 명시적 duration을 우선하고 lifecycle event 차이, 마지막으로 assistant-user timestamp 차이를 사용한다.
- **근거**: provider와 version에 따라 `turn_duration` 또는 `task_complete.duration_ms`가 없을 수 있다. fallback을 허용하면 coverage가 높아지지만 낮은 단계의 값은 실제 작업 시간과 오차가 생긴다.
- **결과**: `duration_source`와 `duration_quality`를 함께 저장하여 exact, derived, approximate, missing을 구분한다.

---

### 캐시·추론 토큰의 이중 집계 방지

- **의사결정**: 공통 field를 `input_tokens`, `uncached_input_tokens`, `cache_write_input_tokens`, `cache_read_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`로 정의한다.
- **근거**: Claude의 raw input은 cache creation/read를 제외하므로 총 input에 더해야 하지만 Codex의 cached input은 이미 input의 부분집합이다. reasoning도 output의 부분집합이다. provider raw field를 같은 공식으로 더할 수 없는 복잡성을 감수해야 이중 집계를 막을 수 있다.
- **결과**: Claude는 세 input bucket을 합쳐 normalized input을 만들고, Codex는 raw input을 총 input으로 유지한다. 두 provider 모두 total은 normalized input과 output만 더한다.

---

### 프로젝트 식별자와 표시 이름 분리

- **의사결정**: 표시용 `project_name`과 충돌 방지용 `project_key`를 분리한다.
- **근거**: 서로 다른 경로에 같은 폴더 이름을 가진 프로젝트가 있을 수 있다. 전체 경로를 그대로 key로 저장하면 개인정보가 늘어날 수 있어 정규화 경로나 local HMAC을 선택할 여지가 필요하다.
- **결과**: 프로젝트별 집계는 provider와 project key를 기준으로 하고 이름은 UI label로만 사용하도록 schema를 구성했다.

---

### 구독 비용과 API 추정 비용 구분

- **의사결정**: `billing_mode`, nullable cost, `cost_source`, `pricing_version`을 분리한다.
- **근거**: 구독제의 turn별 실제 비용은 알 수 없고, API 가격은 모델·cache·시점에 따라 달라진다. 모든 값을 숫자 0이나 현재 가격으로 채우면 실제 청구와 추정을 혼동한다.
- **결과**: 구독제는 cost `NULL`, provider가 준 비용은 provider source, 가격표로 계산한 비용은 estimate source로 저장하도록 했다.

---

### 누락·추정값·파싱 오류를 품질 정보로 표시

- **의사결정**: schema drift, orphan subagent, 누락된 parent, approximate duration, unknown pricing과 parse failure를 조용히 정상값으로 처리하지 않는다.
- **근거**: 로컬 JSONL은 provider 소유 형식이라 version에 따라 달라질 수 있고, 애매한 값을 억지로 보정하면 합계는 보기 좋지만 검증할 수 없게 된다. 품질 field와 diagnostics를 보관하는 추가 비용을 감수한다.
- **결과**: parser version, quality flag, file coverage와 duration/pricing coverage를 저장하고 상세 화면에서 확인할 수 있게 설계했다.
