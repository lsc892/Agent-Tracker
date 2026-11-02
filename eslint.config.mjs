// 소스·테스트·도구에 적용할 ESLint 검사 범위와 규칙을 정의한다.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'media/**', 'tests/.cache/**', 'tests/results/**'] },
  { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, plugins: { '@typescript-eslint': tseslint.plugin }, rules: {
    'constructor-super': 'error', 'no-constant-condition': ['error', { checkLoops: false }],
    'no-debugger': 'error', 'no-duplicate-case': 'error', 'no-unreachable': 'error',
    'no-unsafe-finally': 'error', 'valid-typeof': 'error',
    '@typescript-eslint/no-floating-promises': 'off'
  } }
);
