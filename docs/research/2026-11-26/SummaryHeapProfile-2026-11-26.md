# Agent Tracker 수집 경로의 힙 피크와 추가 unboxing 후보

응답·구형 누계 토큰을 `Float64Array`에 담는 기존 B 빌드로 공개 `SummaryClient`를 실행했다. 실로그 733파일·466,960,401바이트와 합성 10,000응답을 사용했다. 매 실행은 빈 SQLite DB의 초기화·최초 수집, 일·월·세션·프로젝트 표·차트, 모델별 세션 최대 1,000행과 진단 최대 100행 조회, 무변경 갱신 5회로 구성했다. 오프라인 quota는 두 제공자의 응답 파서·상태 서비스·호버 요약을 세 프로세스에서 각각 30번 실행했다. [기준 입력과 빌드](../../benchmarks/success/2026-11-26/ThreadTokenBufferAB-2026-11-26.md)

## 관측 위치

각 칸은 3회 실행에서 구간별 피크 `heapUsed`를 모은 중앙값 MiB다. 파일 Worker 행은 실행마다 가장 높은 Worker 한 개의 피크다.

| 스레드 및 구간 | 실로그 | 합성 10,000응답 |
| --- | ---: | ---: |
| 통계 · 초기화 뒤 GC | 8.71 | 8.71 |
| 통계 · 최초 경로 탐색 | 12.48 | 11.53 |
| 통계 · 최초 파싱 | 28.03 | 20.64 |
| 통계 · 최초 최종 집계 | 28.17 | 22.13 |
| 통계 · 최초 SQLite 저장 | 31.56 | 22.13 |
| 파일 Worker · 일반 로그 파싱 | 21.62 | — |
| 파일 Worker · 압축 로그 파싱 | 21.10 | — |
| 통계 · 모델별 세션 최대 1,000행 조회 | 18.50 | 14.86 |
| 클라이언트 · 모델별 세션 최대 1,000행 수신 | 8.13 | 7.69 |
| 통계 · 첫 무변경 갱신의 경로 탐색 | 31.86 | 16.64 |
| 통계 · 첫 무변경 갱신의 이름 읽기 | 35.46 | 10.94 |
| 통계 · 2회차 무변경 갱신의 이름 읽기 | 26.75 | 12.17 |
| 통계 · 5회차 무변경 갱신 뒤 GC | 9.85 | 9.66 |

실로그에서 통계 스레드의 가장 높은 피크는 **첫 무변경 갱신이 끝날 때 35.81 MiB**였다. 직전 수집과 조회가 끝난 상태에서 시작해 잠금 단계 18.76 MiB, 경로 탐색 31.86 MiB, 이름 읽기 35.46 MiB 순으로 높아졌다. 무변경 갱신 5회 모두 원본 본문은 0바이트였다. 회차 사이에 강제 GC한 뒤에도 경로 탐색과 이름 읽기로 5회차 끝에 27.11 MiB까지 다시 올라갔으며, GC 후 9.85 MiB로 돌아왔다. 실로그의 별도 생존 할당 표본에서는 최초 집계 직전에 강제 GC를 해도 24.94 MiB였고, 최초 수집 완료 뒤에는 10.19 MiB였다.

