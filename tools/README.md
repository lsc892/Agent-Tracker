# tools

설정·번역 생성, 배포 패키징, quota 실계정 QA와 로컬 VS Code 보조 작업을 수행한다.

- [configuration.cjs](configuration.cjs) — 공통 TypeScript 설정 정의로 VS Code manifest의 설정 항목을 생성한다.
- [localization-manifest.cjs](localization-manifest.cjs) — 패키징·테스트·디버깅 중 manifest 번역을 임시 배치하고 원본을 복원한다.
- [localization.cjs](localization.cjs) — 번역 사전·사용처를 검증하고 manifest 번역과 실행용 다국어 자산을 동기화한다.
- [npm](npm/) — VSIX를 동봉한 npm 설치 CLI와 공개 패키지 구성을 관리한다.
- [package.cjs](package.cjs) — 번역을 생성하고 임시 manifest를 적용해 현재 확장을 VSIX로 패키징한다.
- [quota](quota/) — 실제 계정의 quota 응답과 제품 파싱·표시·프로세스 정리를 독립 대조한다.
- [vscode](vscode/) — 로컬 VS Code의 quota 카드 토글 패치를 적용·검사·복원한다.
