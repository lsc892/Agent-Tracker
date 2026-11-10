# benchmarks

요약·JSONL·SQL·quota 처리의 정확성과 성능을 비교하는 도구를 모은다.

- [transaction-stages-ab.cjs](transaction-stages-ab.cjs) — `--workspace=<고정 입력 폴더> --before=<A 소스·dist 루트> --after=<B 소스·dist 루트> --output=<새 JSON>`으로 현재 전체·합성 10,000요청의 정상 성분 묶음 저장을 준비 3쌍·교대 10쌍 비교한다. 동급 저장 구간 상위 두 개·명시적 거래·COMMIT 횟수·제공자/모델 평균과 JS facts oracle을 기록한다. [transaction-batch-validation.cjs](transaction-batch-validation.cjs)는 같은 A/B를 `--before=... --after=... --output=<새 JSON>`으로 받아 묶음 한계·전체 rollback·실패 격리·취소·삭제 보존·재연결을 별도 검증한다. [보고서](../../docs/benchmarks/2026-11-10/TransactionBatchAB-2026-11-10.md).

- [scan-source-pool-ab.cjs](scan-source-pool-ab.cjs) — `--workspace=<고정 입력 폴더> --before=<A 소스·dist 루트> --after=<B 소스·dist 루트> --output=<새 JSON>`으로 현재 전체·합성 10,000요청의 순차·Worker 풀 파일 준비를 준비3쌍·교대10쌍 비교한다. 최초·1건 추가·무변경의 구간과 저장 내부·평균 조회, DB 의미·논리 읽기 순서·미소비 선행 작업 여부를 검사한다. `--prepare-only`로 고정 입력만 준비할 수 있다. [보고서](../../docs/benchmarks/2026-11-09/SourcePoolAB-2026-11-09.md).

이전 SQL staging·turn metadata·원본 DTO 캐시를 전제로 한 실행기는 해당 시점의 고정 빌드에서 재현하는 과거 실험 도구다. 현재 스트리밍 제품에서는 제거한 API를 제공하지 않는다. 제목 SQL A/B·transaction 실행기는 삭제하고 기존 보고서·원시 결과는 보존한다.

- [scan-stages.cjs](scan-stages.cjs) — 역인덱스·큐 적용 전 기준 구현의 고정 빌드·실데이터 사본과 합성 10,000요청에서 최초 수집·Codex 요청 1건 추가·무변경 갱신을 준비 실행 없이 각각 1회 측정한 실행기다. 기존 반복 검색·pending 정렬 코드를 모듈 로딩 때 계측하므로 해당 이전 빌드에서 사용한다. 새 스캐너는 아래 scan-queue-ab.cjs를 사용한다. [보고서](../../docs/benchmarks/2026-11-09/ScanStages-2026-11-09.md).

- [scan-queue-ab.cjs](scan-queue-ab.cjs) — `--workspace=<고정 입력 사본 폴더> --before=<A 소스·dist 루트> --after=<B 소스·dist 루트> --output=<새 JSON>`으로 현재 전체·합성 10,000요청의 최초·1건 추가·무변경 갱신과 네 평균 조회를 준비3쌍·AB/BA10쌍 비교한다. 구간별 StageProfiler와 원본 읽기 순서·DB 의미·독립 JS 평균 검증을 기록한다. `--structure --pairs=1 --warmups=0`은 별도 관계 검색/큐 구조 진단이며 본 시간 표본에 섞지 않는다. [보고서](../../docs/benchmarks/2026-11-09/ScanQueueAB-2026-11-09.md).

- [parent-dto-delta-ab.cjs](parent-dto-delta-ab.cjs) — 현재 실제 JSONL 고정 사본만 사용해 변경 전·후 초회 수집·재파싱·변경 없는 갱신과 네 평균 조회를 준비 1쌍·AB/BA 3쌍 비교한다. `--workspace=<A 빌드와 current/snapshot.json을 보존한 비공개 폴더> --after=<B 빌드 루트> --output=<새 JSON>`으로 실행하며, `--upgrade-only`는 A DB 사본을 B로 갱신해 fresh B와 비교한다. [parent-dto-delta-oracle.cjs](parent-dto-delta-oracle.cjs)는 같은 workspace와 원본 계보 매핑에서 변경 전 선택기의 child 기여를 부모별 기대값으로 대조한다. [보고서](../../docs/benchmarks/2026-11-08/ParentDtoDeltaAB-2026-11-08.md).

