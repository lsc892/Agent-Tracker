// 시간 측정과 분리해 실제 winner 객체 생성·비교 수와 캐시 축약 후 차이를 센다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { loadCandidates, discardValidatedLosers, digest, sha } = require('./dto-greedy-candidate.cjs');
const root = resolve(__dirname, '../..');
const input = resolve(process.argv[2]), output = resolve(process.argv[3]);
assert.equal(fs.existsSync(output), false, 'Do not overwrite verification data');
const report = JSON.parse(fs.readFileSync(input, 'utf8'));
const profiles = [];
for (const dataset of report.datasets) {
  const directory = join(root, report.workspace, dataset.name);
  const files = JSON.parse(fs.readFileSync(join(directory, 'inputs.json'), 'utf8'));
  const modules = loadCandidates(root, join(directory, 'profile'));
  const counter = { A: { lookups: 0, objects: 0, replacements: 0 }, B: { comparisons: 0, objects: 0, replacements: 0 } };
  const profileA = fs.readFileSync(join(directory, 'profile/profileA.cjs'), 'utf8')
    .replace('previous = winners.get(id);', 'previous = (exports.counter.lookups++, winners.get(id));')
    .replace('winners.set(id, { source, event, ordinal, request, score });',
      'exports.counter.objects++; if (previous) exports.counter.replacements++; winners.set(id, { source, event, ordinal, request, score });');
  const profileB = fs.readFileSync(join(directory, 'profile/B.cjs'), 'utf8')
    .replace('slot => slot.groupKey === id', 'slot => (exports.counter.comparisons++, slot.groupKey === id)')
    .replace('previous.source = source;', 'exports.counter.replacements++; previous.source = source;')
    .replace('else winners.push({ groupKey: id, source, event, ordinal, request, score });',
      'else { exports.counter.objects++; winners.push({ groupKey: id, source, event, ordinal, request, score }); }');
  const results = {}, winners = {};
  for (const [name, source] of Object.entries({ A: profileA, B: profileB })) {
    const path = join(directory, `profile/count-${name}.cjs`);
    fs.writeFileSync(path, source);
    const module = require(path); module.counter = counter[name];
    module.observe = selected => { winners[name] = selected.size ?? selected.length; };
    results[name] = module.aggregateMemory(files);
  }
  assert.equal(digest(results.A), digest(results.B));
  assert.equal(winners.A, winners.B);
  assert.equal(counter.A.objects - counter.A.replacements, winners.A);
  assert.equal(counter.B.objects, winners.B);
  const compact = discardValidatedLosers(files, modules.B), reused = modules.B.aggregateMemory(compact.files);
  const key = row => JSON.stringify([row.provider, row.session_id, row.root_turn_id]);
  const before = new Map(results.A.summaries.map(row => [key(row), row]));
  const after = new Map(reused.summaries.map(row => [key(row), row]));
  const added = reused.summaries.filter(row => !before.has(key(row)));
  const changed = reused.summaries.filter(row => before.has(key(row)) && JSON.stringify(before.get(key(row))) !== JSON.stringify(row));
  const changedFields = {};
  for (const row of changed) for (const field of Object.keys(row)) {
    if (JSON.stringify(row[field]) !== JSON.stringify(before.get(key(row))[field])) changedFields[field] = (changedFields[field] ?? 0) + 1;
  }
  const providerRequests = {};
  for (const row of results.A.summaries) providerRequests[row.provider] = (providerRequests[row.provider] ?? 0) + 1;
  profiles.push({ name: dataset.name, operations: counter, winnerGroups: winners.A,
    sourceUsageDtos: files.reduce((n, file) => n + file.events.filter(event => event.kind === 'usage').length, 0),
    compactedUsageDtos: compact.files.reduce((n, file) => n + file.events.filter(event => event.kind === 'usage').length, 0),
    distribution: { loadedFiles: files.length, sessions: new Set(files.map(file => JSON.stringify([file.provider, file.session_id]))).size,
      projects: new Set(files.map(file => file.identity.projectKey)).size, providerRequests,
      firstRequestAtMs: Math.min(...results.A.summaries.flatMap(row => row.started_at_ms === null ? [] : [row.started_at_ms])),
      lastRequestAtMs: Math.max(...results.A.summaries.flatMap(row => row.started_at_ms === null ? [] : [row.started_at_ms])) },
    compactedCacheDifference: { addedRequests: added.length, addedZeroUsageRequests: added.filter(row => row.total_tokens === 0).length,
      removedRequests: [...before.keys()].filter(id => !after.has(id)).length, changedRequests: changed.length, changedFields } });
}
const result = { dateSeoul: '2026-11-08', benchmarkSha256: sha(fs.readFileSync(input)), profileRunnerSha256: sha(fs.readFileSync(__filename)),
  helperHashes: Object.fromEntries(['incremental-refresh.cjs', 'temp-batch-ab.cjs', 'dto-greedy-candidate.cjs', 'dto-greedy-ab.test.cjs']
    .map(name => [name, sha(fs.readFileSync(join(__dirname, name)))])), profiles };
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
