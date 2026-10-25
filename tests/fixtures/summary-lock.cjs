// 스레드·자식 프로세스에서 요약 갱신 잠금의 획득과 해제를 제어한다.
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const config = workerData || JSON.parse(process.argv[2]);
const { acquireRefreshLock } = require(config.lockModule);
const send = value => parentPort ? parentPort.postMessage(value) : process.send(value);
const receiver = parentPort || process;
let release;
receiver.on('message', async message => {
  if (message !== 'release') return;
  await release();
  send('released');
});
send('waiting');
acquireRefreshLock(config.databasePath).then(value => { release = value; send('acquired'); })
  .catch(() => { send('failed'); process.exitCode = 1; parentPort?.close(); process.disconnect?.(); });
