# Orca와 Agent Tracker의 Codex 사용량·초기화 시간 비교

확인일: 2026-10-08(Asia/Seoul). Orca 공개 소스 commit `952898b8b95cf56228eca4055a4647123b27f73f`와 현재 Agent Tracker를 비교했다. 실제 계정의 오류 상황을 재현한 결과는 아니다.

## 확인한 차이

| 상황 | Orca | Agent Tracker |
| --- | --- | --- |
| 정상 조회 | 짧은 App Server를 실행해 quota를 조회한다. | 같은 방식으로 서버의 quota window·사용률·초기화 시각을 읽는다. |
| App Server가 주간 한도만 반환 | 웹 사용량 API로 5시간 window를 보완한다. | 반환한 window만 표시하며 누락한 한도를 추정하지 않는다. |
| App Server 조회 실패 | 인증 오류를 제외한 일부 실패에서 웹 API fallback을 시도한다. WSL 계정은 웹 API를 먼저 시도한다. | 제공자 오류와 마지막 정상 snapshot을 표시한다. 별도 HTTP fallback이 없다. |
| 초기 실행이 느림 | 초기화 30초·RPC 10초, WSL은 각각 40초·25초 제한을 분리한다. | 초기화·계정·quota·종료를 포함한 전체 제한이 15초다. |
| quota 기간의 구형 표현 | 5시간·주간 기간의 ±1분 차이를 허용하며 알려지지 않은 기간에는 primary/session·secondary/weekly fallback이 있다. | 실제 `windowDurationMins`를 label로 표시하며 정확한 300·10080분을 상태바의 기본 window로 선택한다. |
| 초기화 시각 | 서버의 초 단위 시각을 ms로 변환한다. | 같은 변환 후 분 단위 카운트다운을 갱신한다. 시각이 지났다고 사용률을 0으로 만들지 않는다. |

Orca의 보완은 `https://chatgpt.com/backend-api/wham/usage`에 저장된 계정 인증으로 조회하여 서버 사용량을 받는다. JSONL 토큰 합계로 구독 quota를 역산하는 경로가 아니다. [조회 분기](https://github.com/stablyai/orca/blob/952898b8b95cf56228eca4055a4647123b27f73f/src/main/rate-limits/codex-fetcher.ts), [5시간 보완](https://github.com/stablyai/orca/blob/952898b8b95cf56228eca4055a4647123b27f73f/src/main/rate-limits/codex-backend-usage-client.ts), [기간 분류](https://github.com/stablyai/orca/blob/952898b8b95cf56228eca4055a4647123b27f73f/src/main/rate-limits/codex-rate-limit-window-classification.ts), [초기화 시각 변환](https://github.com/stablyai/orca/blob/952898b8b95cf56228eca4055a4647123b27f73f/src/main/rate-limits/codex-rate-limit-window-mapper.ts).

## 증상에 대한 해석과 반영 범위

시작 직후 15초를 넘는 초기화, App Server가 5시간 window를 생략한 응답, 기존 CLI의 기간 표현 차이는 두 제품의 표시가 달라질 수 있는 구조적 원인이다. quota가 100%라는 사실만으로 초기화 시각을 잃는 것은 아니다. Agent Tracker도 유효한 100%·`resetsAt` 응답은 그대로 처리하므로 사용자 증상의 직접 원인을 확정하려면 당시의 window 존재 여부·기간·오류·조회 시간을 대조해야 한다. 인증·응답 본문 없이 이 값만 확인하면 된다.

이번 변경은 카드의 초기화 정보 배치와 표시 옵션을 반영했다. Orca의 비공개 웹 API·인증·WSL fallback은 추가하지 않았다. 향후 보완을 구현한다면 App Server의 느린 시작과 기간 표현을 먼저 구분하고, 서버가 누락한 한도의 HTTP 보완은 별도 오류·인증·정확도 검증 범위로 다뤄야 한다.

‘누계 시간’이 통계의 요청 소요 시간을 뜻한다면 다른 경로다. Agent Tracker의 과거 요청 시간은 JSONL의 명시적 duration 또는 요청 시작·완료 이벤트에서 계산하며 App Server quota 조회로 수집하지 않는다. 통계는 화면에 들어갈 때 원본을 갱신한다. 5h·wk 초기화 시간과 요청·세션 소요 시간을 같은 값으로 취급하지 않는다.
