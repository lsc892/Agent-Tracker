// 빌드된 두 워크트리에서 같은 로그 사본의 실제 갱신·저장·조회 시간과 결과를 비교한다.
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, statSync } = require('node:fs');
const { appendFile, mkdir, mkdtemp, open, readdir, lstat, readFile, rm, truncate, utimes, writeFile } = require('node:fs/promises');
const { tmpdir, cpus } = require('node:os');
const { basename, dirname, join, relative, resolve, sep } = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const { zstdCompressSync } = require('node:zlib');

const scenarios = ['initial', 'unchanged', 'reparse-same', 'codex-append', 'claude-append', 'codex-extend'];
const variants = ['before', 'after'];
const sha = value => createHash('sha256').update(value).digest('hex');
const seoulTime = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

function inside(directory, path) {
  const resolved = resolve(path), parent = resolve(directory);
  assert.ok(resolved.startsWith(parent + sep), 'Operation must stay inside the benchmark workspace');
  return resolved;
}

async function* transcripts(directory) {
  if (!existsSync(directory)) return;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* transcripts(path);
    else if (entry.isFile() && /\.jsonl(?:\.zst)?$/i.test(entry.name)) yield path;
  }
}

async function freezeFile(source, target) {
  await mkdir(dirname(target), { recursive: true });
  const input = await open(source, 'r');
  let output;
  try {
    const before = await input.stat();
    assert.ok(before.isFile());
    output = await open(target, 'wx');
    const buffer = Buffer.alloc(64 * 1024), digest = createHash('sha256');
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      assert.ok(bytesRead > 0, 'Source shrank while freezing input');
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written, position + written)).bytesWritten;
      position += bytesRead;
    }
    const after = await input.stat();
    assert.ok(after.size >= before.size && (after.size > before.size || after.mtimeMs === before.mtimeMs), 'Source was rewritten while freezing input');
    await output.close(); output = undefined;
    await utimes(target, before.atime, before.mtime);
    return { bytes: position, sha256: digest.digest('hex') };
  } finally { await output?.close(); await input.close(); }
}

async function freezeNames(sourceHome, targetHome) {
  await mkdir(targetHome, { recursive: true });
  let indexBytes = 0, threads = 0;
  const index = join(sourceHome, 'session_index.jsonl');
  if (existsSync(index)) indexBytes = (await freezeFile(index, join(targetHome, 'session_index.jsonl'))).bytes;
  const names = existsSync(sourceHome) ? await readdir(sourceHome) : [];
  const state = names.filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  if (state && !(await lstat(join(sourceHome, state))).isSymbolicLink()) {
    const input = new DatabaseSync(join(sourceHome, state), { readOnly: true });
    let output;
    try {
      input.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');
      const columns = input.prepare('PRAGMA table_info(threads)').all().map(row => row.name);
      if (columns.includes('id') && columns.includes('title')) {
        output = new DatabaseSync(join(targetHome, state));
        output.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT); BEGIN');
        const insert = output.prepare('INSERT INTO threads VALUES (?,?,?)');
        for (const row of input.prepare(`SELECT id,title,${columns.includes('name') ? 'name' : 'NULL'} AS name FROM threads`).iterate()) {
          insert.run(row.id, row.title, row.name); threads++;
        }
        output.exec('COMMIT');
      }
      input.exec('COMMIT');
    } finally { output?.close(); input.close(); }
  }
  return { indexBytes, threads };
}

function codexRows(root, response, input = 123) {
  return [
    { type: 'event_msg', timestamp: '2026-10-28T12:00:00Z', payload: { type: 'task_started', turn_id: root, root_turn_id: root } },
    { type: 'turn_context', payload: { turn_id: root, model: 'gpt-5.6-sol' } },
    { type: 'token_usage_record', timestamp: '2026-10-28T12:00:01Z', payload: { turn_id: root, root_turn_id: root, response_id: response, usage: { input_tokens: input, output_tokens: 7 } } },
    { type: 'event_msg', timestamp: '2026-10-28T12:00:02Z', payload: { type: 'task_complete', turn_id: root } },
  ];
}

