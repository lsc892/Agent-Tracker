# benchmarks

요약·JSONL·SQL·quota 처리의 정확성과 성능을 비교하는 도구를 모은다.

- [jsonl-parsing-branches.cjs](jsonl-parsing-branches.cjs) — 메모리에 고정한 JSONL 입력으로 파싱 분기 변경 전후의 속도와 메모리를 비교한다.
- [jsonl-reader.cjs](jsonl-reader.cjs) — 기준·후보 JSONL 리더의 결과 일치와 읽기·전체 갱신 성능을 비교한다.
- [quota](quota/) — quota 조회 시나리오와 운영체제별 자원 샘플러로 시간·메모리를 측정한다.
- [request-titles.cjs](request-titles.cjs) — 요청 제목 집계 SQL 대안의 정확성·시간·저장 공간을 비교한다.
- [sql-explain.cjs](sql-explain.cjs) — 사용량 쿼리의 실행 계획과 인덱스 대안별 조회 성능·공간을 비교한다.
- [sql-writes.cjs](sql-writes.cjs) — 고정 DB와 별도 프로세스로 요청 증분 저장·일/월 기본키 배치·세션 인덱스의 비용을 비교한다.
- [sql-rowid.cjs](sql-rowid.cjs) — 같은 세션 복합 키·보조 인덱스·증분 저장에서 일별 집계의 rowid 유무에 따른 조회·갱신·공간을 비교한다.
- [sql-rowid-append.cjs](sql-rowid-append.cjs) — 정규화된 JSONL의 최초 일괄 적재·저장 위치 이후 추가분 INSERT 시제품에서 같은 인덱스의 rowid A/B를 비교한다.
- [sql-rollup-memory.cjs](sql-rollup-memory.cjs) — 분리된 자식 프로세스에서 원본·롤업 쿼리의 RSS와 결과 일치를 비교한다.
- [sql-rollup-product.cjs](sql-rollup-product.cjs) — 실제 공개 조회 API의 롤업 적용 전후 읽기·쓰기 성능과 결과를 비교한다.
- [sql-rollup-prototype.cjs](sql-rollup-prototype.cjs) — 벤치마크용 세션·일별 롤업 테이블과 집계 쿼리를 구성한다.
- [sql-rollup-validation.cjs](sql-rollup-validation.cjs) — 독립 합성 데이터로 롤업 시제품의 평균·필터·집계 의미를 검증한다.
- [sql-rollup.cjs](sql-rollup.cjs) — 원본 집계와 세션·일별 롤업 시제품의 정확성·읽기·쓰기·공간을 비교한다.
- [summary-transactions.cjs](summary-transactions.cjs) — 동일 로그 스냅샷으로 제목 인덱스 전후의 전체 요약 갱신 비용을 비교한다.
- [summary.cjs](summary.cjs) — 합성 대화 로그로 최초·재사용·추가 갱신의 요약 처리 성능을 측정한다.
