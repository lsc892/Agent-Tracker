# 통계 갱신의 구간별 힙 사용량과 GC 회수

2026-11-20, Asia/Seoul. Windows x64, Node 24.19.0, V8 13.6, SQLite 3.53.3에서 `f1f4eb4`의 SHA-256 체크포인트 경로를 계측했다.

## 요약

- 실제 로그 391파일·848요청의 무변경 갱신 16회에서 **GC 후 힙은 32.66~32.98MiB**였다. 전면 재파싱 6회와 통계 클라이언트 생성·조회·종료 20회에서도 주요 작업 객체와 Worker가 반복해서 누적되는 현상은 재현되지 않았다.
- 가장 큰 상주 할당은 DB 수명 동안 파일별 파서 상태와 winner를 보관하는 `sourceCheckpoints`였다. 실제 입력에서 이 Map만 비우자 GC 후 힙이 **31.99 → 7.33MiB**로 내려가 **24.66MiB**가 회수됐다. 같은 방식으로 합성 10,000요청은 **17.32MiB**, 100요청은 **0.21MiB**가 회수됐다.
- 실제 무변경 갱신은 파싱한 파일이 **0개**여도 약 **549.5MiB**를 읽어 해시를 검증했고, 파일 준비 단계에서 통계 스레드 힙이 **82.42MiB**까지 올랐다. 합성 10,000요청의 최초 갱신은 최종 요청 생성과 SQLite 저장에서 힙이 크게 올랐다.
- Codex의 `spawnRequests`는 출력이 없는 호출을 턴 종료 후에도 보관했다. 합성 로그에서 미응답 호출 10,000개가 남았고 대응 출력을 추가한 뒤 0개로 줄었다. 실제 로그의 잔류 항목은 37개였다.

## 구간별 관측 힙

