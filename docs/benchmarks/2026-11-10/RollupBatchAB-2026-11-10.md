# 저장 묶음의 최종 facts 일괄 rollup A/B

2026-11-10, Asia/Seoul. 사용자는 변경 세션의 rollup을 저장 묶음의 마지막에 한 번 수행하고 개선량을 측정하도록 요청했다. A는 정상 성분 묶음 저장이 적용된 `8f74434`, B는 같은 거래의 마지막에 변경 세션을 중복 제거해 일괄 rollup하는 구현이다. 제품 변경은 `memoryStore.ts`와 `rollups.ts` 두 파일이며 B를 채택했다.

가정: 세션마다 반복하는 rollup 준비·메타데이터 확인·DELETE·INSERT SELECT를 줄이면 여러 세션의 저장 비용이 감소한다. 기존 성분별 facts 저장과 COMMIT 경계는 유지하고 각 daily 표를 묶음당 한 번 삭제·재집계한다.

## 1. 결과

준비 3쌍을 제외한 A→B/B→A 교대 10쌍의 중앙값 ms다. 개선율은 `(A - B) / A × 100`이며 양수는 시간 감소다. 현재 데이터와 10,000요청의 이전 비교 범위를 이어 사용했다.

| 항목 | 현재 1,346요청 A → B (개선율) | 10,000요청 A → B (개선율) |
| --- | ---: | ---: |
| 최초 수집 rollup 유지 전체 | 70.517 → 26.265 (+62.75%) | 138.276 → 101.313 (+26.73%) |
| 최초 수집 요청 daily INSERT SELECT | 34.380 → 11.894 (+65.41%) | 68.569 → 49.498 (+27.81%) |
| 최초 수집 모델 daily INSERT SELECT | 32.003 → 12.784 (+60.05%) | 67.925 → 50.373 (+25.84%) |
| 최초 수집 DB 저장·COMMIT 전체 | 177.331 → 126.711 (+28.55%) | 434.669 → 395.726 (+8.96%) |
| 최초 수집 전체 refresh | 3,102.307 → 3,039.996 (+2.01%) | 729.087 → 700.286 (+3.95%) |
| 요청 1건 추가 DB 저장·COMMIT 전체 | 3.963 → 4.992 (-25.96%) | 5.565 → 4.845 (+12.94%) |
| 요청 1건 추가 전체 refresh | 400.914 → 403.062 (-0.54%) | 24.719 → 22.917 (+7.29%) |
| 변경 없는 전체 refresh | 109.142 → 111.133 (-1.82%) | 18.559 → 18.731 (-0.93%) |

최초 rollup과 전체 refresh는 두 규모 모두 B가 10/10쌍 빨랐다. 최초 저장 전체는 현재 10/10쌍·10,000요청 9/10쌍에서 B가 빨랐다. 입력을 고정한 같은 실행의 A/B 비교이며 이전 COMMIT 배칭 실험과 입력·기준 구현이 달라 이전 개선율에 곱하거나 더하지 않는다.

1건 추가는 A/B 모두 기존 단일 세션 경로와 같은 SQL 호출 수를 사용했다. 전체 refresh의 B 우세는 현재 4/10쌍·10,000요청 6/10쌍이다. 성분 저장의 COMMIT 중앙값도 현재 0.874→2.126ms, 합성 1.781→0.680ms로 방향이 달랐으며, 일관된 추가 성능 개선은 확인하지 못했다. 변경 없는 갱신은 양쪽 모두 본문 읽기·성분 저장 0회였고 위의 작은 악화도 함께 기록한다.

추가 후 평균 토큰 조회는 아래와 같다. 비용을 제외한 동일한 rollup 조회 SQL에서 모든 페이지·전체 그룹 개수 반환까지 측정했다. 조회 SQL은 변경하지 않았으므로 작은 차이를 일반적인 조회 성능 개선으로 판정하지 않는다.

