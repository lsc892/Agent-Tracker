// 벤치마크 후보의 원본 변경 판정과 파서 재개 결과를 제품의 전체 파싱과 대조한다.
'use strict';

const { createHash } = require('node:crypto');
const { mkdir, writeFile, lstat } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { zstdCompressSync } = require('node:zlib');

const variants = [
  'full-xxh128', 'full-blake3', 'sha256-checkpoint', 'xxh128-checkpoint',
  'blake3-checkpoint', 'fingerprint-tail', 'block-fixed', 'block-rolling', 'block-merkle', 'block-rolling-merkle',
];
const options = { collectCapabilities: true, cancelled: () => false };
const sha = value => createHash('sha256').update(value).digest('hex');
const jsonl = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');

function canonical(value) {
  if (value === undefined) return { $undefined: true };
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) };
  if (value instanceof Map) {
    const entries = [...value].map(([key, item]) => [canonical(key), canonical(item)]);
    entries.sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0])));
    return { $map: entries };
  }
  if (value instanceof Set) {
    const entries = [...value].map(canonical);
    entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return { $set: entries };
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

const digest = value => sha(JSON.stringify(canonical(value)));

function requestRows(provider, root, response, input, output, minute) {
  const started = `2026-11-16T00:${minute}:00.000Z`;
  const completed = `2026-11-16T00:${minute}:01.000Z`;
  if (provider === 'claude') {
    return [
      { type: 'user', sessionId: 'fixture-session', promptId: root, timestamp: started,
        message: { content: 'Synthetic benchmark request' } },
      { type: 'assistant', sessionId: 'fixture-session', promptId: root, requestId: `request-${response}`,
        timestamp: completed, message: { id: response, model: 'claude-sonnet-4-6', stop_reason: 'end_turn',
          usage: { input_tokens: input, output_tokens: output } } },
      { type: 'system', subtype: 'turn_duration', promptId: root, timestamp: completed, durationMs: 1000 },
    ];
  }
  return [
    { type: 'turn_context', payload: { turn_id: root, root_turn_id: root, model: 'gpt-6.1-sol' } },
    { type: 'event_msg', timestamp: started, payload: { type: 'task_started', turn_id: root, root_turn_id: root } },
    { type: 'event_msg', timestamp: started, payload: { type: 'user_message', turn_id: root,
      root_turn_id: root, message: 'Synthetic benchmark request' } },
    { type: 'token_usage_record', timestamp: completed, payload: { thread_id: 'fixture-session',
      turn_id: root, root_turn_id: root, response_id: response, model: 'gpt-6.1-sol',
      usage: { input_tokens: input, output_tokens: output } } },
    { type: 'event_msg', timestamp: completed, payload: { type: 'task_complete', turn_id: root,
      root_turn_id: root, duration_ms: 1000 } },
  ];
}

function makeCases(provider) {
  const header = provider === 'claude'
    ? { type: 'custom-title', customTitle: 'Synthetic fixture', padding: 'x'.repeat(2048) }
    : { type: 'session_meta', payload: { id: 'fixture-session', cwd: '/synthetic/jsonl-algorithms',
      auth_mode: 'chatgpt' }, padding: 'x'.repeat(2048) };
  const first = requestRows(provider, 'turn-1', 'response-1', 100, 20, '00');
  const second = requestRows(provider, 'turn-2', 'response-2', 200, 30, '01');
  const base = jsonl([header, ...first]);
  const addition = jsonl(second);
  const rewritten = Buffer.from(base.toString('utf8').replace('"input_tokens":100', '"input_tokens":900'));
  if (base.length !== rewritten.length || sha(base) === sha(rewritten)) throw new Error('Invalid equal-length rewrite fixture');
  if (sha(base.subarray(0, 1024)) !== sha(rewritten.subarray(0, 1024))) throw new Error('Rewrite entered the identity fingerprint range');
  const usageIndex = provider === 'claude' ? 1 : 3;
  const usageText = JSON.stringify(second[usageIndex]);
  const split = Math.floor(usageText.length / 2);
  const partialBase = Buffer.concat([base, jsonl(second.slice(0, usageIndex)), Buffer.from(usageText.slice(0, split))]);
  const partialComplete = Buffer.concat([partialBase, Buffer.from(usageText.slice(split) + '\n'), jsonl(second.slice(usageIndex + 1))]);
  const duplicate = requestRows(provider, 'turn-1', 'response-1', 140, 25, '00')[usageIndex];
  const previousNewline = base.lastIndexOf(10, base.length - 2);
  const malformedBase = Buffer.concat([base, Buffer.from('{"type":')]);
  const cases = [
    { name: 'append', before: base, after: Buffer.concat([base, addition]), expectedRequests: 2, expectedTokens: 350 },
    { name: 'same-size-middle-overwrite', before: base, after: rewritten, expectedRequests: 1,
      expectedTokens: 920, fingerprintLimitation: true },
    { name: 'grows-with-middle-change', before: base, after: Buffer.concat([rewritten, addition]),
      expectedRequests: 2, expectedTokens: 1150, fingerprintLimitation: true },
    { name: 'truncate', before: base, after: base.subarray(0, previousNewline + 1),
      expectedRequests: 1, expectedTokens: 120 },
    { name: 'partial-final-line-completes', before: partialBase, after: partialComplete,
      expectedRequests: 2, expectedTokens: 350 },
    { name: 'duplicate-response-update', before: base, after: Buffer.concat([base, jsonl([duplicate])]),
      expectedRequests: 1, expectedTokens: 165 },
    { name: 'malformed-final-line-completes', before: malformedBase,
      after: Buffer.concat([malformedBase, Buffer.from('invalid}\n')]), expectedError: 'parse-error' },
    { name: 'compressed-completed-frame-append', compressed: true, before: zstdCompressSync(base),
      after: Buffer.concat([zstdCompressSync(base), zstdCompressSync(addition)]), expectedRequests: 2, expectedTokens: 350 },
    { name: 'compressed-rewrite', compressed: true, before: zstdCompressSync(base),
      after: zstdCompressSync(Buffer.concat([rewritten, addition])), expectedRequests: 2, expectedTokens: 1150 },
  ];
  if (provider === 'codex') {
    const legacyUsage = { type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 100, output_tokens: 20 },
        last_token_usage: { input_tokens: 100, output_tokens: 20 } } } };
    const legacyBase = jsonl([header, ...first.slice(0, usageIndex), legacyUsage, ...first.slice(usageIndex + 1)]);
    cases.push({ name: 'legacy-to-current-append', before: legacyBase,
      after: Buffer.concat([legacyBase, jsonl([duplicate])]), expectedRequests: 1, expectedTokens: 165 });
  } else {
    const oldResponse = structuredClone(first[usageIndex]);
    delete oldResponse.requestId;
    const noRequestBase = jsonl([header, ...first.slice(0, usageIndex), oldResponse, ...first.slice(usageIndex + 1)]);
    cases.push({ name: 'late-request-id-append', before: noRequestBase,
      after: Buffer.concat([noRequestBase, jsonl([duplicate])]), expectedRequests: 1, expectedTokens: 165 });
  }
  return cases;
}

