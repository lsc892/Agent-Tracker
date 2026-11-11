# 2026-11-04

기존 TEMP 표·인덱스 재사용을 기준으로, 연결 성분마다 반복하는 집계 SQL을 32 seed씩 묶는 알고리즘을 별도 빌드 사본에서 비교한다.

후속 제품 반영에서는 세션 목록을 디스크 TEMP에 두고 단일 성분은 직접 처리한다. 빌드 JS를 문자열로 고치던 실험 패치와 별도 회귀 실행기는 제거했으며 기존 제품 테스트와 두 빌드 비교 실행기를 사용한다.

- [TempBatchAB-2026-11-04.md](TempBatchAB-2026-11-04.md): 현재 로그 전체·1만·100요청의 전체 재파싱·요청 한 건 추가·평균 조회 결과와 판정.
- [TempBatchAB-2026-11-04.json](TempBatchAB-2026-11-04.json): AB/BA 10쌍의 원시 표본·TEMP 집계 횟수·소스/빌드/입력 해시·정확성 검증.
- [TempBatchValidation-2026-11-04.json](TempBatchValidation-2026-11-04.json): 별도 후보 빌드의 기존 summary·capabilities 회귀 테스트 결과.
- [TempBatchProduct-2026-11-04.json](TempBatchProduct-2026-11-04.json): 단일 성분 직접 처리·디스크 TEMP 묶음을 적용한 제품과 이전 빌드의 합성 1만·100건 후속 비교.
- [TempBatchProduct-2026-11-04.md](TempBatchProduct-2026-11-04.md): 제품 반영 내용·정리 범위·후속 성능·정확성·미측정 범위.
