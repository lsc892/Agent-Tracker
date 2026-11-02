# runners

Node 및 실제 VS Code 테스트를 실행할 환경과 프로세스를 준비한다.

- [run-tests.cjs](run-tests.cjs) — 컴파일된 Node 테스트를 수집·실행하고 JUnit 결과를 저장한다.
- [test-native-settings.cjs](test-native-settings.cjs) — 언어별 VS Code 테스트 호스트를 준비해 기본 설정 화면 검증을 실행한다.
- [test-vscode.cjs](test-vscode.cjs) — 격리된 VS Code 테스트 호스트와 합성 로그를 준비해 확장 스모크 검증을 실행한다.
