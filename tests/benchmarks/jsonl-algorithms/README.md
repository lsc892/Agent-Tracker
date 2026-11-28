# JSONL 알고리즘 실측

SHA-256·XXH3-128·BLAKE3 전체 파싱, 전체 구간 검증 후 체크포인트 재개, 앞 1KiB fingerprint 재개, 고정 블록·rolling checksum·Merkle 검증을 같은 제품 사본에서 비교한다. 기본 작업은 새 요청 추가와 기존 요청의 사용량 갱신이다.

새 요청은 새 요청·응답 ID의 4행을 추가해 요청 수 +1·토큰 +130이다. 기존 요청 갱신은 이미 집계된 요청·응답 ID의 사용량 기록 1행을 추가해 요청 수를 유지하고 입력 토큰 +123·출력 토큰 +7로 갱신한다. 두 경우 모두 JSONL 뒤에 기록을 추가하며 각 표본을 같은 원본·DB·메모리 체크포인트 기준으로 되돌린다.

- [hashers.cjs](hashers.cjs)는 세 네이티브 스트리밍 해시를 같은 인터페이스로 제공한다.
- [hash-micro.cjs](hash-micro.cjs)는 64KiB hot buffer의 순수 해시 계산 시간을 알고리즘별 프로세스에서 계측한다.
- [block-validation.cjs](block-validation.cjs)는 64KiB 블록 인덱스, rsync식 rolling 탐색, 순서 있는 Merkle tree 검증을 구현한다.
- [preparation.cjs](preparation.cjs)는 고정한 제품의 JSONL 리더와 파서를 재사용해 실험용 재개 상태를 만든다.
- [correctness.cjs](correctness.cjs)는 변경·축소·부분 행·중복 응답·포맷 전환·압축 파일의 후보 결과를 전체 파싱 및 합성 기대값과 대조한다.
- [run.cjs](run.cjs)는 실제 로그의 읽기 전용 고정 사본과 합성 10,000·100요청을 준비하고 실제 `refreshSummary`·집계·COMMIT·네 평균 조회를 교대 계측한다.
- [report.cjs](report.cjs)는 완료된 결과를 공개 JSON으로 묶고, 각 알고리즘의 두 작업을 연속된 행으로 배치해 구간 시간·공간복잡도·최종 시간·개선율·최고 관측 RSS와 힙을 비교한다. 이전 측정은 공개 JSON의 `previousMeasurements`에 보존한다. 인자 없이 실행하면 기존 공개 JSON에서 Markdown을 다시 생성한다.
- [usn-benchmark.ps1](usn-benchmark.ps1)은 현재 프로세스의 기존 NTFS 저널 접근 가능성을 확인한다. 접근에 실패하면 성능값을 미측정으로 기록한다.

실험 의존성은 Git 제외 캐시에 설치한다.

```powershell
npm install --prefix tests/.cache/jsonl-algorithms-deps --no-audit --no-fund --save-exact xxhash-addon@2.1.0 @napi-rs/blake-hash@1.4.0
node tests/benchmarks/jsonl-algorithms/hash-micro.cjs --output=tests/.cache/hash-micro-new.json
node --expose-gc --no-warnings tests/benchmarks/jsonl-algorithms/run.cjs --prepare-only
node --expose-gc --no-warnings tests/benchmarks/jsonl-algorithms/run.cjs --workspace=<출력된 비공개 작업 폴더> --output=<새 비공개 결과 JSON>
powershell -NoProfile -File tests/benchmarks/jsonl-algorithms/usn-benchmark.ps1
node tests/benchmarks/jsonl-algorithms/report.cjs <완료된 비공개 결과 JSON> <순수 해시 JSON> <USN JSON>
node tests/benchmarks/jsonl-algorithms/report.cjs
```

`--smoke`는 합성 100요청에서 준비 0회·표본 1회를 수행한다. `--variants=full-sha256,xxh128-checkpoint`로 일부 구성을 선택할 수 있다. 기본 `--scenarios=codex-append,codex-update-existing`는 두 작업을 모두 계측한다. 본 측정은 준비 3회·표본 10회이며 알고리즘 순서를 정방향·역방향으로 교대한다. 3개 입력·11개 알고리즘·2개 작업의 본 표본은 총 660개다. 원본 로그와 설치 DB는 고정 사본 생성 시에만 읽는다. 변경 시나리오는 비공개 작업 폴더의 사본에 적용하고 매번 복원한다.

이전 범위의 재계측은 `--scenarios=codex-append,claude-append,zstd-append,middle-rewrite-and-append,middle-insert-and-append,unchanged`로 지정할 수 있다. 각 입력에 없는 시나리오는 명시적으로 제외해야 한다. `report.cjs`의 현재 Markdown 표는 새 요청 추가·기존 요청 갱신 결과를 요구한다. 두 작업 모두 전체 파싱 대비 요청 facts와 네 집계 결과, 예상 요청 수·토큰 증가량을 대조한다.

모든 파일 준비는 Worker 1개 설정의 순차 경로를 사용한다. 후보별 프로세스는 초기화 후 대기하며 동시에 하나만 실행한다. 표본마다 seed DB를 복원하고 메모리 체크포인트도 같은 기준 상태로 복제한다. 디스크 캐시가 예열된 상태이며 OS 캐시를 강제로 비우지 않는다. 갱신 시간에는 원본 검사·상태 복제·파싱·전체 준비 상태 병합·SQL 비교·COMMIT이 포함된다. 사본 복원·GC·정합성 대조·조회는 갱신 시간 밖에서 수행한다. 조회 시간은 별도로 기록한다.

체크포인트는 갱신 간 메모리에 유지되는 시제품이다. 전체 캐시의 디스크 저장·재시작 복원은 구현 범위 밖이다. 직렬화 바이트는 `v8.serialize`로 표현 가능한 파서·winner·관계 상태와 인덱스의 크기이며 객체 RAM이나 native 해시 상태 크기와 다르다. RSS는 10ms 및 읽기·단계 경계 표본의 관측 최고값이며 런타임·native 라이브러리·기존 할당 영역을 포함한다.

고정 블록·rolling·Merkle 후보는 같은 원본 읽기에서 전체 XXH3-128도 계산한다. rolling은 weak 후보와 strong 해시를 대조하고 성공 시 블록 끝으로 이동한다. rolling-Merkle 조합은 같은 읽기에서 순서 있는 블록 해시도 계산한다. 이전 구간이 달라졌으면 전체 파싱으로 복구한다. 중간 변경 이후 블록별 DTO 재사용은 구현 범위 밖이다. 앞 1KiB fingerprint 후보는 추가 전용 조건의 비용을 보여 주며, 중간 수정 반례를 별도로 기록한다.

Zstd는 완성된 독립 프레임 추가 시 압축 offset과 해제된 줄 offset에서 재개한다. 이전 마지막 행이 미완성이거나 prefix가 달라지면 전체 파싱으로 복구한다. 현재 제품에는 이 실험의 재개 기능을 반영하지 않는다.

공개 보고서에는 원시 로그·제목·세션 ID·개인 경로를 옮기지 않는다. 입력 파일·제품 사본·작업 DB·세부 실행 로그는 `tests/.cache/jsonl-algorithms-*` 아래에 보존한다.
