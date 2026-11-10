# 최종 이름·결제 설정의 저장 묶음별 중복 제거

2026-11-10, Asia/Seoul. 기준은 `4956423`이며 사용자에게 승인받은 범위는 최종 결과의 프로젝트·세션 이름을 키별 한 번 UPSERT하고 세션 결제 설정도 한 번 조회하는 변경이다. 현재 데이터·10,000요청의 1회 A/B는 메인 담당자가 수행한다.

## 후보와 선택

| ID | 상태 | 변경 | 검증 계획 |
| --- | --- | --- | --- |
| META-01 | 적용 완료 | 최종 요청을 한 번 색인하고 이름·결제 override를 저장 묶음의 고유 키로 축약 | 호출 수·최종 이름·FK·빈 이름·제공자 분리·요청별 billing fallback 회귀검증 추가 |
| META-02 | 적용 완료 | 성공한 COMMIT에서 반영한 세션명을 반환해 `finishScan`의 동일 이름 UPDATE 제외 | 변경 없는 세션 이름 갱신·실패 후 재시도·rollback 회귀검증 추가 |
| META-03 | 유지 | 반복 세션 snapshot·삭제·재연결의 직접 batch API는 snapshot별 처리 | 중간 삭제의 billing cascade와 재삽입 호환 |

## 변경 전후와 계약

- [MemoryStore](../../../src/summary/db/memoryStore.ts)는 요청마다 같은 프로젝트·세션 UPSERT와 `session_billing` SELECT를 반복한다. 정상 묶음은 입력을 한 번 준비하고, 실제 저장 대상에서 마지막 프로젝트 이름·마지막 비어 있지 않은 세션 이름을 모아 FK 부모 행을 먼저 저장한다. override 조회 결과가 없으면 `summary.billing`은 요청별로 적용한다.
- 정상 독립 성분 묶음에서는 각 성분의 중간 `pruneNames`를 마지막으로 이동해 먼저 생성한 미래 참조의 이름이 삭제되지 않게 한다. 같은 세션을 반복 교체하거나 삭제·재연결을 포함하는 직접 API는 기존 snapshot 순서의 삭제·재삽입·결제 선택 소실 의미를 보존하는 호환 경로를 사용한다. 해당 경로도 각 snapshot 안에서는 키별로 한 번 저장한다.
- 삭제 보존으로 제외되는 요청은 이름·결제 계획에서도 제외한다. request/model/Skill iterable은 다시 소비하지 않고 기존 요청·평균·NULL·rollup과 COMMIT/실패 격리 경계를 유지한다.
- [finishScan](../../../src/summary/scanner/refresh/persistence.ts)은 이름만 바뀐 Codex 세션도 갱신해야 하므로 유지한다. 성공적으로 저장한 최종 nonempty 이름과 같을 때만 후단 UPDATE를 생략하고, 실패·rollback된 이름 기록은 스캔 상태에 반영하지 않는다.
- 입력 요청 N, 고유 프로젝트 P·세션 S일 때 이름 UPSERT는 정상 batch에서 요청별 O(N) SQL 호출에서 O(P+S), override SELECT는 O(N)에서 O(S)로 줄인다. 전체 요청 처리의 시간 차수는 O(N)이며 최종 계획·이름·override에 O(N+P+S) 참조/보조 상태가 필요하다. 메모리 계획은 한 transaction에만 유지한다. 실제 시간 효과는 아직 미측정이다.

## 검증과 결과

- `MemoryStore.replace/replaceBatch`는 COMMIT 성공 뒤에만 적용한 nonempty 세션명 Map을 반환한다. scanner는 이 결과를 스캔 상태에 병합하고 마무리 이름과 정확히 같을 때만 UPDATE를 생략한다. 삭제된 세션명은 반환 Map에서 지운다.
- 새 `metadata` 계측은 계획 수집·고유 이름 UPSERT·billing override 조회를 포함한다. 기존 `summaries`에서 옮겨진 비용을 전체 저장 및 새 계측과 함께 해석해야 한다. 단일 snapshot의 세션별 rollup SQL 경로와 복수 snapshot의 일괄 rollup 경로는 유지했다.
- [이름 테스트](../../../tests/node/names.test.ts)에 정상 묶음의 키별 SQL 호출 수·FK 선행 저장·summary iterable 단일 소비·요청별 billing fallback·사용자 override·빈 이름 보존·rollback/재시도·반복 snapshot cascade·삭제 보존·metadata-only rename·실패 성분의 후단 이름 갱신 검증을 추가했다.
- `npm run check`의 타입 검사·린트가 통과했고 427개 중 421개 테스트가 통과했다. 추가한 이름·설정 경계 7개는 통과했으며 나머지 6개 실패는 정리 전 A에서도 동일하게 재현했다. 삭제 보존 fixture는 accepted manifest의 세션 귀속을 지정해 실제 보존 대상인 요청을 검증하도록 고쳤다. transaction 직접 검증의 독립 집계 160건·rollback/retry·실패 격리·취소·삭제 보존·재연결도 통과했다. 최신 benchmark 린트와 diff 검사도 통과했다.
- 현재 805요청·합성 10,000요청의 각 1회 A/B에서 이름 UPSERT 두 종류와 결제 설정 SELECT 합계는 2,415→410회·30,000→250회다. 최초 DB 저장은 169.184→165.601ms·1,111.814→1,020.088ms였다. 실데이터 전체 갱신과 합성 단일 추가는 느려졌으므로 안정적인 개선율로 일반화하지 않는다. [시간·호출 수·정확성·한계](../../benchmarks/2026-11-10/MetadataBatchAB-2026-11-10.md).
