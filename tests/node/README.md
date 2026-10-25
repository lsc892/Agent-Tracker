# node

Node 테스트 러너로 파서·DB·quota·설정·UI와 배포 도구의 회귀를 검증한다.

- [capabilities.test.ts](capabilities.test.ts) — Skill·MCP·명령·에이전트 호출 집계와 필터·페이지·수집 설정을 검증한다.
- [claude-credentials.test.ts](claude-credentials.test.ts) — 플랫폼별 Claude 인증 파일·Keychain 선택과 실패·취소 처리를 검증한다.
- [claude-settings.test.ts](claude-settings.test.ts) — Claude 로그 보존 기간 설정의 갱신·보존·입력 검증을 확인한다.
- [colors.test.ts](colors.test.ts) — 상태바 색상 해석과 색상 설정 화면의 입력·저장 동작을 검증한다.
- [compressed-jsonl.test.ts](compressed-jsonl.test.ts) — Zstd JSONL의 프레임·UTF-8·오프셋·예산·오류·취소 처리를 검증한다.
- [configuration.test.ts](configuration.test.ts) — 확장 설정의 기본값·정규화·독립 스냅샷·추적 범위를 검증한다.
- [costs-models.test.ts](costs-models.test.ts) — 모델별 사용량·과금 분류·비용 추정과 마이그레이션·조회 경계를 검증한다.
- [extension.test.ts](extension.test.ts) — VS Code와 서비스를 모사해 확장 명령·설정·화면·종료 연결을 검증한다.
- [jsonl.test.ts](jsonl.test.ts) — JSONL 리더의 이미지 생략·청크 경계·오류·취소를 기준 구현과 대조한다.
- [localization-manifest.test.ts](localization-manifest.test.ts) — 설정 manifest 번역의 완전성과 임시 배치·복원을 검증한다.
- [localization.test.ts](localization.test.ts) — 언어 선택·번역 대체·치환과 웹뷰·quota 표시의 다국어 동작을 검증한다.
- [model-classification.test.ts](model-classification.test.ts) — Claude 오류 알림과 Codex 빈 스냅샷의 모델 사용량 분류를 검증한다.
- [names-ui.test.ts](names-ui.test.ts) — 대시보드의 이름 선택·Skill 표·페이지·설정·응답 동기화를 검증한다.
- [names.test.ts](names.test.ts) — 세션·프로젝트 이름의 우선순위·식별자·저장·필터·페이지를 검증한다.
- [npm-installer.test.ts](npm-installer.test.ts) — npm 설치 CLI와 패키지의 VSIX 무결성·실행 인자·설치 확인을 검증한다.
- [parsers.test.ts](parsers.test.ts) — Claude·Codex 파서의 토큰·요청 수명·시간·하위 에이전트 해석을 검증한다.
- [quota-benchmark.test.ts](quota-benchmark.test.ts) — quota 벤치마크의 실계정 동의·자원 보고·합성 종료 시나리오를 검증한다.
- [quota-live.test.ts](quota-live.test.ts) — 합성 응답과 로컬 대역으로 실계정 QA 도구의 대조·오류·정리를 검증한다.
- [quota.test.ts](quota.test.ts) — quota 제공자의 파싱·통신·취소와 서비스의 갱신·만료·재시도를 검증한다.
- [request-title-ab.test.ts](request-title-ab.test.ts) — 제목 집계 SQL 대안이 모든 요약 열과 기대 제목을 보존하는지 검증한다.
- [request-titles.test.ts](request-titles.test.ts) — 요청 제목의 정규화·저장·하위 에이전트 제외와 표·차트 노출을 검증한다.
- [source-retention.test.ts](source-retention.test.ts) — 원본 삭제·부분 유실·복원 시 사용량 보존과 설정 전환을 검증한다.
- [sql-rollup-oracle.test.ts](sql-rollup-oracle.test.ts) — 독립 기대 값으로 롤업의 평균·모델·날짜·세션 필터 의미를 검증한다.
- [status-bar.test.ts](status-bar.test.ts) — quota 상태바와 툴팁의 창 선택·백분율·아이콘·상태 표시를 검증한다.
- [statusbar-toggle.test.ts](statusbar-toggle.test.ts) — VS Code 상태바 패치의 토글·카드·체크섬·백업·복원을 검증한다.
- [summary-db.test.ts](summary-db.test.ts) — 요약 DB의 스키마·마이그레이션·교체·조회·진단 일관성을 검증한다.
- [summary-lock.test.ts](summary-lock.test.ts) — 프로세스·스레드 간 요약 갱신 잠금의 대기·취소·강제 종료 복구를 검증한다.
- [summary-rollup.test.ts](summary-rollup.test.ts) — 공개 DB API의 롤업 조회·갱신·시간대·마이그레이션 일관성을 검증한다.
- [summary-staging.test.ts](summary-staging.test.ts) — 요약 임시 저장소의 계보 해석과 제한된 배치 트랜잭션을 검증한다.
- [summary.integration.test.ts](summary.integration.test.ts) — 로그 탐색부터 파싱·세션 연결·요약 저장까지의 통합 동작을 검증한다.
- [title-transaction-log.test.ts](title-transaction-log.test.ts) — 제목 인덱스 트랜잭션 벤치마크의 실제 갱신·전후 대조·보고를 검증한다.
- [token-breakdown.test.ts](token-breakdown.test.ts) — 입출력·캐시 토큰의 파싱·중복 제거·집계·마이그레이션·표시를 검증한다.
- [ui.test.ts](ui.test.ts) — 웹뷰 메시지의 허용 범위와 자산·보안 정책·요청 상태 표를 검증한다.
- [usage-chart.test.ts](usage-chart.test.ts) — 사용량 표·차트의 정렬·페이지·모델·평균·필터·렌더링 일치를 검증한다.
