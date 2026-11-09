# 스캔·DTO·SQL 저장 구간 계측과 개선 방향

2026-11-09, Asia/Seoul. 사용자 요청에 따라 서브에이전트 3명이 스캔·DTO 수명·SQL 집계를 조사했고, 메인 에이전트는 제품 갱신 API에 시간 계측과 좁은 범위의 재저장 생략을 적용했다. [원시 측정 JSON](ScanStorageProfile-2026-11-09.json).

## 1. 실데이터 측정 결과

Windows, Node v24.14.1, SQLite 3.51.2에서 로컬 Claude projects·Codex sessions를 제품 `refreshSummary()`로 읽었다. 원본과 설치 확장의 DB는 변경하지 않고 OS 임시 디렉터리의 별도 신규 DB에 저장했다. Skill 수집·삭제 원본 보존 ON, 시간대 Asia/Seoul이다. 빈 DB에서 일별 조회로 rollup을 먼저 활성화해 최초 저장에도 rollup 갱신 비용이 포함되게 했다. DB 열기·마이그레이션·최초 빈 rollup 활성화·닫기는 refresh 시간 밖이다.

629파일(Claude 21, Codex 608), 485,397,497byte를 읽어 1,268요청을 저장했고 실패·중단은 없었다. 요청 daily 386행, 모델 daily 409행이다. live 원본을 사용했으며 고정 사본이나 OS 캐시 제어, 반복 준비 실행은 하지 않았다. 최초 수집·연속 재스캔을 각각 한 번 수행한 운영 프로파일이며 A/B·회귀 테스트나 통계적 중앙값이 아니다.

| 구간 | 최초 수집 ms | 변경 없는 재스캔 ms |
| --- | ---: | ---: |
| 전체 refresh | 8,018.44 | 124.52 |
| 갱신 잠금 획득 | 2.07 | 1.19 |
| 파일 탐색·stat·manifest 비교 | 115.11 | 112.18 |
| 표시 이름 읽기 | 8.40 | 6.77 |
| 변경 원본 처리 | 7,206.05 | 0.09 |
| 관련 원본 확장 | 2.22 | 0.46 |
| 부모 요청 확정 | 0.50 | 0.03 |
| 이동 원본 연결 | 9.51 | 0.04 |
| 최종 winner·요청 집계 | 129.61 | 0.09 |
| 성분별 저장 조율 전체 | 540.71 | 0.003 |
| 스캔 마무리·관측 기록 | 2.19 | 3.21 |
| optimize 호출 | 1.26 | 0.006 |
| 실제 readSource 629회, 위 원본 처리의 하위 구간 | 7,200.88 | 실행 없음 |

재스캔은 629파일을 재사용하고 본문 0byte, 파싱 0건, `replaceMemory` 0회였다. 새 profiler는 단계별 고정 키만 가지며 파일 수만큼 타이밍 객체를 만들지 않는다.

### SQL 일괄 저장 내부

현재 저장은 연결 성분별 트랜잭션에서 prepared statement를 반복 실행한다. 한 번의 다중 VALUES INSERT나 한 번의 전역 COMMIT이 아니다. 최초 수집의 `replaceMemory`는 372회였다.

