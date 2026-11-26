// Codex RPC를 중계하며 quota 기대 값과 자식 프로세스 수명 증거만 기록한다.
'use strict';

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
  // [기록 정책] 선별한 진단 데이터만 제한 권한의 파일에 쓴다.
  try { writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o600 }); }
  catch { process.exitCode = 1; }
}
save();
/**
 * 책임: 중계하는 RPC에서 검증용 정보만 관찰한다.
 * 알고리즘: UTF-8 청크를 1MiB 제한 개행 버퍼로 파싱해 소비자에 전달하고 원문 대신 프로토콜 오류 코드만 증거에 남긴다.
 */
function observe(stream, consume) {
  // [RPC 파싱 정책] UTF-8 청크 경계를 이어서 디코딩하고 개행 단위로 JSON을 소비한다.
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
  // [RPC 기록 정책] 허용 메서드와 요청 순서만 기록하고 응답 연결에 ID를 사용한다.
  if (!allowedMethods.has(message.method)) { evidence.errorCode = 'unexpected-rpc'; return; }
  evidence.methods.push(message.method);
  if (message.id != null) pending.set(message.id, message.method);
});
observe(child.stdout, message => {
  // [RPC 기록 정책] 대기 중인 요청에 대응하는 응답에서 계정 유형과 한도 기대 값만 남긴다.
  const method = pending.get(message.id);
  if (!method) return;
  pending.delete(message.id);
  if (method === 'account/read') {
    const type = message.result?.account?.type;
    evidence.accountType = ['chatgpt', 'chatgptAuthTokens', 'apiKey'].includes(type) ? type : 'other';
    return;
  }
  if (method === 'account/rateLimits/read' && message.result) {
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
  // [종료 정책] 입력을 닫고 종료 신호를 보낸 뒤 응답하지 않는 프로세스는 200ms 후 강제 종료한다.
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
