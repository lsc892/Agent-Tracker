// Counts recorded response usage and reconciles gaps supported by independent cumulative records.
import type { ModelUsageInput } from '../db/types';
import type { ThreadCheckpointInterval, ThreadLegacy, ThreadLog, ThreadResponse, ThreadTokens } from '../parsers/threadUsage';

type ModelUsage = ModelUsageInput & { cache_read_input_tokens: number; cache_write_input_tokens: number };

export type CodexThreadEvidence = Pick<ThreadLog, 'legacy' | 'leadingLegacyCount' | 'firstResponse'> & {
  responseCount: number;
  checkpoints: readonly (ThreadCheckpointInterval & { responseKeys: readonly string[] })[];
};

export interface ThreadUsage extends ThreadTokens {
  models: Map<string, ModelUsage>;
}

const components = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
const emptyTokens = (): ThreadTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const positive = (tokens: ThreadTokens): boolean => tokens.input > 0 || tokens.output > 0;
const sameUsage = (left: ThreadTokens, right: ThreadTokens): boolean => left.input === right.input && left.output === right.output;
const regressed = (total: ThreadTokens, previous: ThreadTokens): boolean => total.input < previous.input || total.output < previous.output;

function increase(total: ThreadTokens, previous: ThreadTokens): ThreadTokens {
  return { input: Math.max(0, total.input - previous.input), output: Math.max(0, total.output - previous.output),
    cacheRead: Math.max(0, total.cacheRead - previous.cacheRead), cacheWrite: Math.max(0, total.cacheWrite - previous.cacheWrite) };
}

export function accumulateThreadUsage(usage: ThreadUsage | undefined, tokens: ThreadTokens, model: string): ThreadUsage {
  const result = usage ?? { ...emptyTokens(), models: new Map<string, ModelUsage>() };
  const read = Math.min(tokens.input, tokens.cacheRead);
  const write = Math.min(tokens.input - read, tokens.cacheWrite);
  result.input += tokens.input;
  result.output += tokens.output;
  result.cacheRead += read;
  result.cacheWrite += write;
  let entry = result.models.get(model);
  if (!entry) {
    entry = { model, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_write_input_tokens: 0 };
    result.models.set(model, entry);
  }
  entry.input_tokens += tokens.input;
  entry.output_tokens += tokens.output;
  entry.cache_read_input_tokens += read;
  entry.cache_write_input_tokens += write;
  return result;
}

/** A fork can repeat the parent's records with new file timestamps. */
function copiedPrefix(legacy: readonly ThreadLegacy[], parent: readonly ThreadLegacy[] | undefined): number {
  if (!parent || legacy === parent) return 0;
  const limit = Math.min(legacy.length, parent.length);
  let copied = 0;
  while (copied < limit && legacy[copied].signature === parent[copied].signature) copied++;
  return copied;
}

interface LegacyPosition {
  previous?: ThreadTokens;
  seen: Set<string>;
}

function legacyIncrease(row: ThreadLegacy, state: LegacyPosition): ThreadTokens | undefined {
  if (state.seen.has(row.signature)) return;
  state.seen.add(row.signature);
  const previous = state.previous;
  if (!row.total) {
    if (previous && row.last) for (const key of components) previous[key] += row.last[key];
    return row.last && positive(row.last) ? row.last : undefined;
  }
  if (!previous) {
    state.previous = { ...row.total };
    return row.last && positive(row.last) ? row.last : undefined;
  }
  if (regressed(row.total, previous)) {
    // An individual usage record establishes consumption across a reset; a falling counter alone cannot.
    if (row.last && positive(row.last) && !regressed(row.total, row.last)) {
      state.previous = { ...row.total };
      return row.last;
    }
    return;
  }
  const delta = increase(row.total, previous);
  for (const key of components) previous[key] = Math.max(previous[key], row.total[key]);
  return positive(delta) ? delta : undefined;
}