| 저장 구간 | 호출 수 | 누적 ms |
| --- | ---: | ---: |
| 트랜잭션 포함 replace 전체 | 372 | 380.69 |
| BEGIN IMMEDIATE | 372 | 3.61 |
| 삭제·재연결·보존 대상 준비 | 372 | 3.21 |
| manifest 반영 | 372 | 10.32 |
| 요청 입력 색인 | 372 | 1.21 |
| 사라진 요청 삭제 조사 | 372 | 1.07 |
| 요청 비교·쓰기 전체 | 372 | 51.11 |
| └ 기존 값 비교·입력 변환·이름 UPSERT | 1,268 | 12.93 |
| └ facts·모델·Skill·비용 쓰기 전체 | 1,268 | 36.91 |
| 　 facts INSERT/UPDATE | 1,268 | 15.38 |
| 　 모델 교체 | 1,268 | 5.35 |
| 　 Skill 교체 | 1,268 | 8.27 |
| 　 비용 저장 | 1,268 | 6.94 |
| 진단 재연결 | 372 | 0.19 |
| 원본 삭제 처리 | 372 | 0.16 |
| 변경 세션 rollup 유지 전체 | 372 | 75.11 |
| └ provider daily DELETE | 357 | 0.94 |
| └ provider daily INSERT SELECT·재집계 | 357 | 36.79 |
| └ model daily DELETE | 357 | 0.91 |
| └ model daily INSERT SELECT·재집계 | 357 | 32.79 |
| 이름 정리 | 372 | 2.44 |
| COMMIT | 372 | 230.97 |

상위·하위 타이머는 중첩되므로 행을 모두 더하면 안 된다. 성분별 저장 조율에는 전체 멤버·summary 검색, 입력 DTO 생성, Worker 양보 등이 있어 `replace` 시간보다 크다. `readSource`에는 파일 I/O·UTF-8/JSON 처리·SHA-256·parser·원본별 winner 갱신이 함께 포함된다. 순수 디스크 시간이나 JSON.parse 단독 시간으로 해석하지 않는다. 각 SQL 타이머에도 JS 함수·statement 준비·바인딩이 포함된다. COMMIT 시간은 WAL commit·동기화·가능한 checkpoint/OS 대기를 포함할 수 있으며 순수 fsync만 측정한 값이 아니다.

이 실행에서 읽기·파싱은 전체의 약 89.8%, COMMIT은 replace 시간의 약 60.7%, rollup 유지 전체는 약 19.7%였다. **최초 수집의 우선 비용은 원본 처리이며, 저장 내부에서는 COMMIT이 rollup보다 컸다.** 한 요청 추가·큰 세션 변경·동시 쓰기 경쟁은 이번 측정에 없으므로 그 상황까지 병목 순위를 일반화하지 않는다. 성분을 하나의 큰 transaction으로 합치면 기존 실패·취소 경계와 충돌하므로 바로 변경하지 않았다.

### 평균·합계 조회

위 저장 뒤 비용 미포함 rollup 조회로 표 한 페이지와 전체 그룹 개수를 함께 읽었다. 각 조회는 1회이고 `limit=100`이다.

| 묶음 | ms | 반환 행 / 전체 그룹 |
| --- | ---: | ---: |
| 일 | 2.37 | 88 / 88 |
| 월 | 0.96 | 8 / 8 |
| 세션 | 2.02 | 100 / 357 |
| 프로젝트 | 0.89 | 33 / 33 |

이 값에는 평균·총합 등의 기존 결과 생성이 포함되지만 원본 SQL과의 속도·정확성 비교는 수행하지 않았다.

## 2. 이번에 적용한 동작

- `RefreshResult.timings`에 전체 ms와 `scan`·`storage`의 `{ calls, totalMs }`를 반환한다. 기존 Worker diagnostics의 `lastRefresh.timings`로도 조회할 수 있다. 영속 DB나 파일별 로그에는 타이밍을 추가 저장하지 않는다. 타이밍 키는 고정 문자열이며 원본 경로·본문·인증 정보를 넣지 않는다.
- 변경 없는 `session=null` 파일은 `finishScan`에서 저장용 DTO를 만들거나 manifest UPSERT를 반복하지 않는다. 이번에 실제 읽었고 오류가 없는 미귀속 원본만 해당 경로로 저장한다. 관련 원본으로 실제 읽은 파일은 정상 저장 대상이다.
- `finalFile`은 저장에 필요한 `FileMetadata`와 ID만 명시적으로 복사한다. `prepared` winner와 `previous` manifest를 저장 입력 객체에 섞지 않는다.

