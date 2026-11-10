# 정상 성분 묶음 저장 트랜잭션 A/B

2026-11-10, Asia/Seoul. 사용자 요청에 따라 서브에이전트가 구간 계측·제품 구현·독립 정확성 검증을 분담했다. 현재 데이터와 10,000요청을 비교하고, 현재 데이터의 최대 구간인 반복 COMMIT을 줄이는 변경을 제품에 반영했다.

가정: 정상 성분마다 반복하는 COMMIT이 현재 데이터 최초 저장의 최대 비용이다. 동일한 성분별 SQL을 제한된 묶음에서 순서대로 실행하면 COMMIT 횟수와 누적 저장 시간이 감소한다.

개선 방향: A = 작업 시작 시점의 소스·빌드, B = 정상 성분 최대 16개·합계 1,000요청을 한 동기 transaction에서 저장한다. 단일 성분·큰 성분·특수 처리는 기존 경로를 사용한다. 평균 SQL·PK·인덱스·스키마·WAL·동기화 설정은 동일하다.

## 1. 가장 오래 걸린 두 구간

아래는 본 측정 A의 같은 깊이 구간 중앙값이다. `summaries` 아래 비교·facts·모델·Skill·비용, `rollups` 아래 DELETE·INSERT는 부모와 중첩되므로 순위에 함께 넣지 않았다.

| 규모·작업 | 1위 | 2위 |
| --- | ---: | ---: |
| 현재 1,341요청 최초 수집 | COMMIT 254.736 ms | rollup 유지 77.991 ms |
| 10,000요청 최초 수집 | 요청 비교·저장 244.449 ms | rollup 유지 138.643 ms |
| 현재 1,341요청에서 1건 추가 | COMMIT 2.159 ms | rollup 유지 1.054 ms |
| 10,000요청에서 1건 추가 | COMMIT 2.093 ms | 요청 비교·저장 1.780 ms |

초기 진단 1회에서도 현재 COMMIT 259.276 ms, 10,000요청의 요청 저장 252.530 ms가 각각 1위였다. 현재 데이터의 최대 비용이자 두 규모의 추가 작업에서도 1위인 COMMIT을 이번 후보의 대상으로 선택했다. 10,000요청 최초 수집의 최대 구간인 요청 비교·저장과 그 다음 rollup SQL은 후속 후보로 남긴다.

## 2. 결과

각 셀은 A → B 중앙값 ms (개선율)이다. 개선율 = `(A - B) / A × 100`, 양수는 개선이다. 준비 3쌍은 제외하고 A→B/B→A를 교대로 10쌍 측정했다.

| 측정 항목 | 현재 데이터, 추가 전 1,341요청 | 추가 전 10,000요청 |
| --- | ---: | ---: |
| 최초 수집의 성분 저장·COMMIT 전체 | 409.971 → 173.802 (+57.61%) | 510.667 → 433.178 (+15.17%) |
| 최초 수집의 COMMIT 누적 시간 | 254.736 → 42.641 (+83.26%) | 107.094 → 36.080 (+66.31%) |
| 최초 전체 refresh | 3,299.436 → 3,071.447 (+6.91%) | 810.789 → 729.912 (+9.98%) |
| 요청 1건 추가의 성분 저장·COMMIT 전체 | 5.004 → 4.990 (+0.29%) | 6.032 → 5.576 (+7.55%) |
| 요청 1건 추가의 전체 refresh | 401.750 → 404.673 (-0.73%) | 23.485 → 23.189 (+1.26%) |
| 변경 없는 전체 refresh | 109.134 → 108.919 (+0.20%) | 18.789 → 18.675 (+0.60%) |
| 추가 후 일별 평균 토큰 조회·제공자 기준 | 2.086 → 1.996 (+4.29%) | 0.907 → 0.903 (+0.45%) |
| 추가 후 월별 평균 토큰 조회·제공자 기준 | 1.603 → 1.536 (+4.18%) | 0.790 → 0.786 (+0.54%) |
| 추가 후 세션별 평균 토큰 조회·제공자 기준 | 3.335 → 3.241 (+2.84%) | 1.187 → 1.189 (-0.16%) |
| 추가 후 프로젝트별 평균 토큰 조회·제공자 기준 | 1.577 → 1.539 (+2.39%) | 0.746 → 0.753 (-0.97%) |
| 추가 후 일별 평균 토큰 조회·모델 기준 | 2.234 → 2.252 (-0.79%) | 1.202 → 1.215 (-1.06%) |
| 추가 후 월별 평균 토큰 조회·모델 기준 | 1.805 → 1.802 (+0.19%) | 1.110 → 1.117 (-0.62%) |
| 추가 후 세션별 평균 토큰 조회·모델 기준 | 4.032 → 3.993 (+0.96%) | 2.081 → 2.139 (-2.79%) |
| 추가 후 프로젝트별 평균 토큰 조회·모델 기준 | 1.866 → 1.835 (+1.69%) | 1.113 → 1.118 (-0.44%) |

