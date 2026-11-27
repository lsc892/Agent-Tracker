// Waits for the desktop VS Code process to exit before applying the bundled patch.
const { setTimeout: delay } = require('node:timers/promises');
const { isRunning, lockWorkbench, prepareOperation, resolveAppRoot } = require('./statusbar-toggle.cjs');

async function main([requestedAppRoot, mainPid, expectedVersion]) {
  const pid = Number(mainPid);
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff || !requestedAppRoot || !expectedVersion) return;
  const appRoot = resolveAppRoot({ appRoot: requestedAppRoot });
  const unlock = lockWorkbench(appRoot);
  if (!unlock) return;
  try {
    const apply = prepareOperation(appRoot, { expectedVersion });
    if (typeof apply !== 'function') return;

    if (process.connected) process.send({ status: 'scheduled' }, () => {
      if (process.connected) process.disconnect();
    });
    // The running workbench still has the original checksum loaded in memory.
    while (isRunning(pid)) await delay(150);
    apply();
  } finally {
    unlock();
  }
}

main(process.argv.slice(2)).catch(error => {
  if (process.connected) process.send({ status: 'failed', reason: error.message }, () => {
    if (process.connected) process.disconnect();
  });
  process.exitCode = 1;
});
