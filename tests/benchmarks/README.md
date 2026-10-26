# benchmarks

요약·JSONL·SQL·quota 처리의 정확성과 성능을 비교하는 도구를 모은다.

- [date-storage-profile.cjs](date-storage-profile.cjs) — 설치 DB의 스키마·행 수·인덱스 공간을 읽기 전용으로 조사한다.
- [date-storage-raw.cjs](date-storage-raw.cjs) — 날짜순 입력과 요청 날짜 인덱스 후보의 정확성·읽기·쓰기·저장 공간을 비교한다.
- [date-storage-rollup.cjs](date-storage-rollup.cjs) — 일별 집계 기본 키 순서와 세션 보완 인덱스 후보를 비교한다.
- [date-storage-query.cjs](date-storage-query.cjs) — 날짜 OR 조건의 UNION 분리·특수화를 준비된 SQL로 비교한다.
- [date-storage-order.cjs](date-storage-order.cjs) — 실제 최신 요청 정렬과 일치하는 표현식 인덱스의 읽기·쓰기·공간을 비교한다.
- [date-storage-sqlite-repro.cjs](date-storage-sqlite-repro.cjs) — 날짜 선두 PK와 OR 계획의 결과 누락을 독립 메모리 DB로 재현한다.

- [jsonl-parsing-branches.cjs](jsonl-parsing-branches.cjs) — 메모리에 고정한 JSONL 입력으로 파싱 분기 변경 전후의 속도와 메모리를 비교한다.
- [jsonl-reader.cjs](jsonl-reader.cjs) — 기준·후보 JSONL 리더의 결과 일치와 읽기·전체 갱신 성능을 비교한다.
- [quota](quota/) — quota 조회 시나리오와 운영체제별 자원 샘플러로 시간·메모리를 측정한다.
- [request-titles.cjs](request-titles.cjs) — 요청 제목 집계 SQL 대안의 정확성·시간·저장 공간을 비교한다.
- [sql-explain.cjs](sql-explain.cjs) — 사용량 쿼리의 실행 계획과 인덱스 대안별 조회 성능·공간을 비교한다.
- [sql-rollup-memory.cjs](sql-rollup-memory.cjs) — 분리된 자식 프로세스에서 원본·롤업 쿼리의 RSS와 결과 일치를 비교한다.
- [sql-rollup-product.cjs](sql-rollup-product.cjs) — 실제 공개 조회 API의 롤업 적용 전후 읽기·쓰기 성능과 결과를 비교한다.
- [sql-rollup-prototype.cjs](sql-rollup-prototype.cjs) — 벤치마크용 세션·일별 롤업 테이블과 집계 쿼리를 구성한다.
- [sql-rollup-validation.cjs](sql-rollup-validation.cjs) — 독립 합성 데이터로 롤업 시제품의 평균·필터·집계 의미를 검증한다.
- [sql-rollup.cjs](sql-rollup.cjs) — 원본 집계와 세션·일별 롤업 시제품의 정확성·읽기·쓰기·공간을 비교한다.
- [summary-transactions.cjs](summary-transactions.cjs) — 동일 로그 스냅샷으로 제목 인덱스 전후의 전체 요약 갱신 비용을 비교한다.
- [summary.cjs](summary.cjs) — 합성 대화 로그로 최초·재사용·추가 갱신의 요약 처리 성능을 측정한다.