| 평균 조회 | 현재 A → B ms | 10,000요청 A → B ms |
| --- | ---: | ---: |
| 일별·제공자 | 2.100 → 2.099 | 0.913 → 0.943 |
| 월별·제공자 | 1.556 → 1.548 | 0.786 → 0.787 |
| 세션별·제공자 | 3.380 → 3.307 | 1.185 → 1.193 |
| 프로젝트별·제공자 | 1.549 → 1.528 | 0.741 → 0.748 |
| 일별·모델 | 2.283 → 2.222 | 1.207 → 1.221 |
| 월별·모델 | 1.769 → 1.798 | 1.113 → 1.101 |
| 세션별·모델 | 4.050 → 3.986 | 2.068 → 2.090 |
| 프로젝트별·모델 | 1.929 → 1.825 | 1.106 → 1.118 |

## 2. 원인과 적용 방식

| 최초 수집 호출 수 | 현재 A → B | 10,000요청 A → B |
| --- | ---: | ---: |
| 성분 저장 transaction·COMMIT | 26 → 26 | 10 → 10 |
| rollup 상위 계측 | 387 → 26 | 100 → 10 |
| 요청 daily DELETE·INSERT 각각 | 372 → 25 | 100 → 10 |
| 모델 daily DELETE·INSERT 각각 | 372 → 25 | 100 → 10 |

현재 데이터의 상위 rollup 계측에는 변경 요청이 없는 성분의 호출도 포함되어 실제 SQL 횟수와 다르다. 실제 SQL 네 종류를 합친 호출 수는 현재 1,488→100회, 합성 400→40회다. 매 표본의 가장 긴 명시적 거래 유지 시간 중앙값은 현재 12.692→9.662ms, 합성 47.717→46.041ms였다. 유지 시간은 BEGIN 반환부터 COMMIT 반환까지이며 경쟁 writer 지연은 측정하지 않았다.

`MemoryStore.replaceBatch()`는 각 snapshot의 facts·manifest·삭제 보존·이름 정리를 기존 순서로 수행한다. 실제로 바뀐 세션의 `(provider, session_id)` JSON tuple 키만 Map에 모아 중복 제거하고, COMMIT 직전에 최종 저장된 facts를 집계한다. 변경 세션 0개는 rollup을 생략하고 1개는 기존 직접 세션 경로를 사용한다. 전체 스캔 종료까지 지연하지 않으며 기존 최대 16성분·1,000요청 묶음 경계도 같다.

복수 세션 목록은 JSON 한 개로 바인딩해 SQL·statement cache 항목 수를 고정한다. daily 삭제와 원본 선택의 식은 다음과 같다. 값은 모두 바인딩하며 세션 ID를 SQL 문자열에 삽입하지 않는다.

```sql
-- daily DELETE의 세션 PK 범위
WHERE (provider, session_id) IN (
  SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]')
  FROM json_each(?)
)

-- INSERT SELECT가 집계할 최종 facts의 ID 범위
WHERE id IN (
  SELECT selected.id
  FROM json_each(?) AS changed
  CROSS JOIN turn_summary AS selected
  WHERE selected.provider = json_extract(changed.value, '$[0]')
    AND selected.session_id = json_extract(changed.value, '$[1]')
)
```

별도 [실행계획 진단](RollupBatchPlans-2026-11-10.json)은 본 측정이 끝난 각 규모의 trial-0 DB 사본에서 1·2·16세션을 선택해 실제 제품 메서드의 SQL을 기록했다. 추가 후 DB여서 요청 수는 현재 1,347건·합성 10,001건이다. 모든 변경은 ROLLBACK했고 timing 표본에 섞지 않았다. 세션 ID·바인딩 값은 공개하지 않고 tuple 수·payload hash·SQL·계획만 남긴다.

