# 통계 SQL 가독성 정리 — 2026-10-29

## 범위와 파일 배치

사용자의 책임별 스크립트 분리와 폴더별 구분 요청에 따라 SQL 구현을 `queries/common/`, `queries/raw/`, `queries/rollup/`로 나눈다. 공개 조회 API, SQL 의미, 열·바인딩 순서, 검증·예외, DB 스키마와 실행 경로를 보존한다.

변경 전에는 `queries.ts`가 원본·필터·통계·요청·이름·도구·진단 SQL을, `rollup-queries.ts`가 일별 소스·날짜 경계·지표·최종 조회를 한 파일씩에 담았다. 변경 후에는 다음 책임을 따른다.

| 파일 | 책임 |
| --- | --- |
| [queries.ts](../../src/summary/db/queries.ts) | 기존 원본 조회 API를 재노출하는 공개 진입점 |
| [rollup-queries.ts](../../src/summary/db/rollup-queries.ts) | 기존 롤업 조회·일별 집계 API를 재노출하는 공개 진입점 |
| [queries/common/](../../src/summary/db/queries/common/README.md) | SQL 타입, 공통 필터·시간 정책, 정렬식 |
| [queries/raw/](../../src/summary/db/queries/raw/README.md) | 요청 원본, 통계, 요청 목록, 이름, 도구 순위, 진단을 파일별로 구성 |
| [queries/rollup/](../../src/summary/db/queries/rollup/README.md) | 최종 조회 조립, 일별 소스·원본 경계 결합, 병합 지표식을 파일별로 구성 |
| [rollup-state.ts](../../src/summary/db/rollup-state.ts) | 일별 집계 상태와 테이블 정의 |

```text
src/summary/db/
├─ queries.ts                 # 공개 진입점
├─ rollup-queries.ts          # 롤업 공개 진입점
└─ queries/
   ├─ common/                # types.ts · filters.ts · sorting.ts
   ├─ raw/                   # source.ts · usage.ts · turns.ts · names.ts · capabilities.ts · diagnostics.ts
   └─ rollup/                # usage.ts · source.ts · metrics.ts
```

기존 [조회 실행](../../src/summary/db/reader.ts)과 [롤업 유지](../../src/summary/db/rollups.ts)의 호출 경로는 유지한다. 구현 파일끼리는 공통 파일이나 필요한 소스 파일을 직접 참조하며 공개 진입점을 다시 거치지 않는다. 벤치마크의 소스 해시 목록도 실제 구현 경로를 포함하도록 맞춘다.

## 상세 검토

- [롤업 소스·지표·조회 조립](QueryReadability-rollup-2026-10-29.md)
- [원본 쿼리의 역할별 구역과 SQL 표현](QueryReadability-raw-2026-10-29.md)
- [집계 상태·테이블 정의와 정렬식](QueryReadability-state-order-2026-10-29.md)

파일별 담당을 나눠 동일 파일의 동시 수정을 피했다. 기능과 DB 알고리즘의 변경은 포함하지 않는다. 추가 승인이나 미적용 구조 변경 제안은 없다.

## 검증

- 원본과 최종 분리본의 72,034개 경우에서 SQL 토큰·바인딩·모드·예외와 집계 상태·스키마 정의가 일치했다. SQL 공백과 따옴표 밖 토큰의 대소문자만 정규화했다.
- `npm run check`의 타입 검사·린트·365개 테스트를 통과했다. 롤업·원본·모델·날짜 경계·비용·정렬·페이지·동시 조회 snapshot 검증을 포함한다.
- SQL 페이지 절을 여러 줄로 표현해도 동시 쓰기 주입이 실행되도록 기존 [snapshot 테스트](../../tests/node/summary-rollup.test.ts#L534)의 페이지 절 감지를 공백 허용 패턴으로 맞췄다.
- 벤치마크 CJS 9개의 구문 검사와 원본 15개·컴파일 포함 29개 fingerprint 경로의 존재·중복·SHA 계산을 확인했다. 성능 측정은 실행하지 않았다.
- 변경한 Markdown 13개에서 로컬 링크 168개가 모두 존재함을 확인했고 `git diff --check`를 통과했다.
- 실제 계정 quota 조회와 VS Code 설치는 이번 범위에 포함하지 않는다.