async function metadata(path, provider, sourceRoot) {
  const stat = await lstat(path);
  return { id: 1, provider, path, source_root: sourceRoot, session_id: null,
    size_bytes: stat.size, mtime_ms: stat.mtimeMs, dev: String(stat.dev), inode: String(stat.ino),
    parser_version: 17, capabilities_collected: 1 };
}

function publicResult(preparation, file, constructors) {
  if (!preparation.ok) {
    return { ok: false, errorCode: preparation.error.code, errorOffset: preparation.error.offset,
      identitySha256: digest(preparation.identity) };
  }
  const snapshot = structuredClone(preparation.winners);
  const winners = new constructors.SourceWinners(file.provider, snapshot);
  const aggregation = new constructors.StreamingAggregation([{ id: file.id, provider: file.provider,
    session_id: preparation.read.identity.sessionId, identity: preparation.read.identity, evidence: winners.evidence }]);
  aggregation.addSource(file.id, winners);
  const aggregate = aggregation.finish();
  return { ok: true, partialLine: preparation.read.partialLine,
    identitySha256: digest(preparation.read.identity), snapshotSha256: digest(preparation.winners),
    summariesSha256: digest(aggregate), requests: aggregate.summaries.length,
    totalTokens: aggregate.summaries.reduce((total, row) => total + row.total_tokens, 0),
    orphanCount: aggregate.orphans.length };
}

function compare(left, right) {
  if (!left.ok || !right.ok) {
    return { matched: digest(left) === digest(right), errorMatched: digest(left) === digest(right) };
  }
  const checks = {
    identityMatched: left.identitySha256 === right.identitySha256,
    snapshotMatched: left.snapshotSha256 === right.snapshotSha256,
    summariesMatched: left.summariesSha256 === right.summariesSha256,
    partialLineMatched: left.partialLine === right.partialLine,
    totalsMatched: left.requests === right.requests && left.totalTokens === right.totalTokens,
  };
  return { matched: Object.values(checks).every(Boolean), ...checks };
}

