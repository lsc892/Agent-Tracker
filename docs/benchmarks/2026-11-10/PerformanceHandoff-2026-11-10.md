# 성능 개선 인수인계

2026-11-10, Asia/Seoul. 대화 기록 없이 다음 작업을 시작하기 위한 진입점이다. 아래 원래 계측의 기준은 `96b894e`이며 실제 작업 전 현재 브랜치·status·후속 커밋을 확인한다. 이후 `4956423`에서 미사용 rollup 상태를 제거했고, 후속 작업으로 최종 이름·결제 설정의 중복 제거가 작업 트리에 적용됐다. 최신 [이름·설정 1회 A/B](MetadataBatchAB-2026-11-10.md)와 [미사용 상태 제거 1회 A/B](RollupTrimAB-2026-11-10.md)를 먼저 읽고 아래 당시 수치를 최신 구현 성능으로 재사용하지 않는다.

## 1. 완료된 변경과 근거

| 커밋 | 현재 동작 | 측정·검증 기록 |
| --- | --- | --- |
| `8f74434` | 정상 성분 최대 16개·합계 1,000요청을 한 transaction에서 저장한다. 특수 성분·큰 단일 성분은 개별 처리하고 실패 시 전체 rollback 후 성분별 재시도한다. | [COMMIT 배칭 A/B](TransactionBatchAB-2026-11-10.md) |
| `96b894e` | 저장 묶음의 마지막에 실제 변경 세션을 중복 제거해 최종 facts로 rollup하고 COMMIT한다. 0변경은 생략하고 1세션은 기존 직접 경로다. | [rollup 일괄 갱신 A/B](RollupBatchAB-2026-11-10.md) |

두 변경 모두 제품에 반영·커밋됐다. 전체 스캔의 모든 쓰기를 한 transaction으로 묶은 것은 아니다. 묶음 안에서 writer 잠금을 잡은 채 await하지 않으며 facts와 두 daily 표는 같은 COMMIT으로 확정된다. 평균·NULL·삭제 보존·특수 성분·취소·실패 처리의 기준은 [현재 명세](../../refrences/AgentTracker.md)와 [의사결정 일지](../../AgentTracker-일지.md)에서 확인한다. 초기 COMMIT 배칭과 후속 rollup의 현재 입력은 각각 1,341·1,346요청으로 다르므로 개선율을 누적 계산하지 않는다.

## 2. 최종 B에서 남은 비용

[rollup A/B JSON](RollupBatchAB-2026-11-10.json)의 `datasets[].summary.initial.*.B.medianMs` 기준 ms다. 최초 수집 결과이며 단일 추가·무변경과 구분한다.

| 구간 | 현재 1,346요청 | 합성 10,000요청 | 상태 |
| --- | ---: | ---: | --- |
| 요청 비교·저장 `storage.summaries` | 45.344 | 241.213 | 다음 DB 개선 우선 후보 |
| COMMIT `storage.commit` | 42.997 | 35.201 | 횟수 배칭 완료 후 남은 비용 |
| rollup `storage.rollups` | 26.265 | 101.313 | 호출 배칭 완료, 세션 전체 합산은 남음 |
| 이름 정리 `storage.pruneNames` | 1.917 | 11.169 | 성분별 반복 확인이 남음 |
| DB 저장 전체 `storage.replace` | 126.711 | 395.726 | 위 단계의 상위 타이머 |
| 원본 읽기·파싱 준비 `scan.parseChanged` | 2,649.124 | 179.925 | 현재 실데이터 전체 갱신의 최대 구간 |
| 최종 요청 집계 `scan.aggregate` | 139.277 | 91.403 | 세션·winner의 최종 DTO 생성/집계 비용 |
| 파일 탐색·stat 등 `scan.discover` | 99.332 | 12.884 | 변경 없는 파일도 확인 |
| 전체 refresh | 3,039.996 | 700.286 | 읽기·집계·저장·마무리 포함 |

상위·하위 타이머와 각 지표의 중앙값을 합산하지 않는다. `readSources`도 원본 준비 단계에 중첩되며 Worker의 순서 대기 시간 등을 포함할 수 있다. 순수 디스크 I/O나 순수 파싱 CPU 시간으로 해석하지 않는다. 현재 입력에서 원본 준비는 전체 refresh의 약 87%다.

## 3. 다음 후보와 먼저 볼 코드

