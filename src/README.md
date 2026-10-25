# src

확장의 시작·설정·quota 조회·사용량 집계·화면을 연결하는 실행 코드를 둔다.

- [extension.ts](extension.ts): VS Code의 활성화·비활성화를 앱의 시작·종료로 연결한다.
- [app.ts](app.ts) — `AgentTrackerApp`: 서비스와 화면을 구성하고 명령·설정 변경·종료 순서를 조율한다.
- [configuration.ts](configuration.ts): 설정을 정규화하고 제공자별 로그 경로를 구성한다.
- [claudeSettings.ts](claudeSettings.ts): 기존 설정을 보존하며 Claude의 로그 정리 기간 설정을 갱신한다.
- [version.ts](version.ts): 확장 manifest에서 설치 버전을 읽는다.
- [configuration/](configuration/README.md): 설정 키·기본값·타입과 값 읽기 규칙을 정의한다.
- [localization/](localization/README.md): 호스트와 Webview의 언어 선택·번역 자원을 제공한다.
- [quota/](quota/README.md): 제공자별 구독 quota를 조회하고 최신 상태와 갱신 주기를 관리한다.
- [summary/](summary/README.md): 로컬 대화 로그를 수집·집계하고 SQLite 통계를 조회한다.
- [ui/](ui/README.md): 상태바와 통계·진단·색상 설정 화면을 관리한다.
