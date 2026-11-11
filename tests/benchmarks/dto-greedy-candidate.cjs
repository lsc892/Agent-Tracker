// 제품 빌드를 고정한 뒤 winner 선택만 바꾸는 실험용 후보와 패자 폐기 통제를 만든다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { createHash } = require('node:crypto');

const sha = value => createHash('sha256').update(value).digest('hex');
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Expected one patch point: ${before}`);
  return source.replace(before, after);
}

function loadCandidates(product, directory) {
  const path = join(product, 'dist/src/summary/aggregation/memoryAggregate.js');
  const original = fs.readFileSync(path, 'utf8');
  let candidate = replaceOnce(original, 'const winners = new Map(), checks = new Map();',
    'const winners = [], checks = new Map();');
  candidate = replaceOnce(candidate, 'previous = winners.get(id);',
    'previous = winners.find(slot => slot.groupKey === id);');
  candidate = replaceOnce(candidate, 'winners.set(id, { source, event, ordinal, request, score });', `if (previous) {
                            previous.source = source;
                            previous.event = event;
                            previous.ordinal = ordinal;
                            previous.request = request;
                            previous.score = score;
                        } else winners.push({ groupKey: id, source, event, ordinal, request, score });`);
  const marker = 'for (const { root, outcome } of sourceOutcomes.values())';
  candidate = replaceOnce(candidate, marker, `exports.observe?.(winners);\n    ${marker}`);
  // Mutating the DTO itself is a separate experiment because it also changes the accepted source cache.
  const overwrite = replaceOnce(candidate, 'previous.event = event;', `for (const field of Object.keys(previous.event)) {
                                if (!Object.hasOwn(event, field)) delete previous.event[field];
                            }
                            Object.assign(previous.event, event);`);
  fs.mkdirSync(directory, { recursive: true });
  const modules = {};
  const profileA = replaceOnce(original, marker, `exports.observe?.(winners);\n    ${marker}`);
  for (const [name, source] of Object.entries({ A: original, B: candidate, overwrite, profileA })) {
    const target = resolve(directory, `${name}.cjs`);
    fs.writeFileSync(target, source);
    modules[name] = require(target);
  }
  return { ...modules, hashes: { baseline: sha(original), arraySlots: sha(candidate), overwrite: sha(overwrite) } };
}

const score = event => Number.isSafeInteger(event.tokens.input + event.tokens.output)
  ? event.tokens.input + event.tokens.output : BigInt(event.tokens.input) + BigInt(event.tokens.output);
const groupKey = (file, event) => JSON.stringify([file.provider, file.session_id, event.responseId,
  file.provider === 'claude' ? event.requestId ?? 'no-req' : event.threadId,
  file.provider === 'claude' ? '' : event.turnId]);

// Give early selection the final session already resolved by the real scanner; do not weaken it with guessed identity.
function selectBeforeValidation(files) {
  const slots = [];
  let ordinal = 0;
  for (const file of files) for (const event of file.events) {
    const position = ordinal++;
    if (event.kind !== 'usage') continue;
    const id = groupKey(file, event), value = score(event), previous = slots.find(slot => slot.id === id);
    if (!previous) slots.push({ id, score: value, ordinal: position });
    else if (value >= previous.score) { previous.score = value; previous.ordinal = position; }
  }
  return retainOrdinals(files, new Set(slots.map(slot => slot.ordinal)));
}

function retainOrdinals(files, selected) {
  let ordinal = 0;
  return files.map(file => ({ ...file, events: file.events.filter(event => {
    const position = ordinal++;
    return event.kind !== 'usage' || selected.has(position);
  }) }));
}

// First finish all original validity rules, then keep only winners as the next refresh's cached usage DTOs.
function discardValidatedLosers(files, module) {
  let selected;
  module.observe = slots => { selected = new Set(slots.map(slot => slot.ordinal)); };
  let result;
  try { result = module.aggregateMemory(files); } finally { delete module.observe; }
  return { result, files: retainOrdinals(files, selected) };
}

function digest(result) { return sha(JSON.stringify(result)); }
function totals(result) {
  return result.summaries.reduce((sum, row) => ({ requests: sum.requests + 1, input: sum.input + row.input_tokens,
    output: sum.output + row.output_tokens, tokens: sum.tokens + row.total_tokens }),
  { requests: 0, input: 0, output: 0, tokens: 0 });
}
module.exports = { loadCandidates, selectBeforeValidation, discardValidatedLosers, digest, totals, sha };
