# 코드 프리징을 위한 긴 처리 흐름 주석

[Codex quota 조회](../../../src/quota/codex.ts#L45)처럼 한 함수 안에서 외부 호출, 상태 전환, 정리가 이어지면 주요 단계 앞에 한 줄 주석을 붙인다. 변수 설명과 개별 호출 설명은 피하면서 취소·재시도·프로세스 회수 사유를 보존한다.

## 적용

- [Codex 조회](../../../src/quota/codex.ts#L45)에는 세션 시작, 구독 계정 확인, quota 조회·알림, 자식 프로세스 회수의 순서를 표시했다. [RPC 종료](../../../src/quota/codex/rpcSession.ts#L71)는 정상 종료 요청, 종료 신호 강화, 스트림 해제로 구분했다.
- [Claude 조회](../../../src/quota/claude.ts#L41)에서 취소·시간 제한, 401 재시도, 응답 검증·변환의 경계를 표시했다.
- [통계 패널 갱신](../../../src/ui/dashboard.ts#L205)은 스캔 공유, 새 스캔 요청, 결과 반영, 정리로 구분했다. [quota 툴팁](../../../src/ui/quotaTooltip.ts#L89)과 [도표](../../../media/dashboard.js#L437), [도표 막대](../../../media/dashboard.js#L546)는 각각 화면을 구성하는 순서를 표시했다.
- [JSONL 읽기](../../../src/summary/jsonl/index.ts#L25)는 파일 청크 읽기, 행 조립·전달, 압축 스트림 순회·파일 정리로 구분했다. [통계 갱신](../../../src/summary/scanner/refresh/index.ts#L31), [잠금 안에서의 스캔](../../../src/summary/scanner/refresh/index.ts#L82), [최근 사용량 미리보기](../../../src/summary/scanner/refresh/index.ts#L107), [저장 묶음 처리](../../../src/summary/scanner/refresh/persistence.ts#L19)에도 주요 단계의 경계를 표시했다.

## 검증

주석 변경과 공백을 diff로 확인하고 문서 링크가 가리키는 함수 위치와 Webview 스크립트의 문법을 확인했다. 실행 테스트는 수행하지 않았다.