최초 성분 저장과 전체 refresh는 두 규모 모두 B가 10/10쌍 빨랐다. 1건 추가의 전체 refresh는 현재 4/10쌍, 10,000건 6/10쌍에서 B가 빨랐다. 단일 성분 저장 경로와 거래 수가 동일하므로 추가 작업의 개선으로 판정하지 않는다. 변경 없는 갱신도 성분 저장 0회로 동일했다. 평균 조회 SQL은 변경하지 않았으며 작은 조회 시간 차이를 이번 변경의 일반적인 조회 개선으로 해석하지 않는다.

## 3. COMMIT 감소와 거래당 비용

| 최초 수집 항목 | 현재 A → B | 10,000요청 A → B |
| --- | ---: | ---: |
| 성분 저장 profiler의 COMMIT 횟수 | 387 → 26 | 100 → 10 |
| 전체 refresh의 명시적 BEGIN IMMEDIATE 거래 수 | 388 → 27 | 101 → 11 |
| 명시적 거래의 BEGIN 호출 직전~COMMIT 반환 누적 ms | 410.063 → 174.971 | 510.386 → 433.157 |
| 매 표본의 최대 거래 유지 시간 중앙값 ms | 5.894 → 12.608 | 10.303 → 48.428 |
| 모든 표본에서 관측한 최대 거래 유지 시간 ms | 6.326 → 13.706 | 10.956 → 52.828 |

거래 유지 시간은 BEGIN 반환 후부터 COMMIT 반환까지다. BEGIN 호출 시간은 잠금 획득을 포함해 별도 보존했고, 경쟁 writer를 주입하지 않았다. 묶음 저장으로 누적 비용은 줄지만 한 번에 writer 잠금을 유지하는 시간과 취소 확인 간격은 길어진다. 16성분·1,000요청 제한은 성분을 쪼개지 않는 상한이며 시간 상한은 아니다. 큰 단일 성분은 기존 단일 저장 경로다.

명시적 거래 집계에는 성분 저장 밖의 스캔 마무리도 포함된다. 자동 커밋 SQL·유지보수 내부 transaction을 전량 추적한 수치가 아니다. `storage.replace`는 성분 저장 함수 전체이며 명시적 거래 타이머와 범위가 다르다. 각 지표의 중앙값을 더하거나 차감해 다른 구간 시간을 만들지 않는다.

## 4. 원인과 선택

- **판정**: COMMIT 횟수 축소 가정은 성립했다. 최초 저장의 큰 개선이 전체 refresh에서는 6.91%·9.98%가 된 것은 파일 탐색·파싱·집계 등 다른 구간이 남기 때문이다.
- **구현**: [MemoryStore](../../../src/summary/db/memoryStore.ts)의 각 apply를 입력 순서대로 실행한다. 성분 DTO를 합쳐 보존 범위를 넓히지 않는다. [scanner persistence](../../../src/summary/scanner/refresh/persistence.ts)는 정상 성분만 모으고 단일·1,000요청 초과·deferred·오류·orphan·삭제·재연결 앞에서 flush한다.
- **실패·취소**: 성공 COMMIT 뒤에만 settled·affected를 반영한다. 실패 시 전체 rollback 후 기존 성분별 저장을 재시도한다. scanner DTO의 모델·도구는 배열이므로 재시도할 수 있다. Worker 양보와 취소 확인은 transaction 사이에 두며 writer 잠금을 잡고 await하지 않는다.
- **선택**: B를 채택했다. 정상 묶음 전체가 새 미확정·강제 종료 단위가 되는 변화와 거래당 유지 시간 증가를 수용한다. 실패 성분 격리·삭제 보존·이동·평균 의미는 검증했고 WAL·synchronous=2는 유지했다. 스키마 전환과 인덱스 구축 비용은 생기지 않는다.

