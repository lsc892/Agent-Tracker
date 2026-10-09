'use strict';

// Transparent stdio observer: only quota fields and lifecycle evidence leave memory.
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const { expectedCodex } = require('./contract.cjs');

const [executable, evidencePath, ...args] = process.argv.slice(2);
const evidence = { methods: [], accountType: null, expected: null, nativePid: null, nativeExitConfirmed: false, errorCode: null };
const pending = new Map();
const allowedMethods = new Set(['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
evidence.nativePid = child.pid ?? null;
function save() {
  try { writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o600 }); }
  catch { process.exitCode = 1; }
}
save();
function observe(stream, consume) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  stream.on('data', chunk => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 1_048_576) { evidence.errorCode = 'reference-protocol'; buffer = ''; return; }
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try { consume(JSON.parse(line)); }
      catch { evidence.errorCode = 'reference-protocol'; }
    }
  });
}
observe(process.stdin, message => {
  if (allowedMethods.has(message.method)) {
    evidence.methods.push(message.method);
    if (message.id != null) pending.set(message.id, message.method);
  } else evidence.errorCode = 'unexpected-rpc';
});
observe(child.stdout, message => {
  const method = pending.get(message.id);
  if (!method) return;
  pending.delete(message.id);
  if (method === 'account/read') {
    const type = message.result?.account?.type;
    evidence.accountType = ['chatgpt', 'chatgptAuthTokens', 'apiKey'].includes(type) ? type : 'other';
  } else if (method === 'account/rateLimits/read' && message.result) {
    evidence.expected = expectedCodex(message.result);
  }
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.resume();
child.stdin.on('error', () => {});
process.stdout.on('error', () => stop());
child.on('error', () => { evidence.errorCode = 'process'; save(); process.exitCode = 1; process.stdin.destroy(); });
let killTimer;
function stop() {
  process.stdin.unpipe(child.stdin);
  child.stdin.end();
  child.kill('SIGTERM');
  killTimer ??= setTimeout(() => child.kill('SIGKILL'), 200);
  killTimer.unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('close', (code) => {
  clearTimeout(killTimer);
  evidence.nativeExitConfirmed = true;
  save();
  process.stdin.destroy();
  process.exitCode = code === null ? 0 : code;
});
