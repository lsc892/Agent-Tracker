# Agent Tracker CI/CD 계획

> 상태: extension 코드·로컬 검증 명령과 CI/benchmark/VSIX artifact workflow 구현. 실제 계정·화면·원격 환경 검증은 릴리스 전 수행한다.
> 기준 문서: [Agent Tracker 설계 명세](./AgentTracker.md)

상세 테스트 목록은 이 문서에서 관리하고, 각 기능 구현과 함께 테스트 코드를 작성한다. CI는 작성된 테스트를 자동 실행하며, CD는 검증을 통과한 버전의 패키징과 배포를 담당한다.

## 실행 구분

| 실행 시점 | 검증·산출물 |
|---|---|
| PR 및 기본 브랜치 push | 타입 검사·lint·빌드, parser fixture 회귀 테스트, manifest·SQLite 통합 테스트, quota 갱신·process 종료, 최소 지원·stable VS Code의 실제 light/dark Webview 테스트 |
| 정기 실행 및 수동 실행 | 대량 파일·큰 session benchmark, 메모리·buffer·대기열 한도와 처리 시간 측정 |
| 릴리스 버전 tag | 해당 commit의 CI 통과 확인 후 VSIX 패키징과 artifact 보관. 외부 배포는 배포 대상 결정 후 연결 |
| 릴리스 전 수동 확인 | 실제 CLI 로그인·실시간 quota 조회, 실행 환경별 인증·data home, light/dark 화면의 가독성 |

## CI 구성 원칙

- extension scaffold와 의존성·테스트 명령을 정한 뒤 `.github/workflows/`에 workflow를 추가한다. 같은 테스트 명령을 로컬에서도 실행할 수 있게 한다.
- CI는 합성·비식별 JSONL fixture와 mock quota 응답을 사용한다. 실제 계정 credential과 개인 대화 로그를 요구하지 않는다.
- timer와 시각은 제어 가능한 clock으로 검증한다. App Server는 대체 process로 응답·오류·timeout·취소와 종료 처리를 검증한다.
- parser·SQLite·Extension Host 통합 테스트는 지원 운영체제에 맞춰 실행한다. Windows 경로·파일 identity와 Linux/macOS 동작, SQLite native module의 로딩·패키징을 검증한다.
- 상태바 command와 Webview 이벤트 연결은 자동 검증하고, 화면 가독성과 실제 로그인·원격 quota 연동은 수동 확인한다.
- `npm run test:vscode`는 별도 프로필에서 실제 확장을 활성화하고 합성 로그로 탭·필터·빈 상태·테마 적용을 검증한다. Linux CI는 Xvfb를 사용하며 결과 JSON과 확장 호스트 로그를 artifact로 보관한다.
- 빠른 CI 실패는 릴리스 패키징을 막는다. benchmark는 별도 workflow에서 측정하고 기준 초과를 보고한다. 절대 시간 기준은 실행 환경별 측정 후 정한다.
- 테스트 결과, benchmark 측정값과 릴리스 VSIX는 workflow artifact로 보관한다. 외부 배포를 연결할 때도 동일 commit의 검증 통과를 조건으로 한다.

## 상세 검증 항목

### manifest와 session 재집계

