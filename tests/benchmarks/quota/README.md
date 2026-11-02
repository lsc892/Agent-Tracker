# quota

quota 조회 시나리오와 운영체제별 자원 샘플러로 시간·메모리를 측정한다.

- [benchmark.cjs](benchmark.cjs) — quota 조회 시나리오별 실행 시간과 자식 프로세스 자원 사용량을 측정한다.
- [sample-rss.cjs](sample-rss.cjs) — Linux·POSIX 대상 프로세스의 RSS를 주기적으로 읽어 표준 출력으로 전달한다.
- [sample-rss.ps1](sample-rss.ps1) — Windows 대상 프로세스의 작업 집합과 CPU 사용 시간을 주기적으로 전달한다.