- [dto-greedy-ab.cjs](dto-greedy-ab.cjs) — 전체 DTO 캐시 API가 있던 `3b99d1a` 시점의 체크아웃에서 빌드한 뒤 `node --no-warnings tests/benchmarks/dto-greedy-ab.cjs --output=<새 JSON>`으로 실제 사본·1만·100요청의 원본 보존/Map 없는 배열 대조군을 준비 3쌍·AB/BA 10쌍 비교한다. 현재 단일 읽기 제품에는 이 실행기가 요구하는 `aggregateMemory()` API가 없다. 실제 갱신·COMMIT, 전체 DTO 집계, 일/월/세션/프로젝트 조회와 독립 평균 검증, 별도 프로세스 heap 표본을 기록한다. `--smoke`는 100요청만 실행한다. [후보](dto-greedy-candidate.cjs)와 [정합성 테스트](dto-greedy-ab.test.cjs)는 패자 영구 폐기·DTO 직접 덮어쓰기의 반례도 검사한다. 정합성 테스트도 같은 이전 체크아웃에서 `node --test tests/benchmarks/dto-greedy-ab.test.cjs`로 실행한다. 제품 소스는 변경하지 않는다.

- [streaming-winner-ab.cjs](streaming-winner-ab.cjs) — 교체 직전 전체 DTO 캐시 빌드와 현재의 근거 수집·두 번째 읽기·winner DTO 갱신 구현을 별도 프로세스에서 비교한다. `--before=<보존 dist 폴더> --current-snapshot=<고정 snapshot.json> --oracle=<사전 합계 JSON> --output=<새 JSON>`으로 현재 사본·1만·100요청의 초회 수집, 한 건 추가·COMMIT, 변경 없는 갱신, 네 평균 조회를 준비 3쌍·AB/BA 10쌍 측정한다. `--smoke`는 합성 100요청 한 쌍이다. 원본 사본 복원·facts 대조·독립 JS 평균·retained heap 표본을 포함하며 제품 소스는 바꾸지 않는다. [측정 보고서](../../docs/benchmarks/2026-11-08/StreamingWinnerAB-2026-11-08.md).
- [streaming-winner-profile.cjs](streaming-winner-profile.cjs) — 위 실험의 `config.json A또는B <새 JSON>`을 받아 단일 초기·추가 갱신의 읽기/파싱·최종 집계·저장 시간과 metadata 행 수를 진단한다. `node --expose-gc --no-warnings`로 실행하며 본 A/B 시간 표본에 섞지 않는다.
- [single-pass-winner-ab.cjs](single-pass-winner-ab.cjs) — 같은 교대 측정 실행기를 재사용해 직전 두 번 읽기 빌드와 단일 읽기 winner 구현을 비교한다. 같은 `--before=<보존 dist> --current-snapshot=<snapshot.json> --oracle=<합계 JSON> --output=<새 JSON>` 인자를 받으며 `--smoke`는 합성 100요청 한 쌍이다. [단일 읽기 보고서](../../docs/benchmarks/2026-11-08/SinglePassWinnerAB-2026-11-08.md).

- [summary-paths.cjs](summary-paths.cjs) — 책임별 폴더로 이동한 현재 summary 파일과 과거 고정 제품의 파일 경로를 함께 해석한다. 이전 측정 입력·원시 결과는 바꾸지 않는다.

- [jsonl-memory-ab.cjs](jsonl-memory-ab.cjs) — `--before=<고정 SQL> --after=<고정 메모리 집계> --current-snapshot=<고정 snapshot.json> --output=<새 JSON>`으로 파일 DTO 재사용·메모리 최종 집계·직접 영속 저장을 비교한다. 실제·1만·100요청에서 준비 3쌍·AB/BA 10쌍과 DB 재개방·SQL seed 전환·정합성·TEMP 생성 0회를 검사한다. `--multi-source`는 변경 없는 16 MiB 형제 원본을 둔 1만 요청, `--smoke`는 합성 100요청 한 쌍이다. 이전 SQL 기준은 기본 갱신이 바뀌기 전 별도 빌드를 사용한다.