function verifyExpected(result, scenario) {
  if (scenario.expectedError) {
    if (result.ok || result.errorCode !== scenario.expectedError) throw new Error(`Oracle error mismatch for ${scenario.name}`);
    return;
  }
  if (!result.ok || result.requests !== scenario.expectedRequests || result.totalTokens !== scenario.expectedTokens) {
    throw new Error(`Oracle fixture totals mismatch for ${scenario.name}`);
  }
}

async function runCorrectness({ product, hashers, workspace }) {
  const { createEngine } = require('./preparation.cjs');
  const root = resolve(product);
  const original = require(join(root, 'dist/src/summary/scanner/sourcePreparation')).prepareSource;
  const constructors = {
    SourceWinners: require(join(root, 'dist/src/summary/aggregation/sourceWinners')).SourceWinners,
    StreamingAggregation: require(join(root, 'dist/src/summary/aggregation/memoryAggregate')).StreamingAggregation,
  };
  const directory = resolve(workspace, 'correctness');
  await mkdir(directory, { recursive: true });
  const results = [];
  for (const provider of ['codex', 'claude']) {
    for (const scenario of makeCases(provider)) {
      for (const variant of variants) {
        const fixtureDirectory = join(directory, provider, scenario.name, variant);
        await mkdir(fixtureDirectory, { recursive: true });
        const path = join(fixtureDirectory, scenario.compressed ? 'fixture.jsonl.zst' : 'fixture.jsonl');
        const engine = await createEngine({ product: root, variant, hashers });
        await writeFile(path, scenario.before);
        const beforeFile = await metadata(path, provider, fixtureDirectory);
        const before = publicResult(await original(beforeFile, options), beforeFile, constructors);
        if (!before.ok) throw new Error(`Oracle baseline failed for ${provider}/${scenario.name}`);
        engine.setPriming(true);
        const primed = publicResult(await engine.prepare(beforeFile, options), beforeFile, constructors);
        engine.setPriming(false);
        const priming = compare(primed, before);

        await writeFile(path, scenario.after);
        const afterFile = await metadata(path, provider, fixtureDirectory);
        const expected = publicResult(await original(afterFile, options), afterFile, constructors);
        verifyExpected(expected, scenario);
        engine.resetMetrics();
        const observed = publicResult(await engine.prepare(afterFile, options), afterFile, constructors);
        const metrics = engine.metrics();
        const afterComparison = compare(observed, expected);

        // Revisit the same baseline and changed file to detect shared snapshot mutation.
        await writeFile(path, scenario.before);
        const replayFile = await metadata(path, provider, fixtureDirectory);
        const replay = publicResult(await engine.prepare(replayFile, options), replayFile, constructors);
        await writeFile(path, scenario.after);
        const repeatedFile = await metadata(path, provider, fixtureDirectory);
        const repeated = publicResult(await engine.prepare(repeatedFile, options), repeatedFile, constructors);
        const replayMatched = compare(replay, before).matched;
        const repeatedMatched = compare(repeated, observed).matched;
        const expectedLimitation = variant === 'fingerprint-tail' && Boolean(scenario.fingerprintLimitation);
        results.push({ provider, scenario: scenario.name, variant,
          beforeBytes: scenario.before.length, afterBytes: scenario.after.length,
          beforeSha256: sha(scenario.before), afterSha256: sha(scenario.after),
          primingMatched: priming.matched, ...afterComparison, cacheReplayMatched: replayMatched,
          repeatedResultMatched: repeatedMatched, expectedLimitation,
          limitationObserved: expectedLimitation && !afterComparison.matched,
          oracle: expected, observed, metrics });
      }
    }
  }
  const required = results.filter(result => !result.expectedLimitation);
  const limitations = results.filter(result => result.expectedLimitation);
  return { schemaVersion: 1, providers: 2, variantCount: variants.length,
    scenarioCountPerProvider: 10, resultCount: results.length,
    requiredCases: required.length,
    requiredPassed: required.filter(result => result.primingMatched && result.matched
      && result.cacheReplayMatched && result.repeatedResultMatched).length,
    requiredFailed: required.filter(result => !result.primingMatched || !result.matched
      || !result.cacheReplayMatched || !result.repeatedResultMatched).length,
    expectedLimitationCases: limitations.length,
    observedLimitationCases: limitations.filter(result => result.limitationObserved).length,
    results };
}

module.exports = { runCorrectness, variants };
