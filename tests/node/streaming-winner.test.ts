// 파싱 중 winner DTO 재사용과 첫 파싱 근거가 보존하는 실제 집계 계약을 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceEvidence, StreamingAggregation, type StreamingAggregateFile } from '../../src/summary/aggregation/memoryAggregate';
import type { MemoryAggregateFile } from '../fixtures/streaming-aggregate';
import { prepareSources } from '../../src/summary/aggregation/sourceEvidence';
import { Winners } from '../../src/summary/aggregation/winners';
import type { ParseEvent, UsageEvent } from '../../src/summary/types';

const usage = (input: number, extra: Partial<UsageEvent> = {}): UsageEvent => ({
  kind: 'usage', rootId: 'root', responseId: 'response', requestId: null, threadId: 'thread', turnId: 'turn',
  tokens: { input, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, offset: 10, ...extra,
});
const file = (id: number, events: ParseEvent[], provider: 'claude' | 'codex' = 'codex'): MemoryAggregateFile => ({
  id, provider, session_id: 'session', identity: { sessionId: 'session', threadId: 'thread-' + id,
    parentThreadId: null, projectKey: 'project', projectName: 'Project', isMain: true }, events,
});
function prepare(files: readonly MemoryAggregateFile[]): StreamingAggregateFile[] {
  return files.map(({ events, ...source }) => {
    const evidence = new SourceEvidence();
    events.forEach((event, index) => evidence.add(event, index));
    return { ...source, evidence };
  });
}
function run(files: readonly MemoryAggregateFile[]) {
  const aggregation = new StreamingAggregation(prepare(files));
  for (const source of files) source.events.forEach((event, index) => aggregation.add(source.id, event, index));
  return aggregation.finish();
}

test('a group keeps the same winner DTO through replacements and discards lower candidates', () => {
  const winners = new Winners(), source = prepareSources(prepare([file(1, [])])).sources[0];
  const first = usage(20, { model: 'first', flags: ['first-only'] });
  winners.add('group', source, first, 0, null);
  const slot = [...winners.values()][0], dto = slot.event;
  winners.add('group', source, usage(10, { model: 'loser' }), 1, null);
  assert.equal([...winners.values()][0], slot);
  assert.equal(slot.event.model, 'first');
  const last = usage(21, { tokens: { input: 19, output: 4, cacheRead: 7, cacheWrite: 3, reasoning: 2 } });
  winners.add('group', source, last, 2, 'canonical');
  assert.equal([...winners.values()].length, 1);
  assert.equal([...winners.values()][0], slot);
  assert.equal(slot.event, dto);
  assert.deepEqual(slot.event, last, 'equal input+output takes the later complete vector and drops absent optional fields');
  assert.equal(slot.request, 'canonical');
  assert.equal(first.model, 'first', 'replacing the owned DTO never mutates an input event');
  assert.deepEqual(first.flags, ['first-only']);
});

test('streamed comparison keeps exact ordering above Number safe sum range', () => {
  const input = Number.MAX_SAFE_INTEGER;
  const result = run([file(1, [
    usage(input, { tokens: { input, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, model: 'larger' }),
    usage(input, { tokens: { input, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, model: 'smaller-later' }),
  ])]);
  assert.equal(result.summaries[0].output_tokens, 4);
  assert.equal(result.summaries[0].model_usage[0].model, 'larger');
});

test('discarded usage retains its root, smallest offset and diagnostic flags', () => {
  const result = run([file(1, [
    usage(100, { rootId: 'winning-root', flags: ['winner-warning'], offset: 30 }),
    usage(50, { rootId: 'losing-root', flags: ['loser-warning'], offset: 4 }),
    usage(20, { rootId: 'losing-root', offset: 2 }),
  ])]);
  const loser = result.summaries.find(row => row.root_turn_id === 'losing-root')!;
  assert.equal(loser.total_tokens, 0);
  assert.equal(loser.diagnostic_offset, 2);
  assert.match(loser.quality_flags ?? '', /loser-warning/);
  assert.equal(result.summaries.find(row => row.root_turn_id === 'winning-root')!.total_tokens, 102);
});

test('copied prefix excludes every repeated copied capability but keeps the later fresh call', () => {
  const capability = (threadId: string, offset: number): ParseEvent => ({ kind: 'capability', rootId: 'root', threadId,
    eventId: 'tool', category: 'skill', name: 'sample', offset });
  const parent = file(1, [capability('parent', 0), usage(100, { threadId: 'parent', schema: 'legacy', offset: 1 })]);
  parent.identity.threadId = 'parent';
  const child = file(2, [capability('child', 0), capability('child', 1),
    usage(100, { threadId: 'child', schema: 'legacy', offset: 2 }),
    usage(20, { threadId: 'child', schema: 'legacy', responseId: 'new-response', offset: 3 }),
    capability('child', 4)]);
  child.identity.threadId = 'child'; child.identity.forkedFromId = 'parent';
  const result = run([parent, child]);
  assert.equal(result.summaries[0].total_tokens, 124);
  assert.deepEqual(result.summaries[0].capability_usage?.filter(row => row.category === 'skill'),
    [{ category: 'skill', name: 'sample', usage_count: 2 }]);
});

test('late current format and request identity resolve before any streaming usage selection', () => {
  const source = file(1, [
    usage(900, { schema: 'legacy', requestId: 'excluded-request', flags: ['legacy-warning'] }),
    usage(100, { schema: 'current', requestId: null, model: 'corrected' }),
    usage(50, { schema: 'current', requestId: 'only-request', model: 'lower-explicit' }),
  ], 'claude');
  const prepared = prepare([source]), evidence = prepared[0].evidence;
  assert.match(evidence.legacy[0].signature, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(evidence.legacy[0], 'tokens'), false);
  const aggregation = new StreamingAggregation(prepared);
  source.events.forEach((event, index) => aggregation.add(source.id, event, index));
  const result = aggregation.finish(), row = result.summaries[0];
  assert.equal(row.total_tokens, 102);
  assert.equal(row.model_usage[0].model, 'corrected');
  assert.doesNotMatch(row.quality_flags ?? '', /missing-request-id/);
  assert.match(row.quality_flags ?? '', /legacy-warning/);
});
