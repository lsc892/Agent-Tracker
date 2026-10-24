// dist/src/version.js에서 실행되므로 확장 루트의 실제 manifest를 읽는다.
export const extensionVersion = (require('../../package.json') as { version: string }).version;
