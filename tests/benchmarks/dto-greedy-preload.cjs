// 회귀 테스트 프로세스의 기본 집계 함수만 원본 보존·배열 대조군으로 교체한다.
const { resolve, join } = require('node:path');
const root = resolve(__dirname, '../..');
const { loadCandidates } = require('./dto-greedy-candidate.cjs');
const modules = loadCandidates(root, join(root, 'tests/.cache', `dto-greedy-regression-${process.pid}`));
require(join(root, 'dist/src/summary/aggregation/memoryAggregate')).aggregateMemory = modules.B.aggregateMemory;
