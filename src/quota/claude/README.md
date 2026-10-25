# claude

Claude OAuth 사용량 응답을 크기 제한 안에서 읽고 공통 quota 데이터로 변환한다.

- [httpBody.ts](httpBody.ts): HTTP 응답 본문을 1MiB로 제한해 읽고 JSON으로 해석한다.
- [response.ts](response.ts): 사용률과 초기화 시각을 검증해 공통 quota 스냅샷으로 변환한다.