오프라인 quota의 두 제공자 조회·요약을 30번 반복한 힙 피크는 7.94 MiB였고, 준비 뒤와 반복 뒤의 GC 후 값은 5.67 → 5.97 MiB였다. 모듈 전역의 날짜 포매터 캐시는 16개로 제한하며, 고정 SQL 준비문은 DB 연결 단위다. 파일별 응답·누계의 큰 상태는 최초 집계 구간에서 확인됐고, 짧은 반복 관측에서 회차별로 급격히 쌓이는 상태는 관측되지 않았다. [포매터 캐시](../../../src/summary/db/timezone.ts#L2) · [준비문 캐시](../../../src/summary/db/connection.ts#L20)

## 할당 위치와 후보

### 힙 피크를 추가로 낮출 후보

1. **무변경 갱신의 경로 탐색과 이름 읽기.** 수집 Worker의 전체 실행에서 `walk`에 귀속된 누적 할당 추정은 46.97 MiB, `displayName`은 13.14 MiB였다. 재귀 async generator와 경로 문자열, DB의 직전 파일 행, 제목 정규화가 반복된다. 경로 전달 중간 객체를 줄이고, 제목 메타데이터 변경을 안전하게 판별할 수 있는 경우 같은 제목을 반복 정규화하지 않는 쪽을 검토할 수 있다. 값의 대부분은 경로·이름 문자열과 I/O 결과이므로 숫자 버퍼 전환으로 직접 줄이는 범위가 작다. [원본 탐색](../../../src/summary/scanner/refresh/discovery.ts#L23) · [Codex 이름 읽기](../../../src/summary/scanner/names.ts#L11)
2. **파일 Worker의 JSONL 파싱.** 네 Worker의 누적 할당 표본 합계는 약 2.30 GiB였다. 큰 귀속 위치는 `parseChunk` 727.32 MiB, `StreamingFixedProjection.append` 393.36 MiB, `fixedObject` 323.79 MiB, `JsonlLine.append` 243.95 MiB였다. 짧은 줄도 먼저 UTF-8 문자열로 만들고, 긴 줄은 청크를 Latin-1 문자열로 만든 뒤 필드를 선택한다. 남기는 바이트만 디코딩하도록 바꾸면 큰 임시 문자열을 줄일 수 있다. 선택되지 않은 값의 JSON 문법·이스케이프 검증을 보존해야 한다. 스트리밍 파서의 프레임 플래그·상태 코드는 작은 typed array 후보이며, 셰이프 참조와 문자열 처리를 함께 바꾸어야 큰 위치에 영향을 줄 수 있다. [줄 파싱](../../../src/summary/jsonl/index.ts#L65) · [긴 줄 필드 선택](../../../src/summary/jsonl/streamProjection.ts#L105) · [고정 필드 조각](../../../src/summary/jsonl/projection.ts#L56)

### 숫자 인덱스로 보관할 후보

| 후보 | 실로그 집계 직전의 상태 | 적용 방향 |
| --- | --- | --- |
| Codex 응답 키·메타데이터 | 응답 행 19,526개, 고유 턴 ID 1,827개, 고유 응답 ID 19,526개, 모델 5개. 합성 JSON 응답 키는 총 1,913,548 UTF-16 코드 단위였다. 응답 병합 위치의 생존 할당 추정량은 2.68 MiB였다. | 모델·턴 ID를 사전에 한 번씩 보관하고 행에는 `Uint32Array` 인덱스를 붙이는 후보가 있다. 같은 턴 안에서 응답 ID를 비교하면 합성 키 문자열을 줄일 수 있다. 중첩 맵의 오버헤드와 기존 winner 순서를 함께 비교해야 한다. |
| 구형 Codex 누계 비교 서명 | 서명 34,189개, 동일 문자열을 접으면 28,141개. 문자 길이 합은 3,737,690 → 3,079,763 코드 단위다. | 정확한 문자열 사전과 행별 숫자 인덱스가 후보가 된다. 부모 로그의 동일 서명과 첫 불일치 순서를 그대로 판별해야 한다. 이 수치는 실제 V8 문자열 메모리 절감량을 뜻하지 않는다. |
| Claude 응답 winner | 실로그는 메시지 그룹 100개, 합성 10,000응답에서는 5,000개였다. 합성 입력에서 `addClaude`의 집계 직전 생존 표본은 2.07 MiB였다. | 그룹·순번·토큰 행 번호를 같은 길이의 숫자 열에 저장하는 후보가 있다. 응답·요청 ID 맵과 익명 요청 병합, 동점 순서는 보존해야 한다. |
| 최신 Codex 누계 체크포인트 | 이 사본에서 남은 구간은 2개, 응답 키 참조는 4개였다. | 숫자 구조가 고정돼 있지만 이번 입력에서 우선순위가 낮다. |

SQLite 저장 시점의 힙은 비교적 높았지만 전체 갱신에서 `dailyFacts`에 귀속된 누적 할당 추정은 실로그 1.68 MiB였다. 숫자와 문자열을 섞은 행은 현재 SQLite의 JSON 입력에 맞춘 형태다. 저장 힙을 개선한다면 JSON 직렬화 전후의 배열·요약 수명부터 따로 측정할 수 있다. [응답 병합](../../../src/summary/scanner/refresh/aggregation.ts#L171) · [구형 서명](../../../src/summary/parsers/threadUsage.ts#L299) · [일별 저장 입력](../../../src/summary/db/dailyFacts.ts#L15)

## 측정 범위

- Node v24.14.1·Windows에서 입력당 경량 힙 관측 3회, 할당 표본 1회, GC 직후 생존 할당 표본 1회를 각각 새 프로세스에서 실행했다. 수집 Worker와 최대 4개의 파일 Worker를 분리해 계측했다. 힙은 5ms 및 단계 경계 표본의 관측값이며, 동기 함수 안의 더 짧은 피크는 빠질 수 있다. 한 단계의 힙에는 이전 단계에서 남은 메모리도 들어 있다.
- V8 inspector의 할당 간격은 평균 16 KiB이며, 누적 할당 표본에는 GC로 회수된 객체도 넣었다. 네 파일 Worker의 할당량은 합산했다. 누적 할당량, 시점의 `heapUsed`, 프로세스 RSS는 서로 다른 지표다. 생존 할당 표본은 별도 실행에서 강제 GC한 시점 기준이다. [Node.js Inspector](https://nodejs.org/download/release/latest-v24.x/docs/api/inspector.html#heap-profiler)
- 입력·빌드 해시, 최초 파싱 파일 수·바이트, 전체 토큰, 후속 무변경 본문 0바이트 및 진단 오류 0개를 확인했다. 측정 범위는 Agent Tracker의 Node 백엔드와 오프라인 quota다. VS Code Extension Host 전체, Webview DOM·렌더러, 실제 계정 네트워크와 SQLite 네이티브 할당의 세부 원인은 미측정이다.

## 재실행

```powershell
node --no-warnings tools/diagnostics/summary-heap-profile.cjs --workspace='<이전 ArrayBuffer A/B Workspace>' --reference=docs/benchmarks/success/2026-11-26/ThreadTokenBufferAB-2026-11-26.json --output=tests/results/benchmarks/SummaryHeapProfile-rerun.json
```

[진단 실행기](../../../tools/diagnostics/summary-heap-profile.cjs) · [원시 계측값](SummaryHeapProfile-2026-11-26.json)
