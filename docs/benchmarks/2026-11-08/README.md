# 2026-11-08 벤치마크

- [단일 읽기 winner A/B](SinglePassWinnerAB-2026-11-08.md): 두 번 읽던 직전 구현과 원본 한 번 읽기·winner DTO 갱신·패자 폐기를 수행하는 구현을 같은 1,518·1만·100요청으로 비교한다. 패자 모델을 별도 표시하지 않는 사용자 결정도 기록한다.
- [단일 읽기 원시 표본](SinglePassWinnerAB-2026-11-08.json): 고정 빌드·입력, 교대 10쌍의 시간·heap·본문 읽기·정확성 검증 결과.
- [단일 읽기 검증](SinglePassWinnerVerification-2026-11-08.json): 415개 테스트·패자 모델 기준·입력 복원·소스 식별·실행 명령을 기록한다.

- [스트리밍 winner A/B](StreamingWinnerAB-2026-11-08.md): 전체 DTO 캐시를 사용하던 교체 직전 빌드와 두 번의 읽기·winner DTO 갱신·패자 폐기를 수행하는 현재 수집 경로를 실제 1,518·합성 1만·100요청으로 비교한다.
- [스트리밍 winner 원시 표본](StreamingWinnerAB-2026-11-08.json): 초회 구축·추가·변경 없는 갱신·평균 조회의 교대 10쌍, 입력·빌드 hash, 정확성 및 retained heap 표본.
- [스트리밍 winner 진단·검증](StreamingWinnerVerification-2026-11-08.json): 별도 구간 계측, 재실행 명령, 소스 식별자와 전체 검사 결과.

- [DTO greedy A/B](DtoGreedyAB-2026-11-08.md): 원본 보존·Map 없는 배열 대조군을 현재 로그·1만·100요청으로 비교한다. 사용자가 요청한 한 번의 순회와 별도 캐시 재사용 실험의 범위를 구분하고, 삭제 반례에 따른 기각 결론을 정정했다.
- [원시 표본](DtoGreedyAB-2026-11-08.json): 입력·소스·후보 hash, 정합성 결과, 준비 3쌍 뒤 AB/BA 10쌍의 시간과 별도 프로세스 heap 표본.
- [검증 기록](DtoGreedyVerification-2026-11-08.json): 정합성 반례, 전체 검사와 후보 회귀 검사, 입력 분포·연산 수를 보존한다.