단위는 MiB다. 각 작업 구간의 값은 해당 구간과 그 하위 단계에서 관측한 통계 실행 스레드의 누적 `heapUsed` 피크다. 최초 갱신은 입력당 1회, 실제 무변경 갱신은 16회 피크의 중앙값이다. 경계와 10ms 타이머 표본 사이의 피크는 빠질 수 있다. 파일 Worker 전체와 SQLite 네이티브 메모리를 포함하는 프로세스 RSS도 별도로 기록했다. [Node.js 메모리 지표](https://nodejs.org/api/process.html#processmemoryusage)

| 구간 | 실제 848요청 최초 | 실제 무변경 | 합성 10,000요청 최초 | 합성 100요청 최초 |
| --- | ---: | ---: | ---: | ---: |
| 파일 발견·메타데이터 | 9.63 | 41.91 | 8.23 | 6.84 |
| 파일 읽기·해시·파싱 | 35.81 | 82.42 | 32.82 | 8.50 |
| 관련 파일·부모 요청 연결 | 36.77 | 83.42 | 33.06 | 8.06 |
| 최종 요청·모델·도구 집계 | 48.12 | 83.50 | 59.81 | 8.78 |
| SQLite 비교·저장 | 54.52 | 83.50 | 86.89 | 9.34 |
| 갱신 완료 후 GC | 32.32 | 32.91 | 25.18 | 7.58 |

실제 무변경 갱신은 파서와 winner 상태를 파일 Worker에 보내고 결과를 다시 받는 경로를 탄다. 구조화 복제로 양쪽에 같은 상태가 생긴다. 실측한 준비 단계의 피크에는 파일 탐색 후 살아 있던 객체와 새로 할당한 객체도 함께 들어 있다. 합성 10,000요청의 별도 전면 재파싱 4회에서는 자연 GC 이벤트 시간이 회당 약 **28~36ms**였다. [Worker 요청](../../../src/summary/scanner/sourcePool.ts#L143) · [Worker 응답](../../../src/summary/scanner/sourceWorker.ts#L27) · [Node.js 구조화 복제](https://nodejs.org/api/worker_threads.html#portpostmessagevalue-transferlist)

## 오래 남는 참조와 할당 절감 후보

| 위치 | 관측 결과 | 후보 |
| --- | --- | --- |
| [DB 체크포인트 Map](../../../src/summary/db/index.ts#L23) | 실제 391파일에 원본 winner 18,134개와 파서 상태를 보관한다. 성공한 탐색에서 소실 파일의 엔트리를 제거하고 DB를 닫거나 데이터를 지울 때 전체 Map을 비운다. | 크기와 보관 기간에 상한을 두는 후보를 비교한다. 현재 읽기 경로에서 캐시에 없는 파일은 전체 재파싱되므로 시간 비용도 측정해야 한다. |
| [Codex 미응답 호출](../../../src/summary/parsers/codex.ts#L164) | `spawnRequests`는 대응하는 출력이 올 때 엔트리를 지운다. 합성 미응답 호출 10,000개에 대응 출력을 추가하자 GC 후 힙이 **7.96 → 7.15MiB**가 됐다. | 턴 종료나 기간 기준으로 엔트리를 제거하기 전에 늦게 도착하는 출력의 부모 요청 귀속을 확인한다. |
| [파일 준비](../../../src/summary/scanner/sourcePreparation.ts#L34) · [winner 복원](../../../src/summary/aggregation/sourceWinners.ts#L33) | 재개가 확인되면 미리 만든 빈 winner를 버린다. 복원할 때도 `SourceEvidence`의 새 Map·Set·배열을 스냅샷 값으로 곧바로 덮어쓴다. `SourcePreparation.bytes`와 `elapsedMs`는 벤치마크에서 사용한다. | 전체 파싱이 확정됐을 때 빈 상태를 만든다. 파일 끝까지 동일하다는 검증이 끝나면 기존 체크포인트를 재사용하고 Worker는 검증 결과만 보낸다. |
| [이벤트 정규화](../../../src/summary/aggregation/sourceEvidence.ts#L20) · [SQLite 비교](../../../src/summary/db/memoryStore/index.ts#L276) · [집계 정렬](../../../src/summary/aggregation/turns.ts#L33) | 합성 10,000요청 재파싱에서 `Object.entries(event)`의 임시 배열이 상위 할당 표본에 약 **19MiB** 잡혔다. 저장 비교에서는 SQLite 행을 배열로 바꿔 JSON으로 직렬화하고, 정렬 비교는 문자열마다 `Buffer.from()`을 호출한다. | 필요한 필드만 순회하고, 동일 행을 필드 단위로 비교하는 후보를 검토한다. 정렬에서 할당을 줄일 경우 SQLite UTF-8 순서도 유지해야 한다. |

**DTO 풀링은 후순위다.** V8은 짧게 쓰고 버리는 객체를 저렴하게 회수한다. 전역 DTO 풀은 풀 자체를 상주시키고, 원본 참조가 남지 않도록 반환 시 초기화해야 한다. 이 코드에서는 범용 풀에 앞서 파일 Worker 안에서 순차적으로 쓰는 **64KiB 읽기 버퍼**의 재사용을 비교할 수 있다. 모듈 전역의 날짜 포매터 Map은 이미 최대 16개로 제한돼 있다. [읽기 버퍼](../../../src/summary/scanner/sourceReader.ts#L67) · [날짜 포매터](../../../src/summary/db/timezone.ts#L2) · [V8 세대별 GC](https://v8.dev/blog/trash-talk) · [JavaScript 객체 풀링 사례](https://web.dev/articles/speed-static-mem-pools) · [DevTools 할당 샘플링](https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/#method-startSampling)

## 입력과 검증 범위

- 실제 로그는 기본 경로에서 391파일·576,177,991바이트의 고정 사본을 만들었다. 합성 10,000요청과 100요청은 각각 100파일·10파일에 Claude와 Codex 요청을 절반씩 배치했다. 실제 입력에서 파일 Worker는 최대 4개였고, 합성 입력의 파일 준비는 순차 경로를 탔다.
- 입력마다 무변경 16회, 전면 재파싱 6회, 파싱 진입 취소 4회, 세션 페이지 최대 100행과 차트 데이터 조회 16회를 관측했다. 전면 재파싱과 취소 표본에서는 시험 DB의 파서 버전을 무효화했다. 시나리오 종료와 복구 뒤 요청·토큰 합계 및 요청 facts 해시를 대조했다. 합성 입력에는 기존 파일에 요청을 한 건씩 10회 추가한 뒤 원래 파일 크기로 되돌리는 시험도 수행했다.
- 파일 Worker는 각 갱신이 끝날 때 0개였다. 합성 100요청에서 통계 클라이언트를 20회 만들고 조회한 뒤 종료했으며 매회 GC 후 `SummaryClient`, `WorkerTransport`, `RefreshController` 인스턴스와 활성 Worker가 0개였다.
- 관측 범위는 통계 스캔, DB 저장·조회, 차트 데이터 생성과 Worker 수명이다. VS Code Webview 렌더러와 실계정 quota 메모리는 미측정이다.

[측정 표본 JSON](SummaryHeapAudit-2026-11-20.json) · [11월 16일 집계 메모리 진단](../2026-11-16/SummaryMemory-2026-11-16.md) · [11월 20일 전수 해시 시간 비교](../../benchmarks/failure/2026-11-20/ContentFingerprintFailure-2026-11-20.md)