- DELETE: `SEARCH ... USING PRIMARY KEY (provider=? AND session_id=?)`.
- INSERT: JSON 키 목록 → 기존 요청 UNIQUE의 `USING COVERING INDEX ... (provider=? AND session_id=?)` → `SEARCH t USING INTEGER PRIMARY KEY (rowid=?)`.
- 16세션 갱신은 A의 64문장에서 B의 4문장으로 줄었다. 1세션은 둘 다 4문장으로 같다. JSON 목록 순회는 남지만 전체 facts SCAN은 나타나지 않았다. GROUP BY 임시 B-tree와 모델 탐색은 남는다.

따라서 줄어든 것은 SQL·준비·반복 확인 비용이다. 같은 최종 요청들을 집계하는 계산은 남는다. 현재는 세션당 평균 약 3.6요청, 합성은 100요청이므로 합성에서 원본 합산 비용의 비중이 더 큰 설명과 관측 결과가 부합한다. 이 비중의 원인별 분리는 별도 실험하지 않았다. 요청 비교·저장, 평균의 합계·분모, 캐시 NULL, PK·인덱스·스키마·COMMIT 횟수·WAL/FULL은 유지했다. 새 migration·인덱스 구축 비용은 없다.

[SQLite row-value IN](https://www.sqlite.org/rowvalue.html#row_value_in_operators)과 [JSON table-valued functions](https://www.sqlite.org/json1.html#jeach)은 tuple 목록 전달의 문법 근거다. [SQLite optimizer](https://www.sqlite.org/optoverview.html#where_clause_analysis)는 복합 키의 왼쪽 동등 조건 탐색 원리를 설명한다. 실제 채택 판단에는 위의 제품 실행계획과 A/B 표본을 사용했다.

## 3. 정확성·측정 조건

- Windows 10.0.19045, AMD Ryzen 5 7500F·논리 12 CPU, Node v24.14.1, SQLite 3.51.2. 양쪽 WAL, synchronous=2, wal_autocheckpoint=1000, cache_size=-4096 KiB, temp_store=FILE, mmap_size=0이다.
- 원본과 분리한 새 현재 snapshot은 655파일·1,346요청·372세션·30프로젝트, Claude 29요청·Codex 1,317요청이다. 합성은 고정 ordinal 규칙의 100파일·100세션·10프로젝트·10,000요청, 제공자별 5,000요청이다. 시각은 2026-07-01 + 세션순번%14일 + 요청순번×3초이며 원시 JSON에 입력 SHA와 실제 분포를 남긴다. 원본 로그와 설치 DB는 변경하지 않았다.
- 매 A/B variant·표본은 새 process·새 DB에서 같은 최초 구축 뒤 동일한 기존 Codex 세션에 실제 요청 1건을 추가한다. 사전 상태는 최초 구축으로 복원하고 추가 후 요청 +1·토큰 +130을 확인한다. DB 열기·migration·빈 rollup 활성화·복사·append·검증·조회·원본 사본 복원은 refresh 타이머 밖이다. 초기 구축 시간은 표에 별도 제시했다.
- 같은 scanner·파일 Worker 설정·StageProfiler·가벼운 exec 및 읽기 wrapper를 사용했다. OS 캐시는 제어하지 않았고 준비 실행 뒤 warm 상태다. 강제 GC와 계측 overhead 보정은 하지 않았다. 상위 rollup과 하위 DELETE·INSERT 계측은 중첩되므로 더하지 않는다. 지표별 중앙값의 합·차를 다른 구간 시간으로 해석하지 않는다.
- 조회는 Asia/Seoul의 2026-01-01 이상·2027-01-01 미만, unknownTime=include, excludeEmptyUsage=true, 비용 제외다. 총량은 모든 상태, 토큰 평균은 기록된 완료 요청, duration 평균은 알려진 완료 duration 건수가 분모다. 타이머 밖에서 빈 요청 포함/제외와 제공자·모델별 JS facts reducer도 대조했다.
- 모든 준비 3쌍·본 10쌍에서 요청·토큰 합계, 정규화 facts·manifest·그룹별 평균·결과 개수·raw/rollup·FK/integrity·원본 읽기 순서·추가량·사본 복원이 일치했다. 기대값은 정규화 facts 기준으로 계산했고 실제 JSONL 파서 전체의 독립 oracle은 아니다.
- [rollup 직접 검증](RollupBatchValidation-2026-11-10.json)은 같은 세션의 반복 snapshot·최종 삭제·프로젝트/날짜 이동·보존, 0변경·단일 경로, 제공자 간 동명 세션과 구분자·따옴표 포함 키, NULL 시각·다중 모델·캐시 NULL·평균 독립 40건을 확인했다. model daily INSERT 실패 시 전 영속 상태의 정확한 rollback과 별도 reader의 중간 결과 미노출, 실제 scanner의 성분별 fallback도 통과했다.
- [기존 transaction 직접 검증](RollupBatchTransactionValidation-2026-11-10.json)도 B에서 재실행해 독립 지표 160건, 16성분/1,000요청/큰 단일 경계, 실패 격리·취소·삭제 보존·재연결을 확인했다. 일반 자동 테스트 suite는 실행하지 않았다.
- metadata 부재·형식 불일치·시간대 변경·최종 미지원 시각을 검증했다. 중간 snapshot에만 미지원 시각이 있고 최종 facts가 유효하면 A는 중간 캐시를 폐기하고 B는 유효한 최종 캐시를 유지하는 차이가 있다. 공개 조회 뒤 A의 lazy rebuild 결과와 B가 일치했다. 이는 최종 facts 기준 집계라는 의도된 차이다.
- TypeScript 컴파일, `npm run typecheck`, `npm run lint`, `git diff --check`를 통과했다. 프로세스 강제 종료·전원 손실·경쟁 writer·UI·실계정 quota·heap 피크는 측정하지 않았다.

## 4. 보존·재실행

[A/B JSON](RollupBatchAB-2026-11-10.json), [실행계획 JSON](RollupBatchPlans-2026-11-10.json), [rollup 검증 JSON](RollupBatchValidation-2026-11-10.json), [transaction 검증 JSON](RollupBatchTransactionValidation-2026-11-10.json), [A/B 소스·빌드·실행기 ZIP](RollupBatchAB-sources-2026-11-10.zip), [ZIP·파일별 SHA](RollupBatchAB-sources-2026-11-10.json)을 보존한다. ZIP에는 비공개 로그·DB가 없고 현재 입력 사본은 Git 제외 로컬 workspace에만 남긴다. 기준 revision은 `8f74434e1c4d7a2200a85e8e3be8e508bb2b0e42`이며 A/B 소스·빌드·실행기·입력 SHA는 원시 JSON에 있다.

```powershell
node --no-warnings tests/benchmarks/rollup-batch-ab.cjs --workspace=tests/results/benchmarks/rollup-batch-ab-20261110 --before=tests/results/benchmarks/rollup-batch-ab-20261110/A --after=tests/results/benchmarks/rollup-batch-ab-20261110/B --output=tests/results/benchmarks/rollup-batch-ab-20261110/repeat.json --pairs=10 --warmups=3
node --no-warnings tests/benchmarks/rollup-batch-validation.cjs --before=tests/results/benchmarks/rollup-batch-ab-20261110/A --after=tests/results/benchmarks/rollup-batch-ab-20261110/B --output=tests/results/benchmarks/rollup-batch-ab-20261110/repeat-validation.json
node --no-warnings tests/benchmarks/rollup-batch-plan.cjs --before=tests/results/benchmarks/rollup-batch-ab-20261110/A --after=tests/results/benchmarks/rollup-batch-ab-20261110/B --report=tests/results/benchmarks/rollup-batch-ab-20261110/repeat.json --output=tests/results/benchmarks/rollup-batch-ab-20261110/repeat-plans.json
```

기존 출력은 덮어쓰지 않는다. `rollup-batch-ab.cjs`는 공용 `transaction-stages-ab.cjs`의 main을 재사용하고 단계별 시간과 실제 호출 횟수를 보존한다. 기존 transaction CLI는 같은 인자로 실행할 수 있으며 과거 원시 결과·ZIP은 변경하지 않았다.