- 변경 없는 session은 body read 0 bytes; 같은 session의 다른 파일 변경 시 함께 재집계
- append/truncate/replace 후 session 전체 재집계가 full rebuild 결과와 일치
- newline 없는 마지막 row 보류
- winner 파일 삭제 후 남은 원본을 재파싱하여 duplicate runner-up 복구
- move는 신뢰 가능한 inode에서만 최적화
- 파일 session 귀속 변경 시 이전·새 session의 summary와 manifest를 함께 교체
- n개보다 많은 파일과 큰 session도 metadata·parser buffer·대기열 한도 유지
- 묶음 경계의 duplicate와 main/subagent 기록도 사용자 요청당 summary 한 행
- session 교체 실패 시 summary·정상 metadata·삭제가 함께 rollback
- 파일 하나의 parse 실패 시 이전 summary 유지, 상태·처리 위치·기록 시각·오류만 기록
- 오류·중단 후 자동 재시도 없이 종료; 다음 화면 진입·수동 새로 고침에서 새로 조사
- 전체 순회 완료 전 부재 판정 금지; 접근 실패·취소 시 summary 교체와 삭제 금지
- NULL 방문 표시를 포함한 미방문 파일을 keyset pagination으로 이번 실행의 임시 목록에 기록
- 부재 flag 없이 session 교체와 manifest 삭제를 함께 commit; 실패 시 둘 다 보존
- 다음 사용자 요청에서 새 scan으로 재조사; 다시 나타난 파일은 삭제 대상으로 판정하지 않음
- 대상에서 제외된 루트는 이번 scan의 삭제 판정에서 제외
- 여러 창의 refresh 직렬 실행; 일부 session 반영을 전체 최신 통계로 표시하지 않음
- 영속 schema는 manifest·projects·sessions·turn_summary로 구성하며 이름은 요청별 행에 반복 저장하지 않음
- 동일 프로젝트의 중복 세션 제목은 ID로 분리하며 이름 검색·행 선택·제목 변경을 검증
- 기존 DB 전환은 요청 ID·통계·manifest 참조를 보존

### Claude parser

- partial/final usage 중 큰 vector 선택
- requestId 없는 단일 후보 결합
- requestId 후보가 여러 개면 분리
- tool-result user row가 새 root turn을 만들지 않음
- main/subagent transcript가 같은 root prompt에 귀속

### Codex parser

- current `token_usage_record.usage` 합과 turn 누계 일치
- cumulative turn/thread snapshot을 반복 합산하지 않음
- legacy `last_token_usage` 우선
- legacy high-water regression clamp
- fork의 검증된 inherited prefix만 제외

### duration

- explicit duration 우선
- lifecycle 차이 fallback
- timestamp fallback
- 병렬 subagent duration 미합산
- background subagent가 root 종료 뒤 끝나는 경우 정책 확인

### UI와 quota

- 클릭 Quota 화면은 light/dark theme에서 읽히고 hover는 안내만 표시
- 75%/90% threshold 색상
- dynamic label HTML escape
- 두 status item click이 해당 Quota 카드로 이동하고 설정 버튼은 클릭으로 동작
- 실패 시 마지막 성공 값·시각·오래된 값 안내를 유지하고 성공 이력이 없거나 유지 기한이 지나면 `조회 불가` 표시
- 기본 15분 polling, 비활성 중 생략, 복귀 5분 debounce, 실패 backoff, 수동 강제 조회와 중복 병합
- 제공자별 갱신 간격·표시/숨김 및 공통 사용률/남은 비율·간략/상세 설정
- 기존 CLI 로그인, 미로그인, API key, 다른 data home 및 외부 계정 변경 처리
- App Server 성공·오류·timeout·취소 뒤 process 종료, 진행 중 중복 refresh의 단일 실행, 조회 사이 상주 process 없음
- HTTP 요청 수와 로컬 protocol 메시지 수 구분; token 갱신·재시도 때문에 HTTP 1회 고정이라고 가정하지 않음
- reset timestamp timezone과 DST 처리

### 총량·평균·디버깅 조회

- 일·월·프로젝트·세션 총량이 사용자 요청 summary 합계와 일치
- 진행 중 요청은 확인한 token 총량에 포함하고 완료 turn 평균에서 제외
- duration NULL은 평균의 분모에서 제외하고 유효 표본 수 표시
- 서로 다른 경로의 같은 project 이름은 project_key로 구분
- configured timezone의 일·월 경계, DST, 시각 미상 요청의 별도 표시
- main/subagent가 많은 요청도 turn 평균 분모에는 사용자 요청 한 개로 반영
- manifest의 진단 네 column으로 최근 상태·처리 위치·기록 시각·오류 표시
- summary의 문제 파일·byte 위치·원인을 표시하고 이전 정상 수치를 보존

## 참고

- [GitHub Actions의 CI](https://docs.github.com/en/actions/get-started/continuous-integration)
- [Workflow artifact](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)
- [VS Code extension 테스트](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
