// 책임별 폴더로 이동한 summary 파일과 과거 고정 제품의 파일 경로를 함께 해석한다.
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

const moved = {
  client: 'client/index', transport: 'client/transport', refresh: 'client/refresh', worker: 'client/worker',
  scanner: 'scanner/index', memoryScanner: 'scanner/memoryScanner', lock: 'scanner/lock',
  sourceFingerprint: 'scanner/sourceFingerprint', jsonl: 'jsonl/index', zstd: 'jsonl/zstd',
  memoryAggregate: 'aggregation/memoryAggregate', memoryEvents: 'staging/memoryEvents',
  eventValues: 'staging/eventValues', names: 'staging/names', pricing: 'models/pricing', modelOrder: 'models/modelOrder',
  staging: 'staging/index', metadata: 'metadata/index',
};
const previousNames = Object.fromEntries(Object.entries(moved).map(([before, after]) => [after, before]));

/** 현재 폴더 경로를 우선하고 없으면 같은 모듈의 이전 파일 경로로 고정 제품을 찾는다. */
function summaryPath(product, relativePath) {
  const file = relativePath.replaceAll('\\', '/');
  const match = /^(src\/summary\/|dist\/src\/summary\/)(.*?)(\.(?:ts|js))?$/.exec(file);
  if (!match) return resolve(product, file);
  const [, prefix, name, extension = ''] = match;
  const before = moved[name] ? name : previousNames[name];
  if (!before) return resolve(product, file);
  const current = resolve(product, prefix + moved[before] + extension);
  if (existsSync(current) || existsSync(current + '.js')) return current;
  return resolve(product, prefix + before + extension);
}

module.exports = { summaryPath };
