// 결정적 실제 parser 입력을 생성하고 개인 원본의 고정 사본만 준비한다.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdir, writeFile, readFile, copyFile, stat, utimes } = require('node:fs/promises');
const { join, dirname, relative } = require('node:path');
const { makeSnapshot } = require('./incremental-refresh.cjs');

const sha = value => createHash('sha256').update(value).digest('hex');
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const fixedMtime = new Date('2026-10-01T00:00:00Z');

function requestRows(provider, session, project, ordinal, index) {
  const request = `request-${index}`;
  // 각 프로젝트·제공자 안에서 세 달을 섞고 월/일 경계도 포함한다.
  const start = Date.UTC(2026, 6 + (ordinal * 7 + index) % 3, 1 + (ordinal * 13 + index) % 28,
    (ordinal + index) % 24, index % 60);
  const input = 100 + (ordinal * 17 + index) % 900, output = 10 + index % 40;
  const time = ms => new Date(start + ms).toISOString();
  const models = provider === 'codex' ? ['gpt-5.6-sol', 'gpt-5.6-luna'] : ['claude-sonnet-4-6', 'claude-opus-4-6'];
  const parts = (ordinal + index) % 11 === 0 ? [Math.floor(input / 2), input - Math.floor(input / 2)] : [input];
  const rows = [];
  if (provider === 'codex') {
    rows.push({ type: 'event_msg', timestamp: time(0), payload: { type: 'task_started', turn_id: request, root_turn_id: request } });
    for (const [part, value] of parts.entries()) rows.push(
      { type: 'turn_context', payload: { turn_id: request, model: models[(ordinal + index + part) % 2] } },
      { type: 'token_usage_record', timestamp: time(1000 + part), payload: { turn_id: request, root_turn_id: request,
        response_id: `response-${index}-${part}`, usage: { input_tokens: value, output_tokens: part ? 0 : output } } });
    rows.push({ type: 'event_msg', timestamp: time(2000), payload: { type: 'task_complete', turn_id: request } });
  } else {
    rows.push({ type: 'user', sessionId: session, promptId: request, cwd: project, timestamp: time(0), message: { content: 'Benchmark request' } });
    for (const [part, value] of parts.entries()) rows.push({ type: 'assistant', promptId: request, requestId: `response-${index}-${part}`,
      timestamp: time(2000), message: { id: `message-${index}-${part}`, model: models[(ordinal + index + part) % 2], stop_reason: 'end_turn',
        usage: { input_tokens: value, output_tokens: part ? 0 : output } } });
  }
  return { rows, tokens: input + output };
}

function sessionText(record, requests) {
  const rows = record.provider === 'codex'
    ? [{ type: 'session_meta', payload: { id: record.session, cwd: record.project } }] : [];
  let tokens = 0;
  for (let i = 0; i < requests; i++) {
    const request = requestRows(record.provider, record.session, record.project, record.ordinal, i);
    rows.push(...request.rows); tokens += request.tokens;
  }
  return { text: jsonl(rows), tokens };
}

async function synthetic(directory, projects, perProject, longTurns = 1) {
  const roots = ['claude', 'codex'].map(provider => ({ provider, path: join(directory, provider), dataHome: join(directory, `${provider}-home`) }));
  for (const root of roots) await mkdir(root.path, { recursive: true });
  const files = [];
  let tokens = 0, requests = 0;
  for (let p = 0; p < projects; p++) for (let s = 0; s < perProject; s++) {
    const ordinal = p * perProject + s, root = roots[(p + s) % 2];
    const record = { provider: root.provider, session: `fixture-${p}-${s}`, project: `/benchmark/project-${p}`, ordinal,
      path: join(root.path, `session-${String(ordinal).padStart(6, '0')}.jsonl`), root };
    const count = ordinal === 0 ? longTurns : 1, value = sessionText(record, count);
    await writeFile(record.path, value.text); await utimes(record.path, fixedMtime, fixedMtime);
    files.push({ ...record, bytes: Buffer.byteLength(value.text), sha256: sha(value.text), requests: count });
    tokens += value.tokens; requests += count;
  }
  return { roots, files, expected: { projects, sessions: projects * perProject, requests, tokens }, longTurns };
}

async function realSnapshot(directory) {
  const snapshot = await makeSnapshot(directory, { after: join(__dirname, '../..'), real: true, requests: 0 });
  for (const file of snapshot.files) {
    file.root = snapshot.roots.find(root => file.path.startsWith(root.path + require('node:path').sep));
    file.provider = file.root.provider;
  }
  return snapshot;
}

async function deltaSnapshot(directory, snapshot, count = 300) {
  const chosen = snapshot.files.slice(0, count);
  assert.equal(chosen.length, count);
  const roots = [], files = [];
  for (const [ordinal, file] of chosen.entries()) {
    const bucket = ordinal < count - 50 ? 'base' : 'delta';
    const rootKey = snapshot.roots.indexOf(file.root);
    const path = join(directory, bucket, String(rootKey));
    let root = roots.find(r => r.path === path);
    if (!root) {
      root = { ...file.root, path }; roots.push(root);
    }
    const target = join(path, relative(file.root.path, file.path));
    await mkdir(dirname(target), { recursive: true }); await copyFile(file.path, target);
    const info = await stat(file.path); await utimes(target, info.atime, info.mtime);
    files.push({ ...file, path: target, root });
  }
  return { roots, baseRoots: roots.filter(r => r.path.includes(`${require('node:path').sep}base${require('node:path').sep}`)), files };
}

async function fingerprint(snapshot) {
  const hash = createHash('sha256'); let bytes = 0;
  for (const [ordinal, file] of snapshot.files.entries()) {
    const buffer = await readFile(file.path), digest = sha(buffer);
    assert.equal(digest, file.sha256, 'Frozen transcript changed');
    hash.update(JSON.stringify([ordinal, file.provider, digest, buffer.length])); bytes += buffer.length;
  }
  return { sha256: hash.digest('hex'), files: snapshot.files.length, bytes };
}

module.exports = { synthetic, realSnapshot, deltaSnapshot, fingerprint, sessionText, fixedMtime, sha };
