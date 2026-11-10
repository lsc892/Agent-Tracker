// 통합 집계 전후를 고정 실로그·합성 1만 요청의 facts와 독립 평균 검증으로 대조한다.
const { main } = require('./transaction-stages-ab.cjs');

const args = process.argv.slice(2);
if (!args.some(arg => arg.startsWith('--pairs='))) args.push('--pairs=1');
if (!args.some(arg => arg.startsWith('--warmups='))) args.push('--warmups=0');
main(args, { name: 'unified-stream-stats-equivalence', entrypoint: __filename }).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