function codexAppendRows(target, root, response, input = 123) {
  const rows = codexRows(root, response, input);
  if (target.format === 'legacy') {
    target.highWater.input += input; target.highWater.output += 7;
    const total = { input_tokens: target.highWater.input, output_tokens: target.highWater.output,
      cached_input_tokens: target.highWater.cacheRead, cache_write_input_tokens: target.highWater.cacheWrite,
      reasoning_output_tokens: target.highWater.reasoning };
    rows[2] = { type: 'event_msg', timestamp: '2026-10-28T12:00:01Z', payload: { type: 'token_count',
      info: { total_token_usage: total, last_token_usage: { input_tokens: input, output_tokens: 7 } } } };
  }
  return rows;
}

async function inspectCodexTarget(target, product) {
  const { readJsonl } = require(join(product, 'dist/src/summary/jsonl'));
  const { codexTokens } = require(join(product, 'dist/src/summary/parsers/common'));
  let current = false;
  const highWater = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const result = await readJsonl(target.path, target.originalBytes, row => {
    if (row.type === 'token_usage_record') current = true;
    const raw = row.type === 'event_msg' && row.payload?.type === 'token_count' ? row.payload?.info?.total_token_usage : undefined;
    if (raw) {
      const total = codexTokens(raw);
      for (const key of Object.keys(highWater)) highWater[key] = Math.max(highWater[key], total[key]);
    }
  });
  assert.equal(result.partialLine, false, 'Append target must end at a complete JSONL record');
  Object.assign(target, { format: current ? 'current' : 'legacy', highWater });
}