[SQLite FAQ 19](https://www.sqlite.org/faq.html#q19)는 여러 쓰기를 transaction에 묶어 COMMIT 비용을 분담하는 원리를 설명한다. [SQLite synchronous 문서](https://www.sqlite.org/pragma.html#pragma_synchronous)는 WAL/FULL에서 각 COMMIT 뒤 추가 동기화를 설명한다. 이번에는 동기화 설정을 낮추지 않고 COMMIT 호출 수를 줄였다. 실제 xSync 호출 수나 누적 디스크 쓰기 byte는 계측하지 않았다. 평균의 합계·분모와 PK·인덱스에 대한 선행 근거는 [SQL 조사](../../research/2026-11-09/SqlAggregationReferences-2026-11-09.md)를 참고한다.

## 5. 측정 조건과 정확성

- Windows 10.0.19045, AMD Ryzen 5 7500F·논리 12 CPU, Node v24.14.1, SQLite 3.51.2. 양쪽 모두 WAL, synchronous=2, wal_autocheckpoint=1000, cache_size=-4096 KiB, temp_store=FILE, mmap_size=0이다.
- 현재 입력은 원본과 분리해 고정한 655파일, 1,341요청·372세션·30프로젝트다. 제공자는 Claude 29요청·Codex 1,312요청이다. 합성은 고정 ordinal 생성 규칙으로 100파일·100세션·10프로젝트·10,000요청이며 제공자별 5,000요청이다. 시각은 2026-07-01 + 세션순번%14일 + 요청순번×3초다. 사용자 지정 두 규모를 실행했다.
- 매 variant·표본은 새 process·새 DB에서 같은 고정 입력으로 최초 구축한 뒤 같은 기존 Codex 세션에 요청 1건을 추가한다. 현재 대상 세션은 41요청·28원본, 합성은 100요청·1원본이다. 추가 후 요청 +1, 토큰 +130을 검증한다. 데이터 준비·원본 복원·DB 열기·migration·빈 rollup 활성화·검증·조회는 refresh 타이머 밖이다. 원본과 설치 DB는 변경하지 않았다.
- OS 캐시는 강제 제어하지 않았고 준비 실행 뒤 warm 상태를 측정했다. GC 강제 실행은 없었다. 실제 scanner·기존 StageProfiler와 양쪽 동일한 가벼운 exec·읽기 wrapper를 사용하며 계측 overhead는 별도 보정하지 않았다. 원본 읽기·논리 순서·Worker 설정은 동일하다.
- 조회는 Asia/Seoul의 **2026-01-01 이상, 2027-01-01 미만**, unknownTime=include, excludeEmptyUsage=true, 비용 제외다. 일·월·세션·프로젝트 × 제공자·모델의 모든 페이지와 전체 그룹 개수 반환까지 측정했다. 합계는 모든 상태, 토큰 평균은 기록된 완료 표본, duration은 알려진 완료 duration 건수를 분모로 한다.
- 모든 3준비쌍·10본쌍에서 A/B 요청·토큰·정규화 facts·manifest·결과 건수·그룹별 평균, raw/rollup, FK/integrity, 원본 사본 복원이 일치했다. 타이머 밖 JS reducer로 제공자·모델과 빈 요청 포함/제외를 대조했다. 기대값은 정규화된 facts 기준이며 실제 JSONL 파서 전체의 독립 oracle은 아니다.
- 별도 [정확성 검증 JSON](TransactionBatchValidation-2026-11-10.json)은 독립 집계 160건, 프로젝트·날짜 이동·삭제·시간대 재구축, 별도 reader의 중간 결과 미노출, 실패 후 전 영속 table 복구·동일 DTO 재시도, 16/1,000/큰 단일 경계, 오류·삭제·재연결·Skill 보존, 배치·개별 재시도 중 취소를 검증한다. 실제 refreshSummary의 중간 성분 DB 오류에서도 앞뒤 성분 성공과 실패 manifest 진단을 확인했다.
- TypeScript 컴파일, `npm run typecheck`, `npm run lint`, `git diff --check`를 통과했다. 일반 자동 테스트 suite·UI·실계정 quota·프로세스 강제 종료·전원 손실·heap 피크·경쟁 writer 지연은 실행하지 않았다.

## 6. 원시 자료와 재실행

[A/B 원시 표본·식별자 JSON](TransactionBatchAB-2026-11-10.json), [정확성 JSON](TransactionBatchValidation-2026-11-10.json), [A/B 소스·빌드·실행기 ZIP](TransactionBatchAB-sources-2026-11-10.zip), [ZIP SHA와 파일별 SHA](TransactionBatchAB-sources-2026-11-10.json)을 보존한다. ZIP에는 비공개 대화 입력·DB가 없다. 현재 입력 사본은 Git에서 제외한 로컬 workspace에만 남긴다. ZIP의 A/B 폴더를 기존 저장소의 로컬 작업 경로에 복원하고 같은 입력 사본을 사용할 수 있다.

```powershell
node --no-warnings tests/benchmarks/transaction-stages-ab.cjs --workspace=tests/results/benchmarks/transaction-ab-20261110 --before=tests/results/benchmarks/transaction-ab-20261110/A --after=tests/results/benchmarks/transaction-ab-20261110/B --output=tests/results/benchmarks/transaction-ab-20261110/repeat.json --pairs=10 --warmups=3
node --no-warnings tests/benchmarks/transaction-batch-validation.cjs --before=tests/results/benchmarks/transaction-ab-20261110/A --after=tests/results/benchmarks/transaction-ab-20261110/B --output=tests/results/benchmarks/transaction-ab-20261110/repeat-validation.json
```

출력 경로가 이미 있으면 덮어쓰지 않는다. 기준 revision은 `3581ca1adc5c71ee4651744ab49b56793ae0b895`이며 미커밋 B의 소스·빌드와 입력·실행기 hash는 원시 JSON에 있다. 제품 TypeScript 변경은 DB 진입점·MemoryStore·scanner persistence 세 파일이다.
