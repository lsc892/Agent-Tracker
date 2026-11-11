# JSONL 행 상태와 파일 읽기 분리

2026-11-11, Asia/Seoul. [통합 제안 S2](Readability-2026-11-11.md#s2-jsonl-행-상태와-파일-읽기-분리)에 대한 사용자 승인을 받아 적용한다. 선행 가독성 정리와 알고리즘 최소화는 보존한다.

## 현재 흐름과 적용 범위

분리 전 [index.ts](../../../src/summary/jsonl/index.ts)는 오류 타입, 이미지 문자열·행 예산 상태, 파일·압축·콜백 수명을 함께 담당했다. 행 상태는 파일 핸들이나 압축기를 사용하지 않으므로 기존 구현을 이동해 경계를 드러냈다.

| 경로 | 책임과 의존 방향 |
| --- | --- |
| [jsonl/index.ts](../../../src/summary/jsonl/index.ts#L21) | 공개 `readJsonl`과 `SummaryError` 재export. 행 연결·JSON 객체 검증·파일/압축/취소/콜백 수명은 유지한다. |
| [jsonl/line.ts](../../../src/summary/jsonl/line.ts#L5) | 기존 `JsonlLine`과 이미지·escape·바이트 예산 상태. `errors.ts`만 참조한다. |
| [jsonl/errors.ts](../../../src/summary/jsonl/errors.ts#L3) | 기존 `SummaryError`의 유일한 클래스 정의. |
| [zstd.ts](../../../src/summary/jsonl/zstd.ts) | 압축 스트림 해제·프레임 검증. 변경하지 않는다. |

이미 존재하는 jsonl 폴더 안에서 분리하므로 하위 폴더를 추가하지 않는다. [원본 읽기](../../../src/summary/scanner/sourceReader.ts#L5), [오류 정규화](../../../src/summary/scanner/sourcePreparation.ts#L41), 파서·갱신 호출부의 기존 `../jsonl` 경로는 그대로 둔다. 오류를 재정의하거나 래핑하지 않아 `instanceof SummaryError`는 같은 생성자를 사용한다.

```text
변경 전                 변경 후
jsonl/                  jsonl/
  index.ts                index.ts
  zstd.ts                 line.ts
                          errors.ts
                          zstd.ts
```

## 검증 계획

클래스 본문과 `readJsonl` 본문을 선행 변경 상태와 대조하고 import/reexport 방향을 검토한다. [기존 JSONL 계약](../../../tests/node/jsonl.test.ts#L18)의 이미지·offset·청크·UTF-8·문법 오류·행 예산·마지막 줄 유예·콜백 중단과 압축/취소/close 경계를 보존한다. 테스트 코드 작성·수정·실행과 임시 재현 스크립트는 사용자 지시에 따라 수행하지 않는다. 컴파일·린트는 메인 에이전트가 통합 실행한다.

## 적용·검증 결과

- **S2 승인·적용 완료**: `JsonlLine` 본문은 export 선언만 추가하여 [line.ts](../../../src/summary/jsonl/line.ts#L5)로 이동했다. 이미지 상태 해석 순서를 설명한 선행 주석도 유지했다. `SummaryError` 생성자·기본 offset·코드는 [errors.ts](../../../src/summary/jsonl/errors.ts#L3)로 그대로 이동했다.
- [index의 import/reexport](../../../src/summary/jsonl/index.ts#L2)를 검토했다. `index → line → errors`와 `index → errors`이며 역참조가 없다. `SummaryError` 정의는 한 곳이고 기존 호출부 경로는 변경하지 않았다.
- [readJsonl](../../../src/summary/jsonl/index.ts#L21)과 JSON 객체 검증 본문은 변경하지 않았다. rows 증가·offset 계산·청크 복사·`processBatch`·파일 read/close·Zstd 오류 변환 위치와 순서를 보존한다. [폴더 README](../../../src/summary/jsonl/README.md)도 실제 책임에 맞췄다.
- 소스·참조·diff 검토와 변경 범위의 `git diff --check`를 수행했다. 컴파일·린트는 메인 에이전트의 통합 검증 대상이다. 테스트·실제 파일 비교·벤치마크는 실행하지 않았으므로 실행 동등성과 성능은 실측하지 않았다. 추가 제안·미승인 소스 변경은 없다.
- 메인 통합 검증에서 `npm run typecheck`·`npm run lint`·`git diff --check`를 통과했다. 테스트 코드는 변경하거나 실행하지 않았다.