function leadingLegacyUsage({ legacy, leadingLegacyCount, firstResponse }: CodexThreadEvidence, historical: number): ThreadUsage | undefined {
  if (leadingLegacyCount <= historical) return;
  const state: LegacyPosition = { seen: new Set() };
  let usage: ThreadUsage | undefined;
  for (let index = 0; index < leadingLegacyCount; index++) {
    const row = legacy[index];
    const delta = legacyIncrease(row, state);
    if (index < historical || !delta) continue;
    // Some logs emit a legacy snapshot for the first response before its identified usage record.
    if (row.total && firstResponse?.threadTotal && sameUsage(row.total, firstResponse.threadTotal)
      && sameUsage(delta, firstResponse.tokens)) continue;
    usage = accumulateThreadUsage(usage, delta, row.model);
  }
  return usage;
}

const checkpointKey = (tokens: ThreadTokens): string => `${tokens.input}:${tokens.output}`;

interface CheckpointGap {
  model: string;
  tokens: ThreadTokens;
  before: ThreadTokens;
  after: ThreadTokens;
  verified: boolean;
}

/** Sum final winners in each disjoint interval between observed checkpoints. */
function findCheckpointGaps({ checkpoints, responseCount }: CodexThreadEvidence,
  winners: ReadonlyMap<string, ThreadResponse>): CheckpointGap[] {
  // Responses supplied by another file can already account for a gap in this file.
  if (!checkpoints.length || responseCount !== winners.size) return [];
  const gaps: CheckpointGap[] = [];
  const explicit = emptyTokens();
  for (const { start, end, responseKeys } of checkpoints) {
    const before = start.threadTotal, after = end.threadTotal;
    const startTurn = winners.get(responseKeys[0])?.turnId;
    let sameTurn = !!startTurn;
    for (const component of components) explicit[component] = 0;
    for (let position = 1; position < responseKeys.length; position++) {
      const winner = winners.get(responseKeys[position]);
      if (!winner) return [];
      sameTurn &&= winner.turnId === startTurn;
      for (const component of components) explicit[component] += winner.tokens[component];
    }
    const delta = increase(after, before);
    if (regressed(delta, explicit)) continue;
    const tokens = increase(delta, explicit);
    if (!positive(tokens)) continue;
    const verified = sameTurn && !!start.turnTotal && !!end.turnTotal && !regressed(end.turnTotal, start.turnTotal)
      && sameUsage(delta, increase(end.turnTotal, start.turnTotal));
    gaps.push({ model: start.model === end.model ? end.model : '', tokens, before, after, verified });
  }
  return gaps;
}

function corroborateGaps(legacy: readonly ThreadLegacy[], historical: number, gaps: readonly CheckpointGap[]): void {
  if (gaps.every(gap => gap.verified)) return;
  const openings = new Map<string, CheckpointGap>();
  const closings = new Map<string, CheckpointGap>();
  for (const gap of gaps) {
    if (gap.verified) continue;
    openings.set(checkpointKey(gap.before), gap);
    closings.set(checkpointKey(gap.after), gap);
  }
  const open = new Set<CheckpointGap>();
  let previous: ThreadTokens | undefined;
  for (let index = historical; index < legacy.length; index++) {
    const total = legacy[index].total;
    if (!total) continue;
    if (previous && regressed(total, previous)) open.clear();
    previous = total;
    const key = checkpointKey(total);
    const closing = closings.get(key);
    if (closing && open.delete(closing)) closing.verified = true;
    const opening = openings.get(key);
    if (opening) open.add(opening);
  }
}

export function consumeCodexThread(source: CodexThreadEvidence, winners: ReadonlyMap<string, ThreadResponse>,
  parent?: Pick<ThreadLog, 'legacy'>): ThreadUsage | undefined {
  const historical = copiedPrefix(source.legacy, parent?.legacy);
  let usage = leadingLegacyUsage(source, historical);
  if (!winners.size) return usage;
  for (const row of winners.values()) usage = accumulateThreadUsage(usage, row.tokens, row.model);
  const gaps = findCheckpointGaps(source, winners);
  corroborateGaps(source.legacy, historical, gaps);
  for (const gap of gaps) if (gap.verified) usage = accumulateThreadUsage(usage, gap.tokens, gap.model);
  return usage;
}
