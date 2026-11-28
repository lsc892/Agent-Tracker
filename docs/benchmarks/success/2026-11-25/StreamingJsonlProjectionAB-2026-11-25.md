# 청크별 JSONL 필드 선택 A/B

사용자는 일반·압축 JSONL에서 전체 행을 조립하기 전에 필요한 필드를 골라 달라고 요청했다. 긴 행의 임시 버퍼와 UTF-8 변환량이 줄어들 것으로 예상했다. A는 `fb60fca`의 행 완성 후 선택 파싱이다. B는 청크 경계를 넘거나 이미지가 있는 고정 필드 행을 읽는 중에 필요한 조각만 보관한다. 한 청크 안에 들어오는 일반 행은 직접 디코딩 경로를 사용한다.

## 실로그 1회 비교

표는 A → B다. 두 빌드는 실로그 고정 사본 714개를 세 그룹으로 나누어 같은 입력을 그룹당 한 번씩 순차 처리했다.

| 입력 | 파일 준비 (ms) | 피크 RSS (MiB) | 관측 피크 V8 힙 (MiB) | 관측 피크 ArrayBuffer (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Claude 일반 12파일 | 97.36 → 97.53 | 50.18 → 51.73 | 8.72 → 7.96 | 2.07 → 0.82 |
| Codex 일반 34파일 | 441.98 → 451.49 | 56.11 → 54.27 | 11.14 → 10.93 | 3.67 → 1.57 |
| Codex 압축 668파일 | 7,195.55 → 7,280.62 | 205.04 → 144.33 | 36.05 → 34.81 | 38.60 → 31.30 |

압축 로그의 피크 RSS는 29.6% 줄었고 준비 시간은 1.2% 늘었다. 일반 로그 두 그룹의 관측 피크 ArrayBuffer는 각각 60.6%, 57.2% 줄었다. Claude 일반의 피크 RSS는 3.1% 늘었다. 각 값은 한 쌍의 관측값이다.

## 전체 최초 수집 1회 비교

같은 714파일을 파일 Worker 4개로 빈 SQLite DB에 빌드별 한 번 수집했다. 전체 시간은 파일 탐색부터 저장과 Worker 종료까지다.

| 지표 | A | B | 변화 |
| --- | ---: | ---: | ---: |
| 전체 수집 시간 | 3,079.29 ms | 2,989.33 ms | −89.96 ms (−2.9%) |
| 파일 준비 단계 | 2,828.80 ms | 2,745.53 ms | −83.28 ms (−2.9%) |
| 프로세스 피크 RSS | 436.57 MiB | 431.36 MiB | −5.21 MiB (−1.2%) |
| 피크 메인 V8 사용 힙 | 47.24 MiB | 48.04 MiB | +0.80 MiB (+1.7%) |

Worker와 네이티브 메모리는 RSS에 포함된다. 메인 힙은 5 ms 간격과 수집 진행 시점에서 관측했다. 두 빌드에서 읽은 바이트와 일별 집계 행 해시가 일치했다. OS 캐시를 비우지 않고 A → B 순서로 한 번씩 실행했다. [전체 수집 원시 표본](StreamingJsonlProjectionAB-2026-11-25.json)

## 알고리즘 복잡도

N은 파서에 들어온 JSONL 전체 바이트, B는 압축 원본 바이트, C는 입력 청크 크기, L은 이미지 제거 후 가장 큰 보관 행, S는 가장 큰 축소 행, D는 JSON 중첩 깊이다.

| 알고리즘 | 일반 시간 | 압축 읽기·해제 포함 시간 | 파서 보조 공간 |
| --- | --- | --- | --- |
| A · 줄 조립 후 필드 선택 | O(N) | O(B + N) | O(C + L) |
| B · 청크별 필드 선택 | O(N) | O(B + N) | O(C + S + D) |

두 구현 모두 버리는 값의 문법을 검사한다. B는 기존 이미지 필터가 넘긴 바이트 구간에서 키·숫자·문자열 상태를 이어 가면서 선택한 조각만 모은다. 청크당 임시 바이트 스캔과 축소 행의 최종 UTF-8 디코딩이 있다. 가장 큰 축소 행이 원래 행 크기에 비례하면 최악 공간 차수는 같다. 표의 공간은 JSONL 파서 내부이며 Zstd 윈도우와 스레드 집계 상태는 두 구현에 공통으로 추가된다.

## 측정 범위와 재실행

Windows x64, Ryzen 5 7500F, Node 24.14.1에서 그룹과 빌드마다 새 프로세스를 사용했다. 예열 없이 A → B로 실행했고 OS 파일 캐시는 비우지 않았다. 파일별 순차 측정 시간은 제품 `prepareSource`의 파일 읽기, 압축 해제, JSONL 처리, 파일별 집계를 합한 값이다. 파일 목록 준비와 결과 해시 계산은 타이머 밖이다. RSS는 프로세스 최대값이며 힙과 ArrayBuffer는 5 ms마다 그리고 파일 반환 뒤 관측했다. 조회, 합성 입력, 증분 갱신은 미측정이다.

일반·압축 세 그룹에서 전체 **221,123행**, 읽은 바이트, 파일별 준비 결과 해시가 일치했다. 오류 파일과 미완성 줄은 모두 0이었다. [원시 표본·입력 및 빌드 해시](StreamingJsonlProjectionAB-2026-11-25.json)

두 소스를 각각 `tsc -p tsconfig.json --outDir <출력 폴더>`로 컴파일한다. `$beforeBuild`와 `$afterBuild`는 각각 `src/`가 들어 있는 컴파일 출력 폴더이며, `$snapshot`에는 같은 고정 사본의 비공개 manifest 경로를 지정한다.

```powershell
$report = Get-Content -Raw -Encoding UTF8 docs/benchmarks/success/2026-11-25/StreamingJsonlProjectionAB-2026-11-25.json | ConvertFrom-Json
$measure = $report.runner.stdin -join [Environment]::NewLine
foreach ($case in $report.cases) {
  $measure | node - $beforeBuild $snapshot $case.group before
  $measure | node - $afterBuild $snapshot $case.group after
}

$measureFull = $report.fullRefresh.runner.stdin -join [Environment]::NewLine
$measureFull | node --expose-gc --no-warnings - $beforeBuild $snapshot before
$measureFull | node --expose-gc --no-warnings - $afterBuild $snapshot after
```