function claudeRows(session) {
  return [
    { type: 'user', sessionId: session, promptId: 'benchmark-incremental-claude', cwd: '/benchmark/project', timestamp: '2026-10-28T12:00:00Z', message: { content: 'Benchmark request' } },
    { type: 'assistant', promptId: 'benchmark-incremental-claude', requestId: 'benchmark-incremental-response', timestamp: '2026-10-28T12:00:02Z',
      message: { id: 'benchmark-incremental-message', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', usage: { input_tokens: 123, output_tokens: 7 } } },
  ];
}

async function generateSynthetic(directory, requests, turnsPerSession, referenceMs) {
  assert.equal(requests % (2 * turnsPerSession), 0, 'Synthetic requests must divide equally between providers and complete sessions');
  const fixture = join(directory, 'synthetic');
  const roots = ['claude', 'codex'].map(provider => ({ provider, path: join(fixture, provider), dataHome: join(fixture, `${provider}-home`) }));
  for (const root of roots) await mkdir(root.path, { recursive: true });
  let tokens = 0;
  for (let sessionIndex = 0; sessionIndex < requests / turnsPerSession; sessionIndex++) {
    const root = roots[sessionIndex % 2], session = `${root.provider}-fixture-${String(sessionIndex).padStart(6, '0')}`;
    const project = `/benchmark/project-${sessionIndex % 10}`;
    const file = await open(join(root.path, `${session}.jsonl`), 'wx');
    let buffer = root.provider === 'codex' ? jsonl([{ type: 'session_meta', payload: { id: session, cwd: project } }]) : '';
    try {
      for (let index = 0; index < turnsPerSession; index++) {
        const ordinal = sessionIndex * turnsPerSession + index, request = `fixture-request-${ordinal}`;
        const input = 100 + ordinal % 1000, output = 10 + ordinal % 50;
        const start = referenceMs === undefined
          ? Date.UTC(2026, 6, 1 + sessionIndex % 14 + Math.floor(index / 100)) + index % 100 * 3000
          : referenceMs - (1 + Math.floor(index / 2) % 30) * 86400000 + index % 100 * 3000;
        let rows;
        if (root.provider === 'codex') {
          rows = codexRows(request, `fixture-response-${ordinal}`, input);
          rows[1].payload.model = index % 2 ? 'gpt-5.6-sol' : 'gpt-5.6-luna';
          rows[2].payload.usage.output_tokens = output;
        } else {
          rows = claudeRows(session);
          rows[0].promptId = request; rows[0].cwd = project;
          rows[1].promptId = request; rows[1].requestId = `fixture-response-${ordinal}`;
          rows[1].message.id = `fixture-message-${ordinal}`;
          rows[1].message.model = index % 2 ? 'claude-sonnet-4-6' : 'claude-opus-4-6';
          rows[1].message.usage = { input_tokens: input, output_tokens: output };
        }
        for (const [rowIndex, row] of rows.entries()) row.timestamp = new Date(start + (rowIndex === rows.length - 1 ? 2000 : 0)).toISOString();
        buffer += jsonl(rows); tokens += input + output;
        if (buffer.length >= 64 * 1024) { await file.writeFile(buffer); buffer = ''; }
      }
      if (buffer) await file.writeFile(buffer);
    } finally { await file.close(); }
  }
  return { roots, expected: { requests, tokens, sessions: requests / turnsPerSession, turnsPerSession } };
}

async function makeSnapshot(directory, options) {
  const { readConfiguration } = require(join(options.after, 'dist/src/configuration'));
  let roots = readConfiguration({ get: (_key, fallback) => fallback }).roots;
  let expected;
  if (options.requests > 0) {
    ({ roots, expected } = await generateSynthetic(directory, options.requests, options['turns-per-session'], options.referenceMs));
  } else if (!options.real) {
    const fixture = join(directory, 'fixture');
    await mkdir(join(fixture, 'claude'), { recursive: true }); await mkdir(join(fixture, 'codex'));
    const claude = claudeRows('fixture-claude');
    claude[0].promptId = 'fixture-existing'; claude[1].promptId = 'fixture-existing';
    claude[1].requestId = 'fixture-response'; claude[1].message.id = 'fixture-message';
    await writeFile(join(fixture, 'claude/main.jsonl'), jsonl(claude));
    const target = { format: 'legacy', highWater: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } };
    const rows = [{ type: 'session_meta', payload: { id: 'fixture-codex', cwd: '/benchmark/project' } }, ...codexAppendRows(target, 'fixture-existing', 'fixture-response')];
    await writeFile(join(fixture, 'codex/main.jsonl.zst'), zstdCompressSync(Buffer.from(jsonl(rows))));
    roots = [{ provider: 'claude', path: join(fixture, 'claude') }, { provider: 'codex', path: join(fixture, 'codex'), dataHome: join(fixture, 'codex-home') }];
  }
  const frozen = [], inventory = [], homes = new Map(), files = [], digest = createHash('sha256');
  for (const [ordinal, source] of roots.entries()) {
    const path = join(directory, 'snapshot', `root-${ordinal}`);
    await mkdir(path, { recursive: true });
    let dataHome, metadata;
    if (source.provider === 'codex') {
      const original = resolve(source.dataHome ?? dirname(source.path));
      if (!homes.has(original)) {
        const target = join(directory, 'snapshot', `home-${ordinal}`);
        homes.set(original, { dataHome: target, metadata: await freezeNames(original, target) });
      }
      ({ dataHome, metadata } = homes.get(original));
    }
    let count = 0, bytes = 0, compressed = 0;
    for await (const file of transcripts(source.path)) {
      const name = relative(source.path, file), target = join(path, name);
      const copy = await freezeFile(file, target);
      digest.update(JSON.stringify([ordinal, name, copy])); files.push({ path: target, ...copy });
      count++; bytes += copy.bytes; if (name.endsWith('.zst')) compressed++;
    }
    frozen.push({ provider: source.provider, path, ...(dataHome ? { dataHome } : {}) });
    inventory.push({ provider: source.provider, rootOrdinal: ordinal, files: count, bytes, compressed, ...(metadata ? { metadata } : {}) });
  }
  assert.ok(files.length > 0, 'No transcript files found');
  return { roots: frozen, inventory, files, sha256: digest.digest('hex'), expected };
}

function normalized(row) {
  const result = {};
  for (const key of Object.keys(row).sort()) {
    if (['id', 'turn_id', 'updated_at', 'diagnostic_file_id', 'last_successful_update'].includes(key)) continue;
    const value = row[key];
    result[key] = typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(10)) : value;
  }
  return result;
}

