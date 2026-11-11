// 미사용 집계 열을 제거한 전후를 비교하며 의도적으로 삭제한 반환 필드만 동등성 비교에서 제외한다.
const { main } = require('./transaction-stages-ab.cjs');

main([...process.argv.slice(2), '--omit-obsolete-rollup-fields'], {
  name: 'rollup-trim', entrypoint: __filename,
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
