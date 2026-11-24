// Counts recorded response usage and reconciles gaps supported by independent cumulative records.
import type { ModelUsageInput, Provider } from '../db/types';
import type { ThreadLegacy, ThreadLog, ThreadResponse, ThreadTokens } from '../parsers/threadUsage';
import { usageScore } from './winners';

type ModelUsage = ModelUsageInput & { cache_read_input_tokens: number; cache_write_input_tokens: number };

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

function accumulate(usage: ThreadUsage | undefined, tokens: ThreadTokens, model: string): ThreadUsage {
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

function* legacyRows(source: ThreadLog | undefined): IterableIterator<ThreadLegacy> {
  for (const row of source?.records ?? []) if (row.kind === 'legacy') yield row;
}

/** A fork can repeat the parent's records with new file timestamps. */
function copiedPrefix(source: ThreadLog, parent: ThreadLog | undefined): number {
  if (!parent || source === parent) return 0;
  const ancestor = legacyRows(parent);
  let copied = 0;
  for (const row of legacyRows(source)) {
    if (row.signature !== ancestor.next().value?.signature) break;
    copied++;
  }
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

function leadingLegacyUsage(source: ThreadLog, historical: number): ThreadUsage | undefined {
  const first = source.records.find((row): row is ThreadResponse => row.kind === 'response');
  const state: LegacyPosition = { seen: new Set() };
  let index = 0;
  let usage: ThreadUsage | undefined;
  for (const row of source.records) {
    if (row.kind === 'response') break;
    const delta = legacyIncrease(row, state);
    if (index++ < historical || !delta) continue;
    // Some logs emit a legacy snapshot for the first response before its identified usage record.
    if (row.total && first?.threadTotal && sameUsage(row.total, first.threadTotal) && sameUsage(delta, first.tokens)) continue;
    usage = accumulate(usage, delta, row.model);
  }
  return usage;
}

const responseKey = (row: ThreadResponse): string => JSON.stringify([row.turnId, row.responseId]);
const checkpointKey = (tokens: ThreadTokens): string => `${tokens.input}:${tokens.output}`;

interface CheckpointGap {
  model: string;
  tokens: ThreadTokens;
  before: ThreadTokens;
  after: ThreadTokens;
  verified: boolean;
}

/** Compare only intervals that begin with an observed checkpoint. */
function findCheckpointGaps(source: ThreadLog, winners: ReadonlyMap<string, ThreadResponse>): CheckpointGap[] {
  const seen = new Set<string>();
  const gaps: CheckpointGap[] = [];
  const explicit = emptyTokens();
  let previous: ThreadResponse | undefined;
  let turnChanged = false;
  for (const row of source.records) {
    if (row.kind !== 'response') continue;
    const key = responseKey(row), winner = winners.get(key);
    if (!winner || seen.has(key)) continue;
    seen.add(key);
    for (const component of components) explicit[component] += winner.tokens[component];
    turnChanged ||= previous?.turnId !== row.turnId;
    if (!row.threadTotal) continue;
    const before = previous?.threadTotal;
    if (before && !regressed(row.threadTotal, before)) {
      const delta = increase(row.threadTotal, before);
      const tokens = increase(delta, explicit);
      if (positive(tokens) && !regressed(delta, explicit)) {
        const priorTurn = previous?.turnTotal;
        const verified = !turnChanged && !!row.turnId && !!priorTurn && !!row.turnTotal
          && !regressed(row.turnTotal, priorTurn) && sameUsage(delta, increase(row.turnTotal, priorTurn));
        gaps.push({ model: previous?.model === row.model ? row.model : '', tokens, before, after: row.threadTotal, verified });
      }
    }
    previous = row;
    turnChanged = false;
    for (const component of components) explicit[component] = 0;
  }
  // Responses supplied by another file can already account for a gap in this file.
  return seen.size === winners.size ? gaps : [];
}

function corroborateGaps(source: ThreadLog, historical: number, gaps: readonly CheckpointGap[]): void {
  if (gaps.every(gap => gap.verified)) return;
  const openings = new Map<string, CheckpointGap>();
  const closings = new Map<string, CheckpointGap>();
  for (const gap of gaps) {
    if (gap.verified) continue;
    openings.set(checkpointKey(gap.before), gap);
    closings.set(checkpointKey(gap.after), gap);
  }
  const open = new Set<CheckpointGap>();
  let index = 0;
  let previous: ThreadTokens | undefined;
  for (const row of legacyRows(source)) {
    if (index++ < historical || !row.total) continue;
    if (previous && regressed(row.total, previous)) open.clear();
    previous = row.total;
    const key = checkpointKey(row.total);
    const closing = closings.get(key);
    if (closing && open.delete(closing)) closing.verified = true;
    const opening = openings.get(key);
    if (opening) open.add(opening);
  }
}

export function consumeThread(provider: Provider, source: ThreadLog, records: Iterable<ThreadResponse>, parent?: ThreadLog): ThreadUsage | undefined {
  let usage: ThreadUsage | undefined;
  if (provider === 'claude') {
    for (const row of records) usage = accumulate(usage, row.tokens, row.model);
    return usage;
  }
  const historical = copiedPrefix(source, parent);
  usage = leadingLegacyUsage(source, historical);
  const winners = new Map<string, ThreadResponse>();
  for (const row of records) {
    const key = responseKey(row), previous = winners.get(key);
    if (!previous || usageScore(row) >= usageScore(previous)) winners.set(key, row);
  }
  if (!winners.size) return usage;
  for (const row of winners.values()) usage = accumulate(usage, row.tokens, row.model);
  const gaps = findCheckpointGaps(source, winners);
  corroborateGaps(source, historical, gaps);
  for (const gap of gaps) if (gap.verified) usage = accumulate(usage, gap.tokens, gap.model);
  return usage;
}
