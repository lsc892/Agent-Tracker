// 새로 고른 응답과 이미 반영한 응답을 비교해 부모 요청의 추가 사용량을 계산한다.
import type { AppliedRequestTotals, AppliedResponse } from '../db/appliedResponses';
import { key } from './sourceEvidence';
import { accountedCacheRead, accountedCacheWrite, type MaterializedTurnSummary } from './turns';
import { usageScore } from './winners';

export interface AppliedUsagePlan {
  summaries: readonly MaterializedTurnSummary[];
  appliedResponses: readonly AppliedResponse[];
  replaceAppliedSessions: boolean;
}

const emptyTokens: Readonly<AppliedResponse['tokens']> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const responseId = (usage: AppliedResponse): string => key(usage.provider, usage.sessionId, usage.responseKey);
const requestId = (usage: AppliedResponse | AppliedRequestTotals): string => key(usage.provider, usage.sessionId, usage.rootId);

/** 이전 값에 차분을 더하고 같은 입력을 다시 처리해도 이중 반영하지 않는다. */
export function planAppliedUsage(summaries: readonly MaterializedTurnSummary[], selected: readonly AppliedResponse[],
  previous: Iterable<AppliedResponse>, previousTotals: Iterable<AppliedRequestTotals>): AppliedUsagePlan {
  const replacement = { summaries, appliedResponses: selected, replaceAppliedSessions: true };
  const remaining = new Map(Array.from(previous, usage => [responseId(usage), usage]));
  if (!remaining.size) return replacement;

  const totals = new Map<string, AppliedResponse['tokens']>();
  for (const request of previousTotals) {
    const { input, output, cacheRead, cacheWrite } = request.tokens;
    if (cacheRead === null || cacheWrite === null) return replacement;
    totals.set(requestId(request), { input, output, cacheRead, cacheWrite });
  }

  const changed: AppliedResponse[] = [];
  const changedRoots = new Set<string>();
  for (const usage of selected) {
    const id = responseId(usage);
    const before = remaining.get(id);
    remaining.delete(id);
    if (before && (before.rootId !== usage.rootId || usageScore(usage) < usageScore(before))) return replacement;

    const nextTokens = usage.tokens;
    const oldTokens = before?.tokens ?? emptyTokens;
    const input = nextTokens.input - oldTokens.input;
    const output = nextTokens.output - oldTokens.output;
    const cacheRead = accountedCacheRead(nextTokens) - accountedCacheRead(oldTokens);
    const cacheWrite = accountedCacheWrite(nextTokens) - accountedCacheWrite(oldTokens);
    if (input || output || cacheRead || cacheWrite) {
      const root = requestId(usage);
      let sum = totals.get(root);
      if (!sum) totals.set(root, sum = { ...emptyTokens });
      changedRoots.add(root);
      sum.input += input;
      sum.output += output;
      sum.cacheRead += cacheRead;
      sum.cacheWrite += cacheWrite;
    }
    if (!before || input || output || nextTokens.cacheRead !== oldTokens.cacheRead || nextTokens.cacheWrite !== oldTokens.cacheWrite)
      changed.push(usage);
  }
  if (remaining.size) return replacement;

  const updated: MaterializedTurnSummary[] = [];
  for (const row of summaries) {
    const root = key(row.provider, row.session_id, row.root_turn_id);
    const sum = totals.get(root) ?? emptyTokens;
    if (sum.input !== row.input_tokens || sum.output !== row.output_tokens
      || sum.cacheRead !== row.cache_read_input_tokens || sum.cacheWrite !== row.cache_write_input_tokens) return replacement;
    updated.push(changedRoots.has(root) ? {
      ...row, input_tokens: sum.input, output_tokens: sum.output, total_tokens: sum.input + sum.output,
      cache_read_input_tokens: sum.cacheRead, cache_write_input_tokens: sum.cacheWrite,
    } : row);
  }
  return { summaries: updated, appliedResponses: changed, replaceAppliedSessions: false };
}
