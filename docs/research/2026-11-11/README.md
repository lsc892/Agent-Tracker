# 2026-11-11 조사·적용 기록

- [요청 저장 분리](Readability-memoryStore-split-2026-11-11.md): 영속 반영·값 검증/변환·입력/결과 타입의 경계와 기존 공개 경로 유지.
- [JSONL 분리](Readability-jsonl-split-2026-11-11.md): 파일 읽기·행 상태·공유 오류의 경계와 기존 오류 식별 유지.
- [AlgorithmMinimize-2026-11-11.md](AlgorithmMinimize-2026-11-11.md): 현재 기능을 유지한 알고리즘·쿼리·파싱 최소화의 통합 결과와 검증 한계.
- [실측 A/B](../../benchmarks/2026-11-11/AlgorithmMinimizeAB-2026-11-11.md): 현재·10,000·100요청의 최종 성능, 정합성 검증과 개선·회귀.
- [조회](AlgorithmMinimize-queries-2026-11-11.md): 페이지 집계 공유와 coverage counts 조회.
- [파싱](AlgorithmMinimize-parsing-2026-11-11.md): 제목·토큰·도구·JSONL의 중복 작업 제거.
- [집계·관계](AlgorithmMinimize-aggregation-2026-11-11.md): 부모 root 직접 그룹화와 중복 판정 제거.
- [저장](AlgorithmMinimize-storage-2026-11-11.md): 비용 메타데이터·보존 조회와 세션 결제 처리 최소화.
