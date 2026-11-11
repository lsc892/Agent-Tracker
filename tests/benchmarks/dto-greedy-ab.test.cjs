// 고정 그룹의 max 선택과 미래 입력으로 그룹·유효성이 달라지는 경우를 분리해 검증한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { resolve, join } = require('node:path');
const { loadCandidates, selectBeforeValidation, discardValidatedLosers, totals } = require('./dto-greedy-candidate.cjs');
const root = resolve(__dirname, '../..');
const workspace = fs.mkdtempSync(join(root, 'tests/.cache/dto-greedy-unit-'));
const { A, B, overwrite } = loadCandidates(root, workspace);
const usage = (input, extra = {}) => ({ kind: 'usage', rootId: 'root', responseId: 'response', requestId: null,
  threadId: 'thread', turnId: 'turn', schema: 'current', model: 'model', billingMode: 'api', offset: 10,
  tokens: { input, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, ...extra });
const turn = rootId => ({ kind: 'turn', rootId, isMain: true, offset: 0, startedAt: 0, completed: true,
  completedAt: 100, durationQuality: 'derived' });
const source = (id, events, provider = 'codex') => ({ id, provider, session_id: 'session', identity: {
  sessionId: 'session', threadId: `thread-${id}`, parentThreadId: null, isMain: true,
  projectKey: 'project', projectName: 'Project' }, events });
const compare = files => assert.deepEqual(B.aggregateMemory(files), A.aggregateMemory(files));

test('fixed groups: whole token vector, later tie, root and model move, no mutation', () => {
  const files = [source(1, [turn('a'), turn('b'), usage(100, { rootId: 'a', tokens: {
    input: 100, output: 20, cacheRead: 80, cacheWrite: 0, reasoning: 1 } }), usage(90, { rootId: 'b', model: 'winner',
    tokens: { input: 90, output: 50, cacheRead: 10, cacheWrite: 20, reasoning: 2 } }),
  usage(80, { rootId: 'b', model: 'tie', tokens: { input: 80, output: 60, cacheRead: 0, cacheWrite: 0, reasoning: 3 } })])];
  const before = JSON.stringify(files);
  compare(files);
  const rows = B.aggregateMemory(files).summaries;
  assert.deepEqual(rows.map(row => [row.root_turn_id, row.input_tokens, row.output_tokens]), [['a', 0, 0], ['b', 80, 60]]);
  assert.equal(rows[1].model_usage[0].model, 'tie');
  assert.equal(JSON.stringify(files), before);
});

test('large integer scores remain exact', () => {
  const n = Number.MAX_SAFE_INTEGER;
  compare([source(1, [turn('root'), usage(n, { tokens: { input: n, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }),
    usage(n - 1, { tokens: { input: n - 1, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0 } })])]);
});

test('late request ID correction and ambiguity are preserved after full preparation', () => {
  for (const requests of [[null, 'one'], ['one', null, 'two'], [null, 'no-req', 'two']]) {
    compare([source(1, [turn('root'), ...requests.map((requestId, i) => usage(100 + i, { requestId }))], 'claude')]);
  }
});

test('legacy prefix must be checked before dropping the larger copied DTO', () => {
  const parent = source(1, [turn('root'), usage(100, { schema: 'legacy', threadId: 'parent' })]);
  parent.identity.threadId = 'parent';
  const child = source(2, [turn('root'), usage(100, { schema: 'legacy', threadId: 'child' }),
    usage(10, { schema: 'legacy', threadId: 'child', offset: 20, model: 'valid-lower' })]);
  child.identity.forkedFromId = 'parent';
  const files = [parent, child]; compare(files);
  assert.equal(totals(A.aggregateMemory(files)).tokens, 114);
  assert.equal(totals(A.aggregateMemory(selectBeforeValidation(files))).tokens, 102);
});

test('a later current DTO invalidates the earlier larger legacy DTO in the same group', () => {
  const files = [source(1, [turn('root'), usage(100, { schema: 'legacy' }), usage(10)])];
  compare(files);
  assert.equal(totals(A.aggregateMemory(files)).tokens, 12);
  assert.equal(totals(A.aggregateMemory(selectBeforeValidation(files))).tokens, 102);
});

test('discarded explicit request evidence changes late ambiguity', () => {
  const first = source(1, [turn('root'), usage(100, { requestId: null })], 'claude');
  const second = source(2, [usage(90, { requestId: 'one' })], 'claude');
  const files = [first, second], compact = discardValidatedLosers(files, B);
  assert.deepEqual(compact.result, A.aggregateMemory(files));
  const late = source(3, [usage(10, { requestId: 'two' })], 'claude');
  assert.equal(totals(A.aggregateMemory([...files, late])).tokens, 206);
  assert.equal(totals(B.aggregateMemory([...compact.files, late])).tokens, 102);
});

test('deleting a winning source requires the previously defeated source DTO', () => {
  const low = source(1, [turn('root'), usage(10)]), high = source(2, [usage(100)]);
  const compact = discardValidatedLosers([low, high], B);
  assert.equal(totals(A.aggregateMemory([low])).tokens, 12);
  assert.equal(totals(B.aggregateMemory(compact.files.filter(file => file.id !== 2))).tokens, 0);
});

test('moving a winner to a different session must reveal the old session runner-up', () => {
  const low = source(1, [turn('root'), usage(10)]), high = source(2, [turn('root'), usage(100)]);
  const compact = discardValidatedLosers([low, high], B);
  const moved = { ...high, session_id: 'new-session' };
  assert.equal(totals(A.aggregateMemory([low, moved])).tokens, 114);
  assert.equal(totals(B.aggregateMemory([compact.files[0], moved])).tokens, 102);
});

test('in-place DTO overwriting corrupts a reused source when the winner file is deleted', () => {
  const low = source(1, [turn('root'), usage(10, { model: 'low' })]), high = source(2, [usage(100, { model: 'high' })]);
  const files = structuredClone([low, high]);
  assert.deepEqual(overwrite.aggregateMemory(files), A.aggregateMemory([low, high]));
  assert.equal(files[0].events[1].tokens.input, 100);
  assert.equal(totals(A.aggregateMemory([low])).tokens, 12);
  assert.equal(totals(overwrite.aggregateMemory([files[0]])).tokens, 102);
});

test('500 deterministic mixed-provider datasets preserve full summaries with array slots', () => {
  let seed = 73021;
  const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let run = 0; run < 500; run++) {
    const files = Array.from({ length: 4 }, (_, index) => source(index + 1, [turn('root'), turn('other'),
      ...Array.from({ length: 20 }, () => usage(next(500), { rootId: next(2) ? 'root' : 'other',
        responseId: `response-${next(5)}`, requestId: [null, 'one', 'two'][next(3)],
        model: `model-${next(3)}`, offset: next(200), schema: next(4) ? 'current' : 'legacy',
        flags: next(10) ? undefined : ['observed-warning'] }))], index < 2 ? 'claude' : 'codex'));
    compare(files);
  }
});
