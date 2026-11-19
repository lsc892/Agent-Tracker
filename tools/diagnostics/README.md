# diagnostics

사용자가 요청한 통계 메모리 진단을 수행한다. 제품 코드와 설치 DB를 변경하지 않으며 일반 자동 테스트·실계정 quota 호출을 실행하지 않는다.

- [summary-memory.cjs](summary-memory.cjs): 실제 로그의 고정 사본·합성 10,000/100요청에서 반복 집계의 GC 전후 메모리·객체 개수·Worker 종료와 별도 프로세스의 힙 스냅샷을 관측한다.
- [summary-worker-memory.cjs](summary-worker-memory.cjs): 같은 고정 사본에서 Worker 4·2·1개 설정을 새 프로세스별로 관측한다.
- [plot-summary-memory.py](plot-summary-memory.py): 집계 메모리 JSON을 PNG·SVG로 시각화한다. Python과 matplotlib이 필요하다.

2026-11-16 진단 실행용 도구다. 먼저 `node node_modules/typescript/bin/tsc -p tsconfig.json`으로 현재 소스를 컴파일한다. `node tools/diagnostics/summary-memory.cjs`가 생성한 비공개 작업 폴더를 두 번째 도구의 인자로 전달한다. 작업 사본·DB·원시 힙은 Git에서 제외한 `tests/.cache/memory-lifetime-*` 안에 남는다. 힙 스냅샷에는 개인 로그의 문자열이 포함될 수 있으므로 공개 산출물로 옮기지 않는다.

보고서는 `docs/research/2026-11-16/`에 숫자·해시·환경만 기록한다. 기존 보고서는 덮어쓰지 않는다. 기본 진단은 전면 재파싱 20회·무변경 갱신 20회·파싱 진입 취소 5회이며, 별도 스냅샷 프로세스는 예열 후 전면 재파싱 20회 전후를 비교한다. 클라이언트 생성·조회·종료는 합성 100요청으로 20회 반복한다.