function verify(db, buildUsageQuery) {
  const facts = createHash('sha256'), aggregates = createHash('sha256');
  const tables = [
    ['requests', 'SELECT * FROM turn_summary ORDER BY provider,session_id,root_turn_id'],
    ['models', 'SELECT t.provider,t.session_id,t.root_turn_id,u.* FROM turn_summary t JOIN turn_model_usage u ON u.turn_id=t.id ORDER BY t.provider,t.session_id,t.root_turn_id,u.model'],
    ['capabilities', 'SELECT t.provider,t.session_id,t.root_turn_id,u.* FROM turn_summary t JOIN turn_capability_usage u ON u.turn_id=t.id ORDER BY t.provider,t.session_id,t.root_turn_id,u.category,u.name'],
    ['costs', 'SELECT t.provider,t.session_id,t.root_turn_id,u.* FROM turn_summary t JOIN turn_costs u ON u.turn_id=t.id ORDER BY t.provider,t.session_id,t.root_turn_id'],
    ['projects', 'SELECT * FROM projects ORDER BY project_key'],
    ['sessions', 'SELECT * FROM sessions ORDER BY provider,session_id'],
    ['diagnostics', 'SELECT provider,session_id,size_bytes,parser_version,processing_status,last_error,source_missing,content_hash FROM manifest ORDER BY provider,path'],
  ];
  for (const [name, sql] of tables) {
    facts.update(name);
    for (const row of db.connection.prepare(sql).iterate()) facts.update(JSON.stringify(normalized(row)));
  }
  let rawChecks = 0;
  for (const by of ['provider', 'model']) for (const group of ['total', 'project', 'session', 'day', 'month']) {
    const query = buildUsageQuery({}, group, 'Asia/Seoul', by);
    const expected = db.connection.prepare(query.sql).all(...query.values, 10000000, 0).map(normalized);
    const actual = [];
    for (let offset = 0; ; offset += 1000) {
      const page = db.queryUsagePage({}, group, 'Asia/Seoul', { offset, limit: 1000 }, by);
      actual.push(...page.rows.map(normalized));
      assert.equal(page.total, expected.length);
      if (page.rows.length < 1000) break;
    }
    assert.deepEqual(actual, expected, `Raw/rollup mismatch for ${by}/${group}`);
    aggregates.update(JSON.stringify([by, group, actual])); rawChecks++;
  }
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  return { factsSha256: facts.digest('hex'), aggregatesSha256: aggregates.digest('hex'), rawChecks };
}

function chooseTarget(db, provider, directory) {
  const rows = db.connection.prepare(`SELECT m.path,m.session_id,
    (SELECT count(*) FROM turn_summary t WHERE t.provider=m.provider AND t.session_id=m.session_id) AS requests
    FROM manifest m
    WHERE m.provider=? AND m.processing_status='done' AND m.source_missing=0
      AND json_extract(m.source_identity,'$[1]')=1 AND json_extract(m.source_identity,'$[0]')=m.session_id
      AND EXISTS(SELECT 1 FROM turn_summary t WHERE t.provider=m.provider AND t.session_id=m.session_id)
    ORDER BY requests DESC,m.path`).all(provider);
  assert.ok(rows.length, `No accepted source for ${provider}`);
  const target = rows[0]; inside(directory, target.path);
  const stat = statSync(target.path);
  return { ...target, originalBytes: stat.size, originalAtime: stat.atime, originalMtime: stat.mtime };
}

async function appendRows(target, rows, directory, ordinal) {
  inside(directory, target.path);
  const text = Buffer.from(jsonl(rows));
  const bytes = target.path.endsWith('.zst') ? zstdCompressSync(text) : text;
  await appendFile(target.path, bytes);
  const time = new Date(Date.UTC(2026, 9, 29, 0, 0, ordinal));
  await utimes(target.path, time, time);
}

