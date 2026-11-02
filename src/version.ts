// 확장 manifest에서 현재 설치된 확장의 버전을 읽는다.
// dist/src/version.js에서 실행되므로 확장 루트의 실제 manifest를 읽는다.
export const extensionVersion = (require('../../package.json') as { version: string }).version;
