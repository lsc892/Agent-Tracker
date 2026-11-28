// 소스·테스트·도구에 적용할 ESLint 검사 범위와 규칙을 정의한다.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // [검사 범위 정책] 빌드 출력과 캐시, Webview 자산을 검사 대상에서 뺀다.
  { ignores: ['dist/**', 'node_modules/**', 'media/**', 'tests/.cache/**', 'tests/results/**'] },
  // [정적 검사 정책] TypeScript에 파서를 지정하고 제어 흐름과 언어 구문 오류를 검사한다.
  { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, plugins: { '@typescript-eslint': tseslint.plugin }, rules: {
    'constructor-super': 'error', 'no-constant-condition': ['error', { checkLoops: false }],
    'no-debugger': 'error', 'no-duplicate-case': 'error', 'no-unreachable': 'error',
    'no-unsafe-finally': 'error', 'valid-typeof': 'error',
    '@typescript-eslint/no-floating-promises': 'off'
  } }
);
