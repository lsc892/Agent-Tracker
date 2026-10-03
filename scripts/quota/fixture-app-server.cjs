'use strict';
const { createInterface } = require('node:readline');
const { writeFileSync } = require('node:fs');
const mode = process.env.QUOTA_BENCHMARK_MODE || 'success';
// A deliberate resident allocation and response delay make sampler smoke checks reproducible.
globalThis.quotaBenchmarkAllocation = Buffer.alloc(16 * 1024 * 1024, 0xa5);
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const keepAlive = setInterval(() => {}, 1000);
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') setTimeout(() => send({ id: request.id, result: { userAgent: 'synthetic-benchmark' } }), 50);
  else if (request.method === 'account/read') send({ id: request.id, result: { account: { type: 'chatgpt' } } });
  else if (request.method === 'account/rateLimits/read') {
    if (mode === 'timeout' || mode === 'cancel') return;
    setTimeout(() => {
      if (mode === 'error') send({ id: request.id, error: { code: -32000, message: 'benchmark-private-canary' } });
      else send({ id: request.id, result: { rateLimits: {
        primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1700000000 }, secondary: null,
      } } });
    }, 250);
  }
});
process.stdin.on('end', () => {
  const resources = process.resourceUsage();
  const cpu = process.cpuUsage();
  if (process.env.QUOTA_BENCHMARK_RESOURCE_FILE) {
    writeFileSync(process.env.QUOTA_BENCHMARK_RESOURCE_FILE, JSON.stringify({
      lifetimeMaxRssBytes: resources.maxRSS > 0 ? resources.maxRSS * 1024 : null,
      cpuTotalMs: (cpu.user + cpu.system) / 1000,
    }));
  }
  clearInterval(keepAlive);
  process.exit(0);
});
