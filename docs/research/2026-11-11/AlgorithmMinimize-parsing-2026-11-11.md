# 파싱 알고리즘 최소화

2026-11-11, Asia/Seoul. 사용자가 현재 기능을 보존한 알고리즘 최소화와 불필요한 방어 코드 제거를 직접 요청한 범위에서 적용한다. 소스 파일 분리·공개 API·로그 형식 지원 범위는 바꾸지 않는다.

## 검토와 적용 계획

| 경로 | 현재 중복 | 선택한 변경 |
| --- | --- | --- |
| [common.ts](../../../src/summary/parsers/common.ts) | 요청 제목의 블록 filter/map과 전체 줄 split/map, 토큰 스키마의 빈 객체·필수 필드 중복 검사 | 블록을 한 번 읽고 첫 유효 줄에서 끝낸다. 필수 필드 검사로 이미 거부되는 빈 객체 검사를 제거한다. |
| [claude.ts](../../../src/summary/parsers/claude.ts) | 모든 메시지 content에서 tool_result를 찾지만 사용자 메시지만 판정에 사용; root 갱신 분기 중복 | 외부 사용자 요청 판정에만 content 탐색을 하고 root 선택을 같은 우선순위로 표현한다. |
| [codex.ts](../../../src/summary/parsers/codex.ts) | 같은 lifecycle 시각을 두 번 파싱; 보장된 identity를 legacy 처리에서 재검사 | 이벤트별 시각을 한 번 계산하고 이미 확정한 record identity를 사용한다. |
| [capabilities.ts](../../../src/summary/parsers/capabilities.ts#L36) | 호출마다 인자 필드 7개를 각각 regex 검색, 경로 match 전체 배열, 정규화 flatMap과 O(n²) 중복 비교 | 지원 필드는 한 regex 순회로 찾고 각 필드의 첫 출현 규칙을 유지한다. 경로 match iterator와 순서 보존 Set으로 한 번 정규화·중복 제거한다. |
| [JSONL](../../../src/summary/jsonl/index.ts#L36), [sourceReader.ts](../../../src/summary/scanner/sourceReader.ts), [sourceFingerprint.ts](../../../src/summary/scanner/sourceFingerprint.ts) | Buffer 검색 결과에 범위를 다시 검사하고 lstat의 isFile 뒤 isSymbolicLink를 중복 확인 | 검색에 사용한 Buffer의 길이로 보장된 범위 검사와 isFile로 이미 거부되는 symlink 검사를 제거한다. |

## 유지하는 경계

- [JSONL](../../../src/summary/jsonl/index.ts)의 이미지 문자열 검증, 줄 예산, UTF-8 청크·부분 줄, 취소·파일 종료와 [Zstd](../../../src/summary/jsonl/zstd.ts)의 프레임 검증·자원 회수는 실제 오류 계약이다.
- [sourceReader.ts](../../../src/summary/scanner/sourceReader.ts), [sourcePreparation.ts](../../../src/summary/scanner/sourcePreparation.ts), [sourceFingerprint.ts](../../../src/summary/scanner/sourceFingerprint.ts)의 파일 교체·재작성·부분 identity 보존을 유지한다.
- 요청 제목의 마지막 명시 요청 구간 선택, 줄 제외 규칙, 80자 제한과 도구 사용량 순서·중복 기준을 유지한다.
- legacy/current·fork·rootless subagent·명시 root·누계 역행 처리와 parser 이벤트 순서를 유지한다.

## 검증 계획과 한계

호출부와 기존 테스트의 계약을 읽고 diff·컴파일로 확인한다. 사용자 지시에 따라 테스트 코드를 추가·변경·실행하거나 임시 재현·검증 스크립트를 만들지 않는다. 실제 로그 비교·성능 측정은 수행하지 않으므로 실행 결과의 동등성이나 속도 개선량을 실측했다고 주장하지 않는다.

## 적용 결과

- 위 후보를 기존 파일 안에 모두 적용했다. [제목 추출](../../../src/summary/parsers/common.ts#L42)은 마지막 요청 marker를 찾은 뒤 첫 유효 줄에서 반환한다. 텍스트 블록당 object 변환은 한 번이며 전체 줄 배열·trim 배열을 만들지 않는다.
- [Claude 요청 판정](../../../src/summary/parsers/claude.ts#L73)은 사용자·비메타·비sidechain인 경우에만 tool_result를 찾는다. 기존 root 선택 우선순위와 API 실패·중단 초기화는 유지한다.
- [Codex](../../../src/summary/parsers/codex.ts#L179)는 시작·완료 시각과 current thread ID를 재사용한다. [legacy 누계](../../../src/summary/parsers/codex.ts#L234)는 동일 signature·high-water·출력 flag 순서를 유지하면서 불필요한 high-water 복사와 Set을 제거한다. record 생성 때 보장된 identity를 다시 부재 검사하지 않는다.
- [도구 분류](../../../src/summary/parsers/capabilities.ts#L114)는 정규화 후 `(category, name)` 순서를 유지하는 Set으로 중복 제거한다. 이름·카테고리·원래 호출 index와 동적 표현식 제외 규칙은 유지한다.
- 기존 [제목](../../../tests/node/request-titles.test.ts#L22)·[파서](../../../tests/node/parsers.test.ts#L42)·[도구](../../../tests/node/capabilities.test.ts#L19) 계약과 호출부를 읽고 diff를 검토했다. `tsc -p tsconfig.json --noEmit`, 변경 파서·JSONL의 ESLint와 `git diff --check`는 통과했다. 테스트·벤치마크·실제 로그 비교는 실행하지 않았다. 통합 컴파일·린트 결과는 상위 보고서에서 확정한다.
- 소스 구조 변경이나 추가 승인 대기인 큰 변경은 없다. 파일 교체·압축·이미지·부분 줄 등 실제 입력 경계를 없애는 후보는 기능 보존 범위를 벗어나므로 적용하지 않았다.

## 후속 실측

성능·정합성 측정 요청에 따라 [합성 파싱·계보 900 checks](../../benchmarks/2026-11-11/AlgorithmMinimizeParsingValidation-2026-11-11.json)와 [실제·합성 A/B](../../benchmarks/2026-11-11/AlgorithmMinimizeAB-2026-11-11.md)를 실행했다. 이벤트 순서·identity·flags·제목·도구·오류·청크·압축·파일 경계와 독립 기대값을 통과했다. 실제 symlink 생성은 Windows EPERM으로 생략했다. 현재 입력의 원본 준비는 2625.875→2566.574ms였지만 I/O·Worker·winner 비용을 포함하며 개별 파싱 함수의 효과로 분리하지 않는다. 10,000건의 해당 구간 차이는 미미하고 100건은 소폭 악화했다. 비공개 실제 로그 전체의 독립 파서 oracle은 없다.
