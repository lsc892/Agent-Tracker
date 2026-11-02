// quota 테스트용 Codex RPC 응답과 실패·종료 시나리오를 모사한다.
'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
const mode = process.env.QUOTA_FIXTURE_MODE || 'success';
const methods = [];
let quotaRequestId;
let clientInfo;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const limits = used => ({ rateLimits: { limitId: 'codex', primary: {
  usedPercent: used, windowDurationMins: 90, resetsAt: 1700000000,
}, secondary: null, rateLimitReachedType: null } });
const keepAlive = setInterval(() => {}, 1000);
if (mode === 'ignore-end') process.on('SIGTERM', () => {});
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const message = JSON.parse(line);
  methods.push(message.method || 'client-response');
  if (message.method === 'initialize') clientInfo = message.params.clientInfo;
  if (process.env.QUOTA_FIXTURE_LOG) fs.writeFileSync(process.env.QUOTA_FIXTURE_LOG, JSON.stringify({ methods, pid: process.pid, dataHome: process.env.CODEX_HOME, clientInfo }));
  if (mode === 'stall') return;
  if (mode === 'exit') process.exit(7);
  if (mode === 'malformed') { process.stdout.write('not-json\n'); return; }
  if (mode === 'oversize') { process.stdout.write('x'.repeat(1100000)); return; }
  if (message.method === 'initialize') {
    if (mode === 'server-messages') send({ method: 'account/rateLimits/updated', params: limits(99) });
    send({ id: message.id, result: { userAgent: 'fixture' } });
  }
  else if (message.method === 'account/read') send({ id: message.id, result: { account: mode === 'api-key' ? { type: 'apiKey' } : mode === 'logged-out' ? null : { type: 'chatgpt' } } });
  else if (message.method === 'account/rateLimits/read') {
    if (mode === 'server-messages') {
      quotaRequestId = message.id;
      send({ method: 'unrelated/updated', params: limits(98) });
      send({ id: 999, result: limits(97) });
      send({ id: 'server-request', method: 'account/rateLimits/updated', params: limits(96) });
      return;
    }
    if (mode === 'rpc-error') send({ id: message.id, error: {
      ...(process.env.QUOTA_FIXTURE_RPC_ERROR ? JSON.parse(process.env.QUOTA_FIXTURE_RPC_ERROR) : { code: 429 }),
      message: 'secret-token-must-not-escape',
    } });
    else {
      if (mode === 'notification') send({ method: 'account/rateLimits/updated', params: limits(42) });
      send({ id: message.id, result: { ...limits(43), rateLimitResetCredits: { availableCount: 2, credits: [
        { resetType: 'codexRateLimits', status: 'available', expiresAt: 1700600000 },
      ] } } });
    }
  }
  else if (mode === 'server-messages' && message.id === 'server-request') {
    if (message.error?.code !== -32601) process.exit(8);
    send({ method: 'account/rateLimits/updated', params: limits(42) });
    send({ id: quotaRequestId, result: limits(43) });
  }
});
process.stdin.on('end', () => {
  if (mode === 'ignore-end') return;
  clearInterval(keepAlive);
  process.exit(0);
});
