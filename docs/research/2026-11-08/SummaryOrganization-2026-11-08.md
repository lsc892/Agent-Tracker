# Summary 책임별 폴더 정리 — 2026-11-08

## 범위와 승인

사용자는 같은 책임의 코드를 폴더로 묶고 `staging.ts`·`metadata.ts`를 스크립트로 분리하며 가독성을 개선하도록 명시적으로 요청했다. 이 요청을 `src/summary`의 책임별 이동·분리에 대한 승인으로 적용한다. 저장 알고리즘·SQL 의미·공개 API·취소·트랜잭션·집계 결과는 유지한다.

## 구조

기존에는 DB·parser를 제외한 클라이언트, Worker, JSONL reader, 스캐너, 모델 정책과 SQL staging 코드가 `summary/`에 함께 있었다. [summary 안내](../../../src/summary/README.md)의 역할별 폴더로 정리했다.

| 폴더 | 책임 |
| --- | --- |
| [client/](../../../src/summary/client/README.md) | SummaryClient·Worker 통신·갱신 직렬화·Worker 명령 실행 |
| [scanner/](../../../src/summary/scanner/README.md) | 기본 갱신 진입점·파일 DTO 재사용 스캔·갱신 잠금·원본 이동 검증 |
| [jsonl/](../../../src/summary/jsonl/README.md) | JSONL 스트리밍·줄/이미지 처리·Zstd 해제 |
| [aggregation/](../../../src/summary/aggregation/README.md) | 메모리에서 요청·모델·도구의 최종 집계 |
| [staging/](../../../src/summary/staging/README.md) | 호환 SQL 경로의 파일·이벤트·계보·연결 성분·집계 준비 |
| [metadata/](../../../src/summary/metadata/README.md) | 호환 SQL 경로의 요청 의미 서명·변경 의존성·확정 snapshot |
| [models/](../../../src/summary/models/README.md) | 모델 단가·출시일·모델 정렬 정책 |
| `db/`, `parsers/` | 기존 영속 DB와 제공자 parser 경계를 유지 |

`summary/client`, `summary/scanner`, `summary/jsonl`, `summary/staging`, `summary/metadata`의 extensionless import는 각 폴더 `index.ts`로 연결한다. 이동한 내부 모듈과 Worker 실행 경로는 호출부·테스트·측정 도구에서 실제 경로로 갱신한다. 과거 벤치마크의 원시 JSON과 측정값은 수정하지 않는다.

## 분리 작업

개별 적용 근거와 계약은 [staging 작업 기록](SummaryStagingReadability-2026-11-08.md), [metadata 작업 기록](SummaryMetadataReadability-2026-11-08.md)에 연결한다. 사용자가 명시적으로 요청한 폴더·파일 분리는 적용했으며 별도 승인 대기 후보는 없다.

- staging 담당은 타입·TEMP 수명·원본·계보·성분·이벤트·요청 준비/출력을 분리하고, 클래스의 공개 API와 메모리·DB 상태의 소유권을 보존한다.
- metadata 담당은 서명 입력/해시·dirty 의존성·확정 snapshot 반영을 구분하고, sourceRoots 캐시·currentDependencies 갱신 시점·SQL/트랜잭션 순서를 보존한다.
- 두 담당자 모두 메소드당 한 책임, guard clause와 짧은 한국어 책임·알고리즘 주석을 적용한다. 기존 Map/Set·쿼리 알고리즘을 교체하지 않는다.

## 검증

- 최종 `npm run check`의 타입 검사·린트·430개 테스트가 통과했다. 실패·스킵·취소는 0건이다. 기본 Worker 실행·갱신·조회·종료와 기존 계보·복사·트랜잭션 회귀 검증을 포함한다.
- 분리 전 빌드와 현재 SQL 경로를 1/35세션·Skill ON/OFF·최초/무변경/변경/metadata 실패/재시도 20상태로 비교했다. 정상 성공과 의도한 metadata 저장 실패를 확인했으며 SQL 실행 순서·바인딩·서명·dirty 키·요청·모든 영속 테이블이 일치했다.
- staging의 최초/재사용 × component/summary_batch 네 준비 조합에서 전체 집계 SQL이 원본과 바이트 단위로 일치했다.
- 이동한 18개 모듈의 현재·과거 고정 빌드 경로 36개를 확인했다. 이전 컴파일 파일이 새 코드를 가리지 않게 해당 파일만 정리했고 벤치마크의 과거 제품 경로 해석도 확인했다.
- 폴더 README·작업 기록·갱신한 원본 코드 링크를 확인했다. 기존 벤치마크의 원시 JSON·측정값은 보존했으며 링크가 바뀐 보관 보고서는 보관 명세의 현재 해시를 갱신했다.
- 적용과 검증을 완료했다. 별도 승인 대기 후보는 없으며 VS Code 화면 검증은 수행하지 않았다.
