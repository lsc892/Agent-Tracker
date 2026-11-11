// 단일 읽기에서 winner DTO를 재사용하고 패자의 벡터·모델을 남기지 않는지 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceWinners } from '../../src/summary/aggregation/sourceWinners';
import type { UsageEvent } from '../../src/summary/types';

const usage = (input: number, model?: string): UsageEvent => ({ kind: 'usage', rootId: 'root', responseId: 'response',
  requestId: null, threadId: 'thread', turnId: 'turn', offset: 0, schema: 'current',
  tokens: { input, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, model });

test('one source retains exactly one owned DTO per group and updates it for a better or later tie', () => {
  const selected = new SourceWinners('codex'), first = usage(100, 'first');
  first.flags = ['first-only']; selected.add(first, 0);
  const dto = [...selected.values()][0].event;
  selected.add(usage(1, 'loser'), 1);
  assert.equal([...selected.values()].length, 1); assert.equal([...selected.values()][0].event, dto);
  const better = usage(200, 'winner'); selected.add(better, 2);
  assert.equal([...selected.values()][0].event, dto); assert.deepEqual(dto, better);
  const tied = usage(200, 'later'); selected.add(tied, 3);
  assert.equal([...selected.values()].length, 1); assert.deepEqual(dto, tied);
  assert.deepEqual(first.flags, ['first-only']); assert.equal(first.model, 'first');
  assert.equal(JSON.stringify(selected.evidence).includes('"tokens"'), false);
});

test('source comparison uses exact sums above Number safe integer range', () => {
  const selected = new SourceWinners('codex'), larger = usage(Number.MAX_SAFE_INTEGER, 'larger');
  larger.tokens.output = 4; selected.add(larger, 0);
  const smaller = usage(Number.MAX_SAFE_INTEGER, 'smaller-later'); smaller.tokens.output = 3; selected.add(smaller, 1);
  assert.equal((([...selected.values()][0].event) as UsageEvent).model, 'larger');
});
