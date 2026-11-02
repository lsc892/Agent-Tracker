// 공개 쿼리 진입점과 분리된 구현의 벤치마크 fingerprint 대상 경로를 제공한다.
const { readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const queryDirectory = 'src/summary/db/queries';

function querySourceFiles({ compiled = false } = {}) {
  const implementations = readdirSync(join(root, queryDirectory), { recursive: true })
    .filter(path => path.endsWith('.ts'))
    .map(path => `${queryDirectory}/${path.replaceAll('\\', '/')}`)
    .sort();
  const sourcePaths = [
    'src/summary/db/queries.ts',
    'src/summary/db/rollup-queries.ts',
    ...implementations,
  ];
  const compiledPaths = compiled
    ? sourcePaths.map(path => `dist/${path.replace(/\.ts$/, '.js')}`)
    : [];

  return ['tests/benchmarks/query-source-files.cjs', ...sourcePaths, ...compiledPaths].sort();
}

module.exports = { querySourceFiles };