- [metadata-ab.cjs](metadata-ab.cjs) — `--before=<기준 빌드> --after=<후보 빌드> --output=<새 JSON>`에서 파일 전수 파싱을 유지하는 영속 metadata를 현재·1만·100요청으로 비교한다. variant별 warm DB, 동일 내용 재파싱·한 건 추가·일/월/세션/프로젝트 조회의 준비 3쌍·AB/BA 10쌍, dirty·winner 처리량·공간·정확성과 Markdown을 기록한다. `--baseline-only`는 고정 사본과 A 사전 측정을 보존하며 `--workspace=<기존 캐시>`로 같은 입력을 재사용한다.

- [temp-batch-ab.cjs](temp-batch-ab.cjs) — `--before=<빌드된 이전 소스> --after=<빌드된 이후 소스>`의 고정 사본에서 현재 로그 전체·1만·100요청의 TEMP 집계를 비교한다. 준비 3회 뒤 AB/BA 10쌍의 전체 재파싱·요청 한 건 추가·조회와 독립 JS 평균 검증을 기록한다. `--synthetic-only`는 합성 두 규모, `--smoke`는 100건 한 쌍만 실행한다.
- [simple-index-ab.cjs](simple-index-ab.cjs) — 같은 제품 빌드와 DB 사본에서 세션/제공자 시간 인덱스와 세션 최초 시각 조회의 작은 SQL 조정 후보를 비교한다. 제품 스키마와 쿼리는 변경하지 않는다.
- [session-time-index-ab.cjs](session-time-index-ab.cjs) — SQL 변경 없이 세션 시간 인덱스 하나의 전체 갱신·쓰기 트랜잭션·DB/WAL 크기와 최초 인덱스 생성 비용을 실제 로그 사본과 합성 1만 요청으로 비교한다.
- [inline-cost-ab.cjs](inline-cost-ab.cjs) — 비용 분리 v16과 통합 시제품 v17의 워크트리에서 같은 DB 사본의 조회·요청 추가·쓰기 트랜잭션·파일 공간을 비교한다. 제품은 분리 방식을 유지한다.
- [cost-storage.cjs](cost-storage.cjs) — 비용 통합 실험에서 schema v16/v17의 비용을 같은 논리 열로 읽는다. 기존 제품·과거 측정값은 변경하지 않는다.

- [date-storage-profile.cjs](date-storage-profile.cjs) — 설치 DB의 스키마·행 수·인덱스 공간을 읽기 전용으로 조사한다.
- [date-storage-raw.cjs](date-storage-raw.cjs) — 날짜순 입력과 요청 날짜 인덱스 후보의 정확성·읽기·쓰기·저장 공간을 비교한다.
- [date-storage-rollup.cjs](date-storage-rollup.cjs) — 일별 집계 기본 키 순서와 세션 보완 인덱스 후보를 비교한다.
- [date-storage-query.cjs](date-storage-query.cjs) — 날짜 OR 조건의 UNION 분리·특수화를 준비된 SQL로 비교한다.
- [date-storage-order.cjs](date-storage-order.cjs) — 실제 최신 요청 정렬과 일치하는 표현식 인덱스의 읽기·쓰기·공간을 비교한다.
- [date-storage-sqlite-repro.cjs](date-storage-sqlite-repro.cjs) — 날짜 선두 PK와 OR 계획의 결과 누락을 독립 메모리 DB로 재현한다.

