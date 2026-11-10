// 같은 실제 갱신·원본 사본·독립 평균 검증으로 성분별/묶음별 rollup 유지 비용을 비교한다.
const { main } = require('./transaction-stages-ab.cjs');

main(process.argv.slice(2), { name: 'rollup-batch', entrypoint: __filename }).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