async function worker(configPath, variant, pairText, trialPath) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const product = config[variant];
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { SummaryStaging } = require(join(product, 'dist/src/summary/staging'));
  const { refreshSummary, PARSER_VERSION } = require(join(product, 'dist/src/summary/scanner'));
  const { SCHEMA_VERSION } = require(join(product, 'dist/src/summary/db/schema'));
  const { buildUsageQuery } = require(join(product, 'dist/src/summary/db/queries'));
  await mkdir(trialPath, { recursive: true });
  const dbPath = join(trialPath, 'summary.sqlite'), db = new SummaryDatabase(dbPath), targets = [];
  const samples = [];
  let prepareMs = 0, replaceMs = 0, replacements = 0, currentScenario;
  const originalPrepare = SummaryStaging.prototype.prepareSummaries, originalReplace = db.replaceSessions;
  SummaryStaging.prototype.prepareSummaries = function(...args) {
    const start = performance.now();
    try { return Reflect.apply(originalPrepare, this, args); } finally { prepareMs += performance.now() - start; }
  };
  db.replaceSessions = function(...args) {
    const start = performance.now(); replacements++;
    try { return Reflect.apply(originalReplace, this, args); } finally { replaceMs += performance.now() - start; }
  };
  try {
    for (const [ordinal, scenario] of scenarios.entries()) {
      currentScenario = scenario;
      if (scenario === 'reparse-same') db.connection.exec('UPDATE manifest SET parser_version=0');
      if (scenario === 'codex-append') {
        const target = chooseTarget(db, 'codex', config.directory); targets.push(target);
        await inspectCodexTarget(target, product);
        await appendRows(target, codexAppendRows(target, 'benchmark-incremental-codex', 'benchmark-codex-response'), config.directory, ordinal);
      }
      if (scenario === 'claude-append') {
        const target = chooseTarget(db, 'claude', config.directory); targets.push(target);
        const rows = claudeRows(target.session_id);
        // The appended request retains the real session's project rather than moving it.
        rows[0].cwd = db.connection.prepare('SELECT project_key FROM turn_summary WHERE provider=? AND session_id=? LIMIT 1').get('claude', target.session_id).project_key;
        await appendRows(target, rows, config.directory, ordinal);
      }
      if (scenario === 'codex-extend') await appendRows(targets[0], codexAppendRows(targets[0], 'benchmark-incremental-codex', 'benchmark-codex-extension', 19), config.directory, ordinal);
      db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      prepareMs = 0; replaceMs = 0; replacements = 0;
      const cpuStart = process.cpuUsage(), start = performance.now();
      let phase;
      const result = await refreshSummary(db, { dbPath, roots: config.roots }, undefined, progress => {
        if (progress.phase !== phase) { phase = progress.phase; process.send({ kind: 'progress', pair: Number(pairText), variant, scenario, phase }); }
      });
      const refreshMs = performance.now() - start, queryStart = performance.now();
      const page = db.queryUsagePage({}, 'month', 'Asia/Seoul', { limit: 100 }, 'provider');
      const queryMs = performance.now() - queryStart, elapsedMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
      const walBytes = existsSync(dbPath + '-wal') ? statSync(dbPath + '-wal').size : 0;
      assert.equal(result.interrupted, false); assert.equal(result.error, undefined);
      if (scenario === 'unchanged') { assert.equal(result.bodyBytes, 0); assert.equal(prepareMs, 0); assert.equal(replacements, 0); }
      const totals = db.connection.prepare('SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens FROM turn_summary').get();
      if (scenario === 'initial' && config.expected) {
        assert.equal(result.failed, 0);
        assert.equal(totals.requests, config.expected.requests);
        assert.equal(totals.tokens, config.expected.tokens);
      }
      if (scenario === 'codex-append' || scenario === 'claude-append') {
        assert.equal(totals.requests, samples.at(-1).requests + 1, `New request not collected: ${scenario}`);
        assert.equal(totals.tokens, samples.at(-1).tokens + 130);
      }
      if (scenario === 'codex-extend') {
        assert.equal(totals.requests, samples.at(-1).requests);
        assert.equal(totals.tokens, samples.at(-1).tokens + 26);
      }
      const checked = verify(db, buildUsageQuery);
      const sample = { scenario, variant, pair: Number(pairText), elapsedMs, refreshMs, queryMs, prepareMs, replaceMs, replacements,
        cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, walBytes,
        parsed: result.parsed, reused: result.reused, discovered: result.discovered, failed: result.failed, bodyBytes: result.bodyBytes,
        pageRows: page.rows.length, ...totals, ...checked, rssBytes: process.memoryUsage().rss,
        targetRequests: scenario.endsWith('append') ? targets.at(-1).requests : undefined };
      samples.push(sample); process.send({ kind: 'sample', sample });
    }
    process.send({ kind: 'result', samples, sqlite: db.connection.prepare('SELECT sqlite_version() version').get().version,
      schema: SCHEMA_VERSION, parser: PARSER_VERSION });
  } catch (error) {
    process.send({ kind: 'failure', scenario: currentScenario, code: error.code ?? error.name,
      message: String(error.message).split('\n')[0].slice(0, 160),
      actual: typeof error.actual === 'number' ? error.actual : undefined,
      expected: typeof error.expected === 'number' ? error.expected : undefined,
      runnerLine: String(error.stack).split('\n').find(line => line.includes(__filename))?.match(/:(\d+):\d+\)/)?.[1] });
    throw error;
  } finally {
    SummaryStaging.prototype.prepareSummaries = originalPrepare;
    db.close();
    for (const target of targets) {
      await truncate(inside(config.directory, target.path), target.originalBytes);
      await utimes(target.path, target.originalAtime, target.originalMtime);
    }
  }
}

