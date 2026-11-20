# 2026-11-19

- [PrefixHashAB-2026-11-19.md](PrefixHashAB-2026-11-19.md): 기존 manifest 판정과 완성 줄 위치·원본 prefix 해시 증분을 SHA-256·BLAKE3·XXH3-128으로 비교한다. 실제 로그 사본·10,000·100요청의 추가·기존 응답 갱신·무변경·중간 변경, 평균 조회·복잡도·메모리와 Worker 1/4개를 검증한다.
- [PrefixHashAB-2026-11-19.json](PrefixHashAB-2026-11-19.json): 소스·빌드·입력 식별자, 준비 3회·교대 10회 원시 표본, 독립 정합성·순수 해시·Worker 비교 결과다.