- [jsonl-parsing-branches.cjs](jsonl-parsing-branches.cjs) — 메모리에 고정한 JSONL 입력으로 파싱 분기 변경 전후의 속도와 메모리를 비교한다.
- [jsonl-reader.cjs](jsonl-reader.cjs) — 기준·후보 JSONL 리더의 결과 일치와 읽기·전체 갱신 성능을 비교한다.
- [jsonl-chunks-ab.cjs](jsonl-chunks-ab.cjs) — `--before=<이전 빌드> --after=<이후 빌드> --output=<새 JSON>`으로 청크 단위 디코딩·분할을 비교한다. 100·1만 짧은 줄, 청크보다 긴 줄, 대형 이미지의 기대 결과·원본 offset·시간·메모리를 AB/BA 10쌍으로 검증한다. 실제 갱신·추가·평균 조회는 `temp-batch-ab.cjs --hypothesis=<비교 가정>`을 재사용한다.
- [quota](quota/) — quota 조회 시나리오와 운영체제별 자원 샘플러로 시간·메모리를 측정한다.
- [query-source-files.cjs](query-source-files.cjs) — 벤치마크 fingerprint에 기록할 공개 쿼리 진입점·분리된 구현·선택적 컴파일 파일 경로를 수집한다.
- [query-profile.cjs](query-profile.cjs) — 설치 DB 사본과 합성 1만·10만 요청에서 현재 조회 SQL의 실행 시간·계획과 가장 느린 공개 API를 측정한다.
- [write-profile.cjs](write-profile.cjs) — 고정 로그 사본으로 통계 진입의 스캔·파싱·세션 저장·첫 집계와 INSERT/UPDATE·COMMIT 비용을 구간/SQL 상세 계측으로 나눠 측정한다.
- [sql-explain.cjs](sql-explain.cjs) — 사용량 쿼리의 실행 계획과 인덱스 대안별 조회 성능·공간을 비교한다.
- [sql-writes.cjs](sql-writes.cjs) — 고정 DB와 별도 프로세스로 요청 증분 저장·일/월 기본키 배치·세션 인덱스의 비용을 비교한다.
- [storage-ab.cjs](storage-ab.cjs) — 날짜·월 PK의 맞춤 SQL, TEMP/JOIN 묶음 비교, 파싱 상태 재사용과 세션 크기별 저장 경로를 통제 비교한다.
- [storage-product.cjs](storage-product.cjs) — 변경 전·월 PK·선택적 묶음 저장의 제품 빌드를 고정하고 설치 DB 사본·합성 입력으로 실제 공개 API를 비교한다.
- [storage-transactions.cjs](storage-transactions.cjs) — 세션/월 PK와 일괄/묶음 저장을 교차 대조하고 저장 호출·쓰기 트랜잭션·집계 시간을 분리한다.
- [storage-ab-common.cjs](storage-ab-common.cjs) — 고정 합성 입력·보존된 증분 클래스·해시·순서 교대·정확성 검증을 제공한다.
- [storage-ab-layout.cjs](storage-ab-layout.cjs) — PK·월 컬럼·보조 인덱스를 분리하고 기간 조회·실제 증분 저장·공간을 비교한다.
- [storage-ab-writes.cjs](storage-ab-writes.cjs) — 일괄 교체·요청별 비교·묶음 비교·100건 기준 혼합 경로를 비교한다.
- [storage-ab-parsing.cjs](storage-ab-parsing.cjs) — 전체 파싱과 prefix 검증 후 상태·이벤트 재사용의 정확성·시간·캐시 크기를 비교한다.
- [sql-rowid.cjs](sql-rowid.cjs) — 같은 세션 복합 키·보조 인덱스·증분 저장에서 일별 집계의 rowid 유무에 따른 조회·갱신·공간을 비교한다.
- [sql-rowid-append.cjs](sql-rowid-append.cjs) — 정규화된 JSONL의 최초 일괄 적재·저장 위치 이후 추가분 INSERT 시제품에서 같은 인덱스의 rowid A/B를 비교한다.
- [sql-rollup-memory.cjs](sql-rollup-memory.cjs) — 분리된 자식 프로세스에서 원본·롤업 쿼리의 RSS와 결과 일치를 비교한다.
- [sql-rollup-product.cjs](sql-rollup-product.cjs) — 실제 공개 조회 API의 롤업 적용 전후 읽기·쓰기 성능과 결과를 비교한다.
- [sql-rollup-prototype.cjs](sql-rollup-prototype.cjs) — 벤치마크용 세션·일별 롤업 테이블과 집계 쿼리를 구성한다.
- [sql-rollup-validation.cjs](sql-rollup-validation.cjs) — 독립 합성 데이터로 롤업 시제품의 평균·필터·집계 의미를 검증한다.
- [sql-rollup.cjs](sql-rollup.cjs) — 원본 집계와 세션·일별 롤업 시제품의 정확성·읽기·쓰기·공간을 비교한다.
- [incremental-refresh.cjs](incremental-refresh.cjs) — 빌드된 전후 워크트리에서 실제 로그 사본 또는 요청 수·세션 밀도를 지정한 합성 입력의 증분 저장·전체 갱신 시간과 결과를 비교한다.
- [refresh-rollback.cjs](refresh-rollback.cjs) — 현재 소스의 증분 저장 롤백을 전후 워크트리에서 비교하고 파일 확인·파싱·집계 준비·DB 저장과 주요 기간·세션·평균 조회를 측정한다.
- [summary.cjs](summary.cjs) — 합성 대화 로그로 최초·재사용·추가 갱신의 요약 처리 성능을 측정한다.