function runWorker(configPath, variant, pair, trialPath) {
  return new Promise((resolveWorker, reject) => {
    const child = fork(__filename, ['--worker', configPath, variant, String(pair), trialPath], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    let result, failure;
    child.on('message', message => {
      if (message.kind === 'result') result = message;
      if (message.kind === 'failure') { failure = message; console.log(JSON.stringify(message)); }
      if (message.kind === 'sample') {
        const row = message.sample;
        console.log(`${pair < 0 ? 'warmup' : `pair ${pair + 1}`} ${variant} ${row.scenario}: total=${row.elapsedMs.toFixed(1)} ms, store=${row.replaceMs.toFixed(1)} ms, parsed=${row.parsed}, failed=${row.failed}`);
      }
      if (message.kind === 'progress' && message.phase === 'parsing') console.log(`${pair < 0 ? 'warmup' : `pair ${pair + 1}`} ${variant} ${message.scenario}: parsing`);
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 && result ? resolveWorker(result) : reject(new Error(`Worker failed (${code}): ${failure?.scenario ?? 'unknown stage'}`)));
  });
}

const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2; };
function stats(values) { return { median: median(values), min: Math.min(...values), max: Math.max(...values) }; }

function markdown(report, path) {
  const rows = report.summary.map(row => `| ${row.scenario} | ${row.before.elapsedMs.median.toFixed(3)} | ${row.after.elapsedMs.median.toFixed(3)} | ${row.changePercent.toFixed(1)}% | ${row.before.replaceMs.median.toFixed(3)} → ${row.after.replaceMs.median.toFixed(3)} | ${row.fasterPairs}/${report.pairs} |`);
  return `# 증분 저장 전후: 실제 로그의 워크트리 집계 비교\n\n측정: ${report.startedAtSeoul} ~ ${report.completedAtSeoul}, Asia/Seoul.\n\n- 전: \`${report.revisions.before}\`, 후: \`${report.revisions.after}\`. 별도 워크트리에서 같은 의존성으로 빌드했다.\n- 실제 대화 고정 사본 ${report.inventory.reduce((sum, row) => sum + row.files, 0)}개, ${report.inventory.reduce((sum, row) => sum + row.bytes, 0)} bytes. 압축 로그를 포함한다.\n- 순차 실행 ${report.pairs}쌍, AB/BA 순서 교대. 워밍업 ${report.warmups}쌍 제외. 각 프로세스는 새 DB에서 여섯 시나리오를 순서대로 수행한다. OS 파일 캐시는 비우지 않았다.\n- 전체 시간은 실제 refreshSummary와 월별 첫 100행+COUNT 조회까지다. 저장 시간은 그 안의 실제 replaceSessions 호출 합계이며 집계 준비·원본 파싱과 구분한다. 초기 조회에는 최초 일별 집계 구축이 포함된다.\n- reparse-same은 원본을 바꾸지 않고 manifest의 parser_version만 0으로 만들어 전체 재파싱한다. append/extend는 실제 세션 사본에 정해진 시험용 요청·응답을 추가한다. 원본 대화·사용 중인 DB·credential은 변경하지 않는다.\n- 검증·해시·checkpoint·입력 변경은 타이머 밖이다. 매 단계 검증은 양쪽 모두 같으며 다음 단계 캐시에 영향을 줄 수 있다.\n\n| 시나리오 | 전 전체 ms | 후 전체 ms | 전체 증감 | DB 저장 ms: 전 → 후 | 후가 빠른 쌍 |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n\n음수면 개선이다. 비율은 중앙값끼리 비교한 값이며 개별 쌍·범위·파싱/읽기량·WAL·메모리는 [원시 JSON](${basename(path, '.md')}.json)에 보존한다.\n\n## 정확성\n\n모든 전후 및 반복 표본에서 요청·모델·Skill·비용·이름·파일 진단의 의미 해시와 전체/프로젝트/세션/일/월 집계 해시를 비교했다. 각 상태에서 raw SQL과 ${report.rawChecks}개 집계를 대조했고 FK 및 integrity 검사를 통과했다. 물리 ID·요청 갱신 시각·집계 최종 갱신 시각은 구현 의도에 따라 달라져 해시에서 제외한다. 비정수 비교만 유효숫자 10자리로 정규화하며 저장 값은 변경하지 않는다.\n\n원본 snapshot SHA-256은 모든 실행 종료 후 다시 확인했다. 개인 본문·제목·세션 ID·경로는 보고서에 저장하지 않는다. 실패한 원본 파일은 양쪽의 동일한 오류 수·진단 해시로 비교하며 오류 수는 JSON에 남긴다. UI·IPC·quota 조회는 측정하지 않았다. RSS는 검증 이후 프로세스 관측값으로 SQLite만의 메모리나 고정 상한이 아니다.\n\n## 재실행\n\n\`node tests/benchmarks/incremental-refresh.cjs --before=<빌드된 이전 워크트리> --after=<빌드된 이후 워크트리> --real --pairs=${report.pairs} --warmups=${report.warmups} --report=<새 Markdown 경로>\`\n\n--real을 생략하면 작은 Claude·압축 Codex fixture로 검증한다. 기존 보고서를 덮어쓰지 않으며 원본 사본과 실험 DB는 종료 후 삭제한다.\n`;
}

async function main() {
  const options = { pairs: 3, warmups: 1, real: false, requests: 0, 'turns-per-session': 100,
    before: '', after: '', report: resolve('tests/results/benchmarks/incremental-refresh.md') };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--real') { options.real = true; continue; }
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    assert.ok(match && Object.hasOwn(options, match[1]), 'Unknown or incomplete benchmark option');
    options[match[1]] = ['pairs', 'warmups', 'requests', 'turns-per-session'].includes(match[1]) ? Number(match[2]) : resolve(match[2]);
  }
  assert.ok(Number.isSafeInteger(options.pairs) && options.pairs >= 1 && options.pairs <= 20);
  assert.ok(Number.isSafeInteger(options.warmups) && options.warmups >= 0 && options.warmups <= 2);
  assert.ok(Number.isSafeInteger(options.requests) && options.requests >= 0 && options.requests <= 1000000);
  assert.ok(Number.isSafeInteger(options['turns-per-session']) && options['turns-per-session'] >= 1 && options['turns-per-session'] <= 100000);
  assert.ok(!options.real || options.requests === 0, 'Choose real transcripts or generated requests');
  for (const variant of variants) assert.ok(options[variant] && existsSync(join(options[variant], 'dist/src/summary/scanner.js')), 'Build both worktrees first');
  const jsonPath = options.report.replace(/\.md$/, '') + '.json';
  assert.ok(!existsSync(options.report) && !existsSync(jsonPath), 'Report already exists');
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-incremental-refresh-'));
  const startedAtSeoul = seoulTime();
  try {
    const snapshot = await makeSnapshot(directory, options);
    console.log(`Frozen input: ${snapshot.files.length} files, ${snapshot.inventory.reduce((sum, row) => sum + row.bytes, 0)} bytes`);
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ ...options, directory, roots: snapshot.roots, expected: snapshot.expected }));
    const trials = [];
    for (let pair = -options.warmups; pair < options.pairs; pair++) {
      const order = pair >= 0 && pair % 2 ? [...variants].reverse() : variants;
      const pairResults = [];
      for (const variant of order) pairResults.push(await runWorker(configPath, variant, pair, join(directory, `pair-${pair}`, variant)));
      for (const scenario of scenarios) {
        const rows = pairResults.map(result => result.samples.find(row => row.scenario === scenario));
        for (const key of ['factsSha256', 'aggregatesSha256', 'parsed', 'failed', 'bodyBytes', 'requests', 'tokens']) {
          assert.equal(rows[0][key], rows[1][key], `Before/after mismatch: ${scenario}/${key}`);
        }
      }
      if (pair >= 0) trials.push(...pairResults);
    }
    for (const file of snapshot.files) {
      const stream = require('node:fs').createReadStream(file.path), digest = createHash('sha256');
      for await (const chunk of stream) digest.update(chunk);
      assert.equal(digest.digest('hex'), file.sha256, 'Frozen source was not restored');
    }
    const samples = trials.flatMap(trial => trial.samples);
    const summary = scenarios.map(scenario => {
      const result = { scenario };
      for (const variant of variants) {
        const rows = samples.filter(row => row.scenario === scenario && row.variant === variant);
        result[variant] = Object.fromEntries(['elapsedMs', 'refreshMs', 'queryMs', 'prepareMs', 'replaceMs', 'walBytes', 'rssBytes'].map(key => [key, stats(rows.map(row => row[key]))]));
      }
      result.changePercent = (result.after.elapsedMs.median / result.before.elapsedMs.median - 1) * 100;
      result.fasterPairs = 0;
      for (let pair = 0; pair < options.pairs; pair++) {
        const rows = samples.filter(row => row.scenario === scenario && row.pair === pair);
        if (rows.find(row => row.variant === 'after').elapsedMs < rows.find(row => row.variant === 'before').elapsedMs) result.fasterPairs++;
      }
      for (const key of ['factsSha256', 'aggregatesSha256']) assert.equal(new Set(samples.filter(row => row.scenario === scenario).map(row => row[key])).size, 1, `Across-pair mismatch: ${scenario}/${key}`);
      return result;
    });
    const git = (variant, ...args) => execFileSync('git', ['-C', options[variant], ...args], { encoding: 'utf8', windowsHide: true }).trim();
    const sourcePaths = ['src/summary/scanner.ts', 'src/summary/staging.ts', 'src/summary/db/sessions.ts', 'src/summary/db/rollups.ts', 'src/summary/db/billing.ts', 'package-lock.json', 'dist/src/summary/db/sessions.js', 'dist/src/summary/db/rollups.js'];
    const report = { startedAtSeoul, completedAtSeoul: seoulTime(), input: options.real ? 'real' : options.requests ? 'synthetic' : 'fixture', pairs: options.pairs, warmups: options.warmups,
      revisions: Object.fromEntries(variants.map(variant => [variant, git(variant, 'rev-parse', 'HEAD')])),
      sources: Object.fromEntries(variants.map(variant => [variant, Object.fromEntries(sourcePaths.map(path => [path, sha(readFileSync(join(options[variant], path)))]))])),
      runnerSha256: sha(readFileSync(__filename)), environment: { node: process.version, sqlite: trials[0].sqlite, schema: trials[0].schema, parser: trials[0].parser, cpu: cpus()[0].model, platform: process.platform },
      inventory: snapshot.inventory, expected: snapshot.expected, inputSha256: snapshot.sha256, rawChecks: samples.reduce((sum, row) => sum + row.rawChecks, 0), summary, samples };
    await mkdir(dirname(options.report), { recursive: true });
    await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    let document = markdown(report, options.report);
    if (options.requests) {
      document = document.replace('실제 로그의 워크트리 집계 비교', `합성 ${options.requests}요청의 워크트리 집계 비교`)
        .replace('실제 대화 고정 사본', '생성한 합성 JSONL')
        .replace('압축 로그를 포함한다.', 'Claude·Codex 요청을 절반씩 생성했다. 이미지·도구 출력·fork·손상 로그는 포함하지 않는다.')
        .replace('실제 세션 사본', '생성한 세션')
        .replace(`각 상태에서 raw SQL과 ${report.rawChecks}개 집계를 대조했고`, `전체 표본에서 raw SQL과 집계를 총 ${report.rawChecks}회 대조했고`);
      document += `\n## 합성 입력\n\n요청 ${options.requests}건, 세션당 ${options['turns-per-session']}건, 세션 ${snapshot.expected.sessions}개다. 제공자마다 두 모델을 번갈아 쓰고 100개 요청마다 날짜를 바꾼다. 모든 요청은 완료 상태이며 input/output의 결정적 합계는 ${snapshot.expected.tokens} tokens다. 최초 집계에서 요청 수와 토큰 합계까지 검증한다.\n\n재실행 시 --real 대신 \`--requests=${options.requests} --turns-per-session=${options['turns-per-session']}\`을 지정한다.\n`;
    }
    await writeFile(options.report, document, { flag: 'wx' });
    console.log(JSON.stringify({ report: options.report, summary: summary.map(row => ({ scenario: row.scenario,
      beforeMs: row.before.elapsedMs.median, afterMs: row.after.elapsedMs.median, changePercent: row.changePercent, fasterPairs: row.fasterPairs })) }));
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('agent-tracker-incremental-refresh-'));
    await rm(directory, { recursive: true, force: true });
  }
}

module.exports = { makeSnapshot, verify, chooseTarget, inspectCodexTarget, appendRows, claudeRows, codexAppendRows, normalized };
if (require.main === module) {
  if (process.argv[2] === '--worker') worker(...process.argv.slice(3)).then(() => process.disconnect(), () => { process.exitCode = 1; process.disconnect(); });
  else main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
