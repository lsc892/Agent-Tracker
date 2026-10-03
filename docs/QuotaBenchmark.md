# Quota App Server 자원 벤치마크

`scripts/quota/benchmark.cjs`는 `CodexQuotaProvider`를 그대로 사용하여 짧게 실행되는 App Server의 초기화·조회·종료 시간과 child process 메모리를 측정한다. 기본 실행은 합성 Node process이며 로그인이나 네트워크를 사용하지 않는다.

```sh
npm run build
node scripts/quota/benchmark.cjs
```

기본값은 success, error, timeout, cancel을 각각 두 번 실행한다. 결과는 `benchmark-results/quota.json`과 표준 출력에 JSON으로 기록한다. 폴더는 Git 및 VSIX 패키지에서 제외되어 있다. 다른 작업 디렉터리에서 실행해도 기본 출력 위치는 저장소의 `benchmark-results`다.

```sh
node scripts/quota/benchmark.cjs --iterations=1 --sample-ms=50
node scripts/quota/benchmark.cjs --output=benchmark-results/quota-local.json
```

`--iterations`는 1–10, `--sample-ms`는 10–1000 범위를 허용한다. 샘플링 간격은 요청값이며 실제 간격은 OS 스케줄링과 process 조회 비용에 따라 길어진다. 실제 관측 간격도 결과에 기록한다.

## 실제 Codex 조회

실제 CLI 조회는 `--real`을 명시할 때만 실행한다. 기존 Codex 로그인과 환경을 사용하며 기본 한 번의 success 시나리오만 실행한다. 모델 추론이나 thread/turn 생성은 하지 않는다. 이 명령은 quota 네트워크 조회를 수행할 수 있다.

```sh
node scripts/quota/benchmark.cjs --real
node scripts/quota/benchmark.cjs --real --iterations=2 --output=benchmark-results/quota-real.json
```

필요하면 `--executable=...`, `--data-home=...`으로 CLI와 `CODEX_HOME`을 지정한다. 이 두 옵션은 `--real` 없이는 거부한다. Windows npm 설치의 `codex.cmd`는 provider가 native 실행 파일로 해석한다.

stdout과 artifact에는 계정 식별자, credential, 인증 파일 내용, quota 사용률, reset 시각, CLI stderr, RPC 오류 본문을 기록하지 않는다. 오류는 provider의 제한된 `errorCode`만 남긴다. synthetic RPC에는 비공개 본문 canary가 들어 있으며 회귀 테스트가 출력 누출을 검사한다. 내부 측정에 사용한 PID와 설정 경로도 최종 artifact에 넣지 않는다.

## 시간 지표

모든 구간은 `performance.now()`의 단조 증가 시계로 측정한다. sampler를 먼저 준비하므로 sampler 시작 시간은 quota latency에 포함하지 않는다.

| 필드 | 의미 |
|---|---|
| `elapsedMs` | provider 생성·read·dispose까지의 전체 측정 시간 |
| `spawnReturnedMs` | provider read 시작부터 `spawn()` 반환까지. CLI 준비 완료 시각은 아님 |
| `initializeCompletedMs` | initialize 응답과 initialized notification까지의 누적 시간 |
| `accountReadCompletedMs` | account/read 응답까지의 누적 시간 |
| `quotaReadCompletedMs` | rateLimits/read 응답 파싱 완료까지의 누적 시간 |
| `shutdownMs` | 성공 응답 이후 process 종료 확인까지의 시간. 실패 경로는 `null` |
| `childLifetimeMs` | spawn 반환부터 child의 close event까지 |

실패로 도달하지 못한 phase는 `null`로 기록한다. `iteration=1`과 후속 반복을 cold/warm 측정으로 단정하지 않는다. OS 파일 캐시·CLI 인증 갱신 여부를 별도로 통제하지 않기 때문이다.

## 메모리·CPU 지표

Windows는 숨겨진 PowerShell sampler를 먼저 시작하고 대상 PID만 전달한다. `Get-Process`의 WorkingSet64, PeakWorkingSet64와 TotalProcessorTime을 읽는다. Linux는 `/proc/<pid>/status`의 VmRSS/VmHWM, 다른 POSIX 환경은 `ps`의 RSS를 읽는다. 이 측정은 직접 실행한 child 하나에 한정되며 Extension Host, sampler, 별도 descendant process는 포함하지 않는다.

| 필드 | 의미 |
|---|---|
| `sampledPeakRssBytes` | 실제 관측한 RSS/working set 중 최댓값. 샘플 사이의 순간 peak는 놓칠 수 있음 |
| `osPeakRssBytesAtLastSamples` | 관측 시점까지 OS가 추적한 peak working set/VmHWM. 마지막 샘플 이후는 포함되지 않을 수 있음 |
| `observedMeanRssBytes` | RSS 샘플의 산술평균. 연속 시간 적분이나 전체 수명 평균이 아님 |
| `cpuTimeAtLastSampleMs` | 마지막 관측 CPU 누계. 현재 Windows에서만 제공되며 전체 수명 CPU로 간주하지 않음 |
| `sampleCount` | 유효 RSS 샘플 수 |
| `firstSampleAfterTargetMs`, `lastSampleAfterTargetMs` | sampler가 PID를 읽은 뒤 첫·마지막 샘플까지의 시간 |
| `observedSpanMs`, `observedCoverageFraction` | 첫·마지막 샘플 간 시간과 child 수명에 대한 비율 |
| `observedMeanIntervalMs`, `observedMaxIntervalMs` | 실제 샘플 사이의 평균·최대 간격 |
| `estimatedCycleMeanRssBytesAt900Seconds` | 샘플 평균 RSS × child 수명 ÷ 900초. 15분 주기의 추정값이며 직접 측정한 평균은 아님 |

읽지 못한 지표는 `null`, 샘플을 얻지 못한 경우는 `sampleCount: 0`으로 남긴다. 임의로 0 bytes를 만들어 성공 측정처럼 표시하지 않는다. synthetic fixture는 정상 종료 시 `process.resourceUsage()`의 전체 수명 maxRSS와 `process.cpuUsage()`를 별도 `fixtureResources`에 기록한다. 이 값은 외부 샘플 값과 구분하며 실제 Codex 실행에서는 항상 `null`이다.

합성 process는 16 MiB를 의도적으로 할당하고 initialize에 50 ms, quota 응답에 250 ms를 지연시킨다. timeout은 quota 응답을 보내지 않고 750 ms 제한에 걸리며, cancel은 account/read 이후 200 ms에 취소한다. 합성 결과는 측정·종료 경로 검증용이고 실제 Codex 자원 비용의 추정 근거가 아니다.

## 종료 확인과 자동 검증

각 시나리오는 provider close event와 PID 생존 확인을 기록하며 sampler 종료도 확인한다. 예상 결과와 다르거나 child/sampler 종료를 확인하지 못하면 exit code 1을 반환한다. 실제 계정 조회 실패도 성공으로 표시하지 않는다. 읽기 권한이나 OS 도구 제약으로 메모리 샘플이 없을 때는 지표를 `null`로 남기므로 결과를 확인해야 한다.

```sh
npm run build
node --test dist/tests/quota.test.js dist/tests/quota-benchmark.test.js
```

회귀 테스트는 실제 계정 옵트인 조건, RSS/CPU 지표 구분, success/error/timeout/cancel 결과, child/sampler 종료와 출력 내용 제한을 검증한다. 실제 Codex quota endpoint 및 계정 상태 확인은 `--real` 실행으로 별도 수행한다.
