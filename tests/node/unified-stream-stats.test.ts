// 접은 원본 상태의 늦은 귀속·순서·진단·Worker 전달을 이벤트 순서 기준 집계와 대조한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceWinners } from '../../src/summary/aggregation/sourceWinners';
import { StreamingAggregation } from '../../src/summary/aggregation/memoryAggregate';
import { EventOrderAggregation } from '../fixtures/event-order-aggregate';
import { aggregateMemory, type MemoryAggregateFile } from '../fixtures/streaming-aggregate';
import type { ParseEvent, UsageEvent } from '../../src/summary/types';

const usage = (rootId: string, input: number, extra: Partial<UsageEvent> = {}): UsageEvent => ({ kind: 'usage', rootId,
  responseId: 'response-' + rootId, requestId: null, threadId: 'thread', turnId: 'turn', schema: 'current',
  tokens: { input, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, offset: 10, ...extra });
const source = (id: number, events: ParseEvent[]): MemoryAggregateFile => ({ id, provider: 'codex', session_id: 'session',
  identity: { sessionId: 'session', threadId: 'thread-' + id, parentThreadId: null,
    projectKey: 'project', projectName: 'Project', isMain: true }, events });

function eventOrder(files: MemoryAggregateFile[]) {
  const prepared = files.map(({ events, ...file }) => {
    const winners = new SourceWinners(file.provider);
    events.forEach((event, index) => winners.add(event, index));
    return { ...file, evidence: winners.evidence };
  });
  const aggregation = new EventOrderAggregation(prepared);
  for (const file of files) file.events.forEach((event, index) => aggregation.add(file.id, event, index));
  return aggregation.finish();
}

test('thousands of lifecycle and check events become one request state and preserve the final outcome', () => {
  const events: ParseEvent[] = [usage('root', 100)];
  for (let index = 0; index < 2000; index++) {
    events.push({ kind: 'turn', rootId: 'root', isMain: true, startedAt: 100 + index,
      title: 'title-' + index, status: index % 2 ? 'in_progress' : 'completed', statusAt: 5000 - index,
      completed: index % 2 === 0, completedAt: 5000 - index, offset: index + 20 });
    events.push({ kind: 'check', rootId: 'root', threadId: 'thread', turnId: 'turn',
      tokens: { input: 100, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, offset: index + 21 });
  }
  const file = source(1, events), selected = new SourceWinners('codex');
  events.forEach((event, index) => selected.add(event, index));
  assert.equal(selected.roots.size, 1);
  assert.equal(selected.roots.get('root')!.turns.size, 1);
  assert.equal(selected.roots.get('root')!.checks.size, 1);
  assert.equal([...selected.values()].length, 1);
  assert.deepEqual(aggregateMemory([file]), eventOrder([file]));
  const restored = new SourceWinners('codex', structuredClone(selected.snapshot()));
  const aggregation = new StreamingAggregation([{ ...file, evidence: restored.evidence }]);
  aggregation.addSource(file.id, restored);
  assert.deepEqual(aggregation.finish(), aggregateMemory([file]));
});

test('parent remapping combines source outcomes by last event and maximum historical time, preserving first title', () => {
  const child = source(1, [usage('first', 100),
    { kind: 'turn', rootId: 'second', isMain: false, title: 'first title', startedAt: 100, offset: 3 },
    { kind: 'turn', rootId: 'first', isMain: true, title: 'later title', status: 'completed', statusAt: 900, offset: 4 },
    { kind: 'turn', rootId: 'second', isMain: true, status: 'in_progress', statusAt: 200, offset: 5 },
  ]);
  child.identity.parentRootId = 'parent';
  child.identity.standaloneSubagent = true;
  const peer = source(2, [{ kind: 'turn', rootId: 'parent', isMain: true, status: 'failed', statusAt: 800, offset: 0 }]);
  const files = [child, peer], before = structuredClone(files);
  assert.deepEqual(aggregateMemory(files), eventOrder(files));
  const row = aggregateMemory(files).summaries[0];
  assert.equal(row.request_title, 'first title');
  assert.equal(row.status, 'in_progress');
  assert.equal(row.diagnostic_offset, 0);
  assert.deepEqual(files, before);
});

test('folded metadata preserves empty titles, skipped non-main turns and minimum loser offsets', () => {
  const file = source(1, [
    { kind: 'turn', rootId: 'root', isMain: false, title: 'ignored', startedAt: 1, offset: 0 },
    { kind: 'turn', rootId: 'root', isMain: true, title: '', startedAt: 10, offset: 2 },
    { kind: 'turn', rootId: 'root', isMain: true, title: 'later', completed: true, completedAt: 100, offset: 3 },
    usage('root', 100), usage('loser', 20, { responseId: 'response-root', offset: 4 }),
  ]);
  assert.deepEqual(aggregateMemory([file]), eventOrder([file]));
  const result = aggregateMemory([file]);
  assert.equal(result.summaries.find(row => row.root_turn_id === 'root')!.request_title, '');
  assert.equal(result.summaries.find(row => row.root_turn_id === 'loser')!.diagnostic_offset, 4);
});

test('session flag indexing preserves file order, wildcard placement and main name selection', () => {
  const first = source(1, [usage('!root', 100, { flags: ['root-first'] })]);
  first.flags = [{ rootId: '*', flag: 'common-first' }];
  first.identity.sessionName = 'First';
  const second = source(2, [usage('!root', 90, { flags: ['root-second'] })]);
  second.flags = [{ rootId: '*', flag: 'common-second' }];
  second.identity.sessionName = 'Last';
  const row = aggregateMemory([second, first]).summaries[0];
  assert.equal(row.session_name, 'Last');
  assert.equal(row.quality_flags, 'root-first,common-first,root-second,common-second,duration-missing');
});

test('snapshot keeps exact winner scores and normalized text without modifying the input', () => {
  const event = usage('root', Number.MAX_SAFE_INTEGER, { model: 'model\ud800' });
  event.tokens.output = 4;
  const selected = new SourceWinners('codex'); selected.add(event, 0);
  const restored = new SourceWinners('codex', structuredClone(selected.snapshot()));
  assert.equal([...restored.values()][0].score, BigInt(Number.MAX_SAFE_INTEGER) + 4n);
  assert.equal([...restored.values()][0].event.model, 'model�');
  assert.equal(event.model, 'model\ud800');
});
