# tests

기능 회귀 테스트, 실제 VS Code 검증과 성능 비교에 필요한 코드와 입력을 모은다.

- [benchmarks](benchmarks/) — 요약·JSONL·SQL·quota 처리의 정확성과 성능을 비교하는 도구를 모은다.
- [fixtures](fixtures/) — 테스트와 벤치마크에서 재사용하는 합성 입력·기준 구현·보조 프로세스를 제공한다.
- [node](node/) — Node 테스트 러너로 파서·DB·quota·설정·UI와 배포 도구의 회귀를 검증한다.
- [runners](runners/) — Node 및 실제 VS Code 테스트를 실행할 환경과 프로세스를 준비한다.
- [vscode](vscode/) — 실제 VS Code 확장 호스트와 렌더러에서 설정·대시보드·상태바를 검증한다.
