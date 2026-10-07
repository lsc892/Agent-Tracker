'use strict';
const { readFile } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const intervalMs = Number(process.argv[2]) || 50;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const rl = createInterface({ input: process.stdin });
send({ event: 'ready', method: process.platform === 'linux' ? 'linux-proc-status' : 'posix-ps-rss' });
rl.once('line', async line => {
  const target = Number(line);
  if (!Number.isSafeInteger(target) || target <= 0) { rl.close(); return; }
  const start = performance.now();
  while (true) {
    try {
      let rssBytes;
      let osPeakRssBytes = null;
      if (process.platform === 'linux') {
        const status = await readFile(`/proc/${target}/status`, 'utf8');
        const resident = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
        const peak = status.match(/^VmHWM:\s+(\d+)\s+kB$/m);
        if (!resident) break;
        rssBytes = Number(resident[1]) * 1024;
        osPeakRssBytes = peak ? Number(peak[1]) * 1024 : null;
      } else {
        const rss = await new Promise((resolve, reject) => execFile('/bin/ps', ['-o', 'rss=', '-p', String(target)],
          { timeout: 1000, maxBuffer: 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
        if (!/^\s*\d+\s*$/.test(rss)) break;
        rssBytes = Number(rss.trim()) * 1024;
      }
      send({ event: 'sample', offsetMs: performance.now() - start, rssBytes, osPeakRssBytes, cpuMs: null });
    } catch { break; }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  send({ event: 'ended' });
  rl.close();
  process.stdin.destroy();
});