1. **요청 비교·저장의 중복 SQL**: 같은 세션 결제 설정과 이름 UPSERT의 요청별 반복은 후속 [metadata 묶음 변경](MetadataBatchAB-2026-11-10.md)으로 제거했다. 현재 [memoryStore.ts](../../../src/summary/db/memoryStore.ts)의 `collectMetadata`·`saveNames`는 정상 묶음의 고유 키를 처리하고, `saveSummary`·`readModels`·`readCapabilities`·`hasCostChanged`의 요청별 기존 값 조회는 남는다. 다음 후보는 기존 행의 묶음 조회이며 아직 효과를 확인하지 않았다. 최초 구축의 실제 쓰기 비용과 메모리·재시도 계약을 함께 비교한다.
2. **변경 날짜·프로젝트 버킷만 rollup**: [rollups.ts](../../../src/summary/db/rollups.ts)의 `refreshSessions`는 대상 세션 전체의 최종 facts를 합산한다. 다음 후보는 변경 전·후 `(provider, session_id, project_key, local_day[, model_key])`를 모아 해당 범위만 다시 계산하는 것이다. 날짜·프로젝트·모델 이동과 삭제의 이전 버킷, NULL 시각, MIN/MAX·최종 갱신 시각과 시간대 재구축을 보존해야 한다. 아직 구현하지 않았다.
3. **이름 정리의 중복 확인**: 정상 묶음의 영향 키는 후속 metadata 변경에서 모아 transaction 끝에 한 번 prune하도록 반영했다. 반복 세션 snapshot·삭제·재연결의 직접 batch 입력은 중간 삭제·결제 cascade 의미를 보존하는 snapshot별 호환 경로를 유지한다.
4. **원본 준비·탐색**: 실데이터 체감 목표라면 [scanner/refresh/preparation.ts](../../../src/summary/scanner/refresh/preparation.ts), [sourceReader.ts](../../../src/summary/scanner/sourceReader.ts), [sourcePool.ts](../../../src/summary/scanner/sourcePool.ts), [discovery.ts](../../../src/summary/scanner/refresh/discovery.ts)를 본다. 현재도 Worker 풀과 변경 없는 원본 재사용은 적용돼 있다. 변경된 세션의 전체 원본 재처리·관련 원본 확장·전수 stat에서 무엇이 큰지 먼저 분리한다. 과거 [Worker 풀 A/B](../2026-11-09/SourcePoolAB-2026-11-09.md)와 이번 입력·성능을 동일한 것으로 취급하지 않는다.

DB 목적의 다음 작업은 1번의 남은 요청별 조회부터 시작할 수 있다. 전체 갱신 체감 목적이면 4번의 분리 계측을 우선할 수 있다. 이미 적용한 이름·설정·prune을 제외한 후보는 효과를 확인한 채택안이 아니다.

## 4. 다음 A/B를 시작하는 방법

- 저장소 `AGENTS.md`와 [ab-test 스킬](../../../.agents/skills/ab-test/SKILL.md), 현재 사용자의 실행 범위를 읽는다. 현행 저장소 지침은 코드 변경 시 `npm run check`를 요구한다. metadata 후속 변경은 427개 중 421개 테스트가 통과했고 실패 6개는 정리 전 A에서도 재현했다. 기존 테스트 실패와 새 변경 실패를 구분하고, 1회 A/B 요청에서는 반복 통계로 개선을 확정하지 않는다.
- **다음 A는 현재 제품 코드**다. 이전 `rollup-batch-ab-20261110/A`는 `8f74434`이고 다음 baseline으로 사용하면 완료한 rollup 변경까지 섞인다. 현재 소스와 컴파일 산출물을 새 workspace의 A에 고정하고 hash를 기록한 뒤 후보 하나만 B에 적용한다.
- [rollup-batch-ab.cjs](../../../tests/benchmarks/rollup-batch-ab.cjs)는 [transaction-stages-ab.cjs](../../../tests/benchmarks/transaction-stages-ab.cjs)의 공용 main을 재사용한다. 현재 전체·10,000요청, 최초·실제 1건 추가·무변경, 제공자/모델의 일·월·세션·프로젝트 평균을 준비 3쌍·교대 10쌍 비교하고 시간·호출 수·독립 JS facts 대조를 기록한다. 현재 공용 실행기의 기준일과 조회 기간은 2026-11-10 및 2026년으로 고정돼 있으므로 새 작업일·입력 기간에 맞는지 확인하고 원시 결과에 조건을 명시한다.
- [transaction-batch-validation.cjs](../../../tests/benchmarks/transaction-batch-validation.cjs)와 [rollup-batch-validation.cjs](../../../tests/benchmarks/rollup-batch-validation.cjs)는 평균·캐시 NULL·원자성·실패 격리·취소·삭제 보존·이동 등의 직접 검증 출발점이다. 후보의 반례에 필요한 범위만 보완한다. 실데이터의 독립 JS reducer는 정규화 facts를 기대값으로 사용하며 JSONL 파서 전체의 독립 oracle은 아니다.
- 같은 로컬 작업 공간에는 `tests/results/benchmarks/rollup-batch-ab-20261110/`에 비공개 고정 입력과 A/B 빌드·trial DB가 있다. Git 제외 경로라 다른 컴퓨터로는 전달되지 않는다. 다른 환경에서는 새 현재 snapshot으로 같은 A/B를 모두 다시 측정하고 실제 N·분포·입력 hash를 새로 기록한다. 원본 로그·설치 DB는 변경하지 않는다.
- 완료한 구현·원시 표본·실행계획·검증·소스/빌드 ZIP·파일별 SHA는 [날짜 README](README.md)에서 연결된다. ZIP에는 비공개 입력·DB가 없다. 과거 JSON과 ZIP을 덮어쓰지 않고 다음 결과를 새 이름·날짜로 보존한다.

새 세션에 전달할 요청 예시: **“이 인수인계 문서와 AGENTS.md를 읽고, 현재 코드 기준으로 요청 비교·저장의 중복 SQL을 줄이는 후보 하나를 구현한 뒤 현재 데이터와 10,000요청에서 A/B로 검증해줘.”**
