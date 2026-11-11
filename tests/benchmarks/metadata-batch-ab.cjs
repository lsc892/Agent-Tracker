// 이름 UPSERT·세션 결제 설정 조회의 중복 제거 전후를 실제 갱신과 SQL 실행 횟수로 비교한다.
const { main } = require('./transaction-stages-ab.cjs');

main(process.argv.slice(2), {
  name: 'metadata-batch', entrypoint: __filename, metadataCounters: true,
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
