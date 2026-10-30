// 파일 prefix를 검증하고 파서 상태·정규화 이벤트를 재사용하는 실험용 캐시를 전체 재파싱과 비교한다.
const { readFile, writeFile } = require('node:fs/promises');
const { statSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { zstdCompressSync } = require('node:zlib');
const Module = require('node:module');
const { assert, productRoot: root, sha, digest, stats, order } = require('./storage-ab-common.cjs');
const { readJsonl, SummaryError } = require(join(root, 'dist/src/summary/jsonl'));
const { CodexCurrentParserAdapter, ClaudeParserAdapter } = require(join(root, 'dist/src/summary/parsers'));
const { SummaryDatabase } = require(join(root, 'dist/src/summary/db'));
const { SummaryStaging } = require(join(root, 'dist/src/summary/staging'));
const source = join(root, 'dist/src/summary/jsonl.js');
const helper = new Module(source, module); helper.filename = source; helper.paths = Module._nodeModulePaths(join(root, 'dist/src/summary'));
helper._compile(readFileSync(source, 'utf8') + '\nexports.BenchmarkLine = JsonlLine;', source);
const JsonlLine = helper.exports.BenchmarkLine;
const jsonl = rows => rows.map(v => JSON.stringify(v)).join('\n') + '\n';
function rowsFor(provider, index, complete = true) {
  const id = `root-${index}`, timestamp = '2026-10-29T00:00:00.000Z';
  if (provider === 'claude') return [
    { type: 'user', sessionId: 'fixture', promptId: id, cwd: '/fixture', timestamp, message: { content: 'Fixture request' } },
    ...(complete ? [{ type: 'assistant', promptId: id, requestId: `response-${index}`, timestamp,
      message: { id: `message-${index}`, model: 'claude-sonnet-4-6', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 } } }] : []),
  ];
  return [
    { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: id, root_turn_id: id } },
    { type: 'turn_context', payload: { turn_id: id, model: 'gpt-5.6-sol' } },
    { type: 'token_usage_record', timestamp, payload: { turn_id: id, root_turn_id: id, response_id: `response-${index}`, usage: { input_tokens: 100, output_tokens: 10 } } },
    ...(complete ? [{ type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: id } }] : []),
  ];
}
function adapter(provider, path, events) {
  const result = { identity: undefined };
  const Parser = provider === 'claude' ? ClaudeParserAdapter : CodexCurrentParserAdapter;
  const parser = new Parser({ provider, path, sourceRoot: '/fixture', fileId: 1 }, {
    event: event => events.push(event), identity: identity => { result.identity = identity; },
  });
  return { parser, result };
}
function snapshot(parser) {
  return structuredClone(Object.fromEntries(Object.entries(parser).filter(([key]) => key !== 'context' && key !== 'sink')));
}
async function full(provider, path) {
  const start = performance.now(), events = [], { parser, result } = adapter(provider, path, events), hash = require('node:crypto').createHash('sha256');
  const read = await readJsonl(path, statSync(path).size, (row, offset) => parser.row(row, offset), { onChunk: chunk => hash.update(chunk) });
  const state = snapshot(parser); parser.finish();
  return { events, identity: result.identity, state, partialLine: read.partialLine, contentSha256: hash.digest('hex'), parsedRows: read.rows,
    parseMs: performance.now() - start, mode: 'full' };
}
async function makeCache(provider, path) {
  const result = await full(provider, path), data = await readFile(path);
  const boundary = data.lastIndexOf(10) + 1;
  return { ...result, boundary, prefixSha256: sha(data.subarray(0, boundary)), cacheBytes: Buffer.byteLength(JSON.stringify({ events: result.events, state: result.state })) };
}
async function reused(provider, path, cache) {
  const start = performance.now(), data = await readFile(path);
  // Full prefix validation also detects equal-length edits, truncation, and rewritten files that grew.
  if (path.endsWith('.zst') || data.length < cache.boundary || sha(data.subarray(0, cache.boundary)) !== cache.prefixSha256) {
    const result = await full(provider, path); return { ...result, parseMs: performance.now() - start, mode: 'fallback-full' };
  }
  const events = [...cache.events], { parser, result } = adapter(provider, path, events);
  Object.assign(parser, structuredClone(cache.state));
  let offset = cache.boundary, parsedRows = 0;
  for (;;) {
    const end = data.indexOf(10, offset); if (end < 0) break;
    let text;
    if (end - offset <= 4 * 1024 * 1024 && !/data:image\//i.test(data.toString('utf8', offset, end))) text = data.toString('utf8', offset, end).trim();
    else { const line = new JsonlLine(4 * 1024 * 1024, offset); line.append(data, offset, end); text = line.text(); }
    if (text) {
      let row; try { row = JSON.parse(text); } catch { throw new SummaryError('parse-error', offset); }
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SummaryError('unsupported-schema', offset);
      parser.row(row, offset); parsedRows++;
    }
    offset = end + 1;
  }
  // Retain only state before finish; partial trailing records are deferred exactly as by readJsonl.
  const state = snapshot(parser); parser.finish();
  return { events, identity: result.identity, state, partialLine: offset < data.length, contentSha256: sha(data), parsedRows,
    nextBoundary: offset, nextPrefixSha256: sha(data.subarray(0, offset)), parseMs: performance.now() - start, mode: 'verified-tail' };
}
function aggregate(provider, path, parsed) {
  const start = performance.now(), db = new SummaryDatabase(':memory:');
  let staging;
  try {
    staging = new SummaryStaging(db.connection);
    staging.addFile({ id: 1, provider, source_root: '/fixture', path, session_id: null, size_bytes: statSync(path).size,
      mtime_ms: 1, dev: null, inode: null, parser_version: 1 }, null, true);
    staging.batchEvents(() => { for (const event of parsed.events) staging.event(1, event); staging.identity(1, parsed.identity); });
    assert.ok(staging.nextComponent()); staging.resolveLineage(); staging.excludeVerifiedPrefixes(); staging.prepareSummaries();
    const summaries = [...staging.summaries()];
    return { summaries, elapsedMs: performance.now() - start };
  } finally { staging?.close(); db.close(); }
}
async function runParsing(directory, options) {
  const results = [];
  for (const provider of ['codex','claude']) for (const turns of options.parseTurns) {
    const path = join(directory, `${provider}-${turns}.jsonl`);
    const prefix = provider === 'codex' ? jsonl([{ type: 'session_meta', payload: { id: 'fixture', cwd: '/fixture' } }]) : '';
    const initial = Buffer.from(prefix + Array.from({ length: turns }, (_, i) => jsonl(rowsFor(provider, i, i !== turns - 1))).join(''));
    await writeFile(path, initial);
    const cacheStart = performance.now(), cache = await makeCache(provider, path), cacheBuildMs = performance.now() - cacheStart;
    const appended = Buffer.concat([initial, Buffer.from(jsonl(rowsFor(provider, turns)))]);
    const duplicate = Buffer.concat([initial, Buffer.from(jsonl(rowsFor(provider, 0).slice(provider === 'codex' ? 2 : 1)))]);
    const existing = Buffer.concat([initial, Buffer.from(jsonl(rowsFor(provider, turns - 1).slice(provider === 'codex' ? 2 : 1)))]);
    const partial = Buffer.concat([initial, Buffer.from(jsonl(rowsFor(provider, turns)).slice(0, -10))]);
    const rewritten = Buffer.from(initial.toString('utf8').replace('input_tokens":100', 'input_tokens":101'));
    const cases = [['append-new',appended],['duplicate-response',duplicate],['complete-pending',existing],['partial-line',partial],['rewrite-same-size',rewritten]];
    if (provider === 'codex') {
      const legacy = { type: 'event_msg', timestamp: '2026-10-29T00:00:01Z', payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: 1000, output_tokens: 100 }, last_token_usage: { input_tokens: 1000, output_tokens: 100 } } } };
      cases.push(['legacy-cumulative',Buffer.concat([initial,Buffer.from(jsonl([legacy, legacy]))])]);
    }
    for (const [scenario, data] of cases) {
      await writeFile(path, data);
      const samples = [[],[]]; let expected, candidate, aggregateSha256;
      for (let round = -options.warmup; round < options.samples; round++) for (const i of order(2, Math.abs(round))) {
        const parsed = i ? await reused(provider, path, cache) : await full(provider, path);
        const staged = aggregate(provider, path, parsed);
        const hashes = { events: digest(parsed.events), identity: digest(parsed.identity), summaries: digest(staged.summaries),
          partialLine: parsed.partialLine, contentSha256: parsed.contentSha256 };
        if (!expected) { expected = hashes; aggregateSha256 = hashes.summaries; }
        assert.deepEqual(hashes, expected, `${provider}/${turns}/${scenario}`);
        if (i) candidate = { mode: parsed.mode, parsedRows: parsed.parsedRows, events: parsed.events.length };
        if (round >= 0) samples[i].push({ parseMs: parsed.parseMs, replayAndAggregateMs: staged.elapsedMs, bundleMs: parsed.parseMs + staged.elapsedMs });
      }
      results.push({ provider, turns, scenario, fileBytes: data.length, cacheBuildMs, cacheBytes: cache.cacheBytes,
        aggregateSha256, candidate, variants: Object.fromEntries(['full','verified-tail'].map((v, i) => [v, {
          parse: stats(samples[i].map(v => v.parseMs)), replayAndAggregate: stats(samples[i].map(v => v.replayAndAggregateMs)),
          bundle: stats(samples[i].map(v => v.bundleMs)), samples: samples[i] }])) });
    }
    // A partial record completes later; an ordinary append must retain its parser context and byte offsets.
    const partialPath = join(directory, `${provider}-partial.jsonl`); await writeFile(partialPath, partial);
    const partialCache = await makeCache(provider, partialPath); await writeFile(partialPath, appended);
    assert.deepEqual(digest((await reused(provider, partialPath, partialCache)).events), digest((await full(provider, partialPath)).events));
    await writeFile(path, initial.subarray(0, initial.indexOf(10) + 1));
    if (provider === 'claude') await writeFile(path, Buffer.from(jsonl(rowsFor(provider, 0))));
    const truncated = await reused(provider, path, cache); assert.equal(truncated.mode, 'fallback-full');
    assert.equal(digest(truncated.events), digest((await full(provider, path)).events));
    const compressedPath = path + '.zst'; await writeFile(compressedPath, zstdCompressSync(appended));
    assert.equal((await reused(provider, compressedPath, cache)).mode, 'fallback-full');
    // Invalid tail must fail without altering the accepted cache.
    await writeFile(path, Buffer.concat([initial,Buffer.from('{invalid}\n')]));
    const accepted = digest(cache); await assert.rejects(() => reused(provider, path, cache)); assert.equal(digest(cache), accepted);
    console.log(`Parsing: ${provider}/${turns} complete`);
  }
  return results;
}
module.exports = { runParsing };