기존 정상 facts·manifest를 지우지 않고 관측 `last_seen_scan_id` 갱신은 유지한다. 현재 코드에는 별도의 DTO snapshot/cache 파일이 없고 무거운 사용량 DTO는 이미 실제 읽기에서만 생성한다. 스캔 횟수만큼 인스턴스가 영구 누적되는 누수는 이번에 입증하지 않았다. live heap·GC·DTO allocation 수는 측정하지 않았다.

실패하는 측정 콜백도 부모 단계 시간에는 포함된다. 다만 입력 준비와 요청 비교처럼 완료 직후 `record()`하는 세부 단계는 중간 예외 시 누락될 수 있고, 필드가 없으면 실행하지 않았거나 그 세부 단계가 완료되지 않았다는 뜻이다. 실패한 transaction의 타이밍은 rollback되어도 누적되므로 성공 처리량으로 해석하지 않는다. `storage`는 `replaceMemory` 경로이며 마무리 관측 transaction은 `scan.finishScan`, 별도 오류 진단 저장은 해당 바깥 단계/전체 시간에 포함된다. 최초 query에서 발생하는 lazy rollup 전체 rebuild도 refresh 밖이다.

## 3. 다음 알고리즘 설계와 공식 근거

1. **스캔:** session/thread/source identity 역인덱스와 중복 방문을 막는 작업 큐로 관련 원본의 반복 전체 검색·정렬을 줄인다. 그다음 metadata 조회에 작은 동시성 상한을 적용하고, 필요하면 watcher 변경 집합과 전체 재조정을 결합한다. [스캔 조사](ScanAlgorithms-2026-11-09.md), [Watchman since query](https://facebook.github.io/watchman/docs/cmd/query), [Node.js backpressure](https://nodejs.org/learn/modules/backpressuring-in-streams).
2. **DTO:** 작은 파일 목록과 실제 처리 workset을 분리하고 관계 확정 뒤 성분별 aggregate·저장·참조 해제를 한다. 본문을 읽어야 관계를 아는 현재 구조에서는 이 방식만으로 준비 단계 전체의 메모리를 최대 성분 크기로 제한할 수는 없다. append offset만 저장하면 parser 문맥·원본별 winner를 복원할 수 없으므로 checkpoint는 별도 구조 변경이다. [DTO 수명 설계](DtoLifetimePlan-2026-11-09.md).
3. **SQL:** 평균은 이미 SUM/COUNT 상태를 병합한다. 작은 범위의 열 중복 제거보다 우선 검토할 후보는 변경 전·후 날짜/프로젝트/모델 버킷만 재집계하는 방식이다. daily 표의 복합 PK `WITHOUT ROWID` clustering도 이미 적용되어 있다. 모든 지표를 담은 covering index는 쓰기·공간을 늘리므로 채택하지 않았다. [SQL 조사](SqlAggregationReferences-2026-11-09.md), [SQLite AVG](https://www.sqlite.org/lang_aggfunc.html), [SQLite query planner](https://www.sqlite.org/queryplanner.html), [SQLite WITHOUT ROWID](https://www.sqlite.org/withoutrowid.html).

큐·동시성·watcher·성분별 DTO 해제·checkpoint·버킷 재집계·인덱스/스키마 교체는 설계안이며 이번에 구현하지 않았다. 이번 변경의 성능 향상이나 메모리 절감율은 A/B로 검증하지 않았다.

## 4. 검증 범위

타입 검사·TypeScript 컴파일·변경한 소스 ESLint, 코드·참조·diff와 문서 링크를 확인했다. 위 운영 프로파일에서 최초·무변경 갱신이 오류 없이 완료됐고 무변경 스캔의 `storage`가 비어 있음을 관측했다. 자동 테스트·테스트 코드·재현 스크립트·A/B는 작성·수정·실행하지 않았다. `npm run check`는 자동 테스트를 포함하므로 실행하지 않았다. 설치 확장 빌드·패키징·로컬 설치는 이번 범위에 없다.
