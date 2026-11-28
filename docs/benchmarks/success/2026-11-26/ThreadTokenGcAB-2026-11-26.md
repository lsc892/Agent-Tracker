# 응답 토큰 ArrayBuffer와 자연 GC A/B

응답별 숫자 객체를 연속 버퍼로 바꾸면 갱신 중 V8이 추적할 객체가 줄어, 자연 GC의 멈춤 시간이 줄 수 있다. 앞선 실험의 A(토큰 객체)와 B(토큰 `ArrayBuffer`) 빌드·고정 로그·추가 요청·SQLite 기준 사본을 그대로 사용했다. [피크 힙과 RSS 측정](ThreadTokenBufferAB-2026-11-26.md)

## 결과

각 값은 실행별 GC 횟수와 멈춤 시간 합계의 중앙값이다. 실로그 최초 수집은 파일 Worker 4개를 사용했고, 나머지는 수집 스레드에서 순차로 파싱했다.

| 입력과 시나리오 | 범위 | GC 횟수 A → B | 멈춤 합계 A → B |
| --- | --- | ---: | ---: |
| 실로그 733파일 최초 수집 | 수집 스레드 | 15 → 15 | 17.35 → 14.05 ms |
| 실로그 733파일 최초 수집 | 파일 Worker 4개 합산 | 463 → 498 | 242.80 → 236.85 ms |
| 실로그 733파일 최초 수집 | 전체 스레드 합산 | 478 → 513 | 259.85 → 251.65 ms |
| 실로그 733파일 1건 추가 | 수집 스레드 | 14 → 14 | 4.75 → 4.50 ms |
| 합성 10,000건 최초 수집 | 수집 스레드 | 20 → 20 | 8.65 → 8.55 ms |
| 합성 10,000건 1건 추가 | 수집 스레드 | 2 → 2 | 0.90 → 1.00 ms |
| 합성 100건 최초 수집 | 수집 스레드 | 1 → 1 | 0.30 → 0.30 ms |
| 합성 100건 1건 추가 | 수집 스레드 | 0 → 0 | 0 → 0 ms |

실로그 최초 수집의 수집 스레드는 20쌍 중 19쌍에서 멈춤 합계가 짧았다. 중앙값은 19.0% 줄었고, 실행별 최장 단일 멈춤의 중앙값은 3.70 → 2.55 ms였다. 파일 Worker에서는 Scavenge 횟수가 435 → 472, Mark-Compact가 27 → 25로 바뀌었다. 전체 멈춤 합계 중앙값은 3.2% 짧았고, 20쌍 중 14쌍에서 짧았다. 전체 합계의 범위는 A 226.50–352.60 ms, B 219.90–292.60 ms였다.

이 변경의 큰 효과는 최초 수집 피크 V8 힙 감소다. 앞선 계측에서 48.39 → 28.29 MiB였고, RSS 중앙값은 458.97 → 454.67 MiB였다. 같은 형식의 숫자가 많고 Worker 사이를 건너는 구간에서는 연속 버퍼로 객체 수와 숫자 바이트 복사를 줄일 수 있다. 외부 바이트도 RSS를 사용하고 GC 발생 조건에 영향을 준다. 작은 입력이나 파일 한 개를 다시 읽는 경우 힙과 GC 차이는 작았다. [Node.js 메모리 지표](https://nodejs.org/download/release/latest-v24.x/docs/api/process.html#processmemoryusage) · [V8 외부 메모리 처리](https://chromium.googlesource.com/v8/v8.git/%2B/a6e327b50275691c21e6c7df9e8df37be2d09499/src/heap/heap.cc)

## 측정 및 검증

- Windows x64, Node 24.14.1, SQLite 3.51.2에서 조건별 준비 3쌍, AB·BA 10쌍씩을 실행했다. 매 실행에 새 프로세스와 SQLite DB를 사용했다. 최초 수집은 빈 DB에서, 기존 파일에 1건 추가는 동일한 기준 DB 사본에서 시작했다.
- 직전 강제 GC 한 번으로 수집 isolate를 식별하고 그 이벤트를 집계에서 제외했다. 그 뒤 실제 갱신 API 호출부터 파일 Worker 종료까지 V8 `--trace-gc-nvp`의 `pause`를 읽었다. 각 이벤트는 0.1 ms 단위다. 나란히 실행된 Worker의 멈춤을 합산한 값은 스레드별 멈춤의 합계다. 동시 작업의 CPU 시간과 VS Code 화면 체감 시간은 미측정이다. [V8 추적 구현](https://github.com/nodejs/node/blob/v24.14.1/deps/v8/src/heap/gc-tracer.cc#L759-L779)
- 120쌍에서 원본 처리 수, 읽은 바이트, SQLite 논리 행, 제공자별 토큰과 일·월·세션·프로젝트 조회 해시가 앞선 벤치마크와 일치했다. 빌드·입력·추가 대상의 해시와 SQLite 무결성·외래 키도 확인했다. [원시 GC 이벤트](ThreadTokenGcAB-2026-11-26.json)

## 재실행

피크 힙 측정 실행기가 생성한 `Workspace`에 A/B 빌드와 로그 사본이 보관된다. 해당 폴더와 그 실행이 저장한 원시 JSON을 지정한다.

```powershell
node --no-warnings tests/benchmarks/thread-token-gc-ab.cjs --workspace='<메모리 측정 Workspace>' --reference='<메모리 측정 JSON>' --output=tests/results/benchmarks/ThreadTokenGcAB-rerun.json
```
