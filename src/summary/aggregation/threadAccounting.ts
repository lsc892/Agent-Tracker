// Counts recorded response usage and reconciles gaps supported by independent cumulative records.
import type { ModelUsageInput } from '../db/types';
import { copiedLegacyPrefix } from '../parsers/legacySignatures';
import type { ThreadCheckpointInterval, ThreadLegacy, ThreadResponse } from '../parsers/threadUsage';
import { readOptionalThreadTokens, readThreadTokens, type ThreadTokens } from '../parsers/threadTokens';

type ModelUsage = ModelUsageInput & { cache_read_input_tokens: number; cache_write_input_tokens: number };

export interface CodexThreadEvidence {
  legacy?: ThreadLegacy;
  responseCount: number;
  checkpoints: readonly ThreadCheckpointInterval[];
  checkpointWinnerRows?: Uint32Array;
}

interface CodexWinners {
  rows: readonly ThreadResponse[];
  tokens: Float64Array;
}

export interface ThreadUsage extends ThreadTokens {
  models: Map<string, ModelUsage>;
}

const components = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
export const emptyTokens = (): ThreadTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const positive = (tokens: ThreadTokens): boolean => tokens.input > 0 || tokens.output > 0;
const sameUsage = (left: ThreadTokens, right: ThreadTokens): boolean => left.input === right.input && left.output === right.output;
const regressed = (total: ThreadTokens, previous: ThreadTokens): boolean => total.input < previous.input || total.output < previous.output;

function increase(total: ThreadTokens, previous: ThreadTokens, delta = emptyTokens()): ThreadTokens {
  // [집계 정책] 토큰 항목마다 직전 누계를 빼고 음수는 0으로 처리한다.
  delta.input = Math.max(0, total.input - previous.input);
  delta.output = Math.max(0, total.output - previous.output);
  delta.cacheRead = Math.max(0, total.cacheRead - previous.cacheRead);
  delta.cacheWrite = Math.max(0, total.cacheWrite - previous.cacheWrite);
  return delta;
}

export function accumulateThreadUsage(usage: ThreadUsage | undefined, tokens: ThreadTokens, model: string): ThreadUsage {
  const result = usage ?? { ...emptyTokens(), models: new Map<string, ModelUsage>() };
  // [집계 정책] 캐시 읽기를 먼저 배정하고 남은 입력까지만 캐시 쓰기로 인정해 스레드 합계에 더한다.
  const read = Math.min(tokens.input, tokens.cacheRead);
  const write = Math.min(tokens.input - read, tokens.cacheWrite);
  result.input += tokens.input;
  result.output += tokens.output;
  result.cacheRead += read;
  result.cacheWrite += write;

  // [집계 정책] 같은 토큰을 모델별 합계에도 더하고 처음 본 모델은 새 항목을 만든다.
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

interface LegacyPosition {
  previous?: ThreadTokens;
  delta: ThreadTokens;
}

function legacyIncrease(total: ThreadTokens | undefined, last: ThreadTokens | undefined, state: LegacyPosition): ThreadTokens | undefined {
  // [집계 정책] 비교할 이전 누계가 없으면 개별 사용량만 반영한다.
  const previous = state.previous;
  if (!total) {
    if (previous && last) {
      previous.input += last.input;
      previous.output += last.output;
      previous.cacheRead += last.cacheRead;
      previous.cacheWrite += last.cacheWrite;
    }
    return last && positive(last) ? last : undefined;
  }
  if (!previous) {
    state.previous = { ...total };
    return last && positive(last) ? last : undefined;
  }

  // [집계 정책] 누계가 줄면 새 누계 범위에 맞는 양수의 개별 사용량이 있을 때만 기준을 초기화한다.
  if (regressed(total, previous)) {
    if (last && positive(last) && !regressed(total, last)) {
      state.previous = { ...total };
      return last;
    }
    return;
  }

  // [집계 정책] 입력 또는 출력이 늘어난 경우만 반환하고 다음 비교 기준에는 항목별 최댓값을 보존한다.
  const delta = increase(total, previous, state.delta);
  previous.input = Math.max(previous.input, total.input);
  previous.output = Math.max(previous.output, total.output);
  previous.cacheRead = Math.max(previous.cacheRead, total.cacheRead);
  previous.cacheWrite = Math.max(previous.cacheWrite, total.cacheWrite);
  return positive(delta) ? delta : undefined;
}

function leadingLegacyUsage(legacy: ThreadLegacy, historical: number): ThreadUsage | undefined {
  const { leadingCount, firstResponse, signatures: { rowIds, offsets } } = legacy;
  if (leadingCount <= historical) return;
  // [귀속 정책] 복사 이력으로 비교 기준을 복구하고 첫 응답 전의 자체 증가분만 더한다.
  const state: LegacyPosition = { delta: emptyTokens() };
  const seen = new Uint8Array(new ArrayBuffer(offsets.length - 1));
  const totalTokens = emptyTokens(), lastTokens = emptyTokens();
  let usage: ThreadUsage | undefined;
  for (let index = 0; index < leadingCount; index++) {
    const signature = rowIds[index];
    if (seen[signature]) continue;
    seen[signature] = 1;
    const total = readOptionalThreadTokens(legacy.tokens, index * 2, totalTokens);
    const last = readOptionalThreadTokens(legacy.tokens, index * 2 + 1, lastTokens);
    const delta = legacyIncrease(total, last, state);
    if (index < historical || !delta) continue;
    // [집계 정책] 입력·출력 누계와 증가분이 첫 응답 기록과 일치하면 중복으로 보고 제외한다.
    if (total && firstResponse && sameUsage(total, firstResponse.threadTotal)
      && sameUsage(delta, firstResponse.tokens)) continue;
    usage = accumulateThreadUsage(usage, delta, legacy.models[index]);
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
function findCheckpointGaps({ checkpoints, checkpointWinnerRows, responseCount }: CodexThreadEvidence,
  { rows, tokens: winnerTokens }: CodexWinners): CheckpointGap[] {
  // [집계 정책] 파일의 응답 수와 최종 winner 수가 다르면 파일 간 병합으로 차이가 설명될 수 있어 보정을 생략한다.
  if (!checkpoints.length || responseCount !== rows.length) return [];
  const gaps: CheckpointGap[] = [];
  const explicit = emptyTokens();
  const winner = emptyTokens();
  for (const { start, end } of checkpoints) {
    // [집계 정책] 시작 경계 응답을 빼고 구간의 최종 winner 토큰을 더하며 같은 턴인지 추적한다.
    const before = start.threadTotal, after = end.threadTotal;
    const startIndex = checkpointWinnerRows?.[start.responseIndex] ?? start.responseIndex;
    const startTurn = rows[startIndex].turnId;
    let sameTurn = !!startTurn;
    for (const component of components) explicit[component] = 0;
    for (let position = start.responseIndex + 1; position <= end.responseIndex; position++) {
      const winnerIndex = checkpointWinnerRows?.[position] ?? position;
      sameTurn &&= rows[winnerIndex].turnId === startTurn;
      readThreadTokens(winnerTokens, winnerIndex, winner);
      for (const component of components) explicit[component] += winner[component];
    }

    // [집계 정책] 스레드 누계 증가량에서 응답 합계를 빼고 입력 또는 출력이 더 늘어난 구간만 남긴다.
    const delta = increase(after, before);
    if (regressed(delta, explicit)) continue;
    const tokens = increase(delta, explicit);
    if (!positive(tokens)) continue;

    // [집계 정책] 같은 턴에서 턴과 스레드의 입력·출력 증가량이 일치하면 차이를 확정한다.
    const verified = sameTurn && !!start.turnTotal && !!end.turnTotal
      && delta.input === end.turnTotal.input - start.turnTotal.input
      && delta.output === end.turnTotal.output - start.turnTotal.output;
    gaps.push({ model: start.model === end.model ? end.model : '', tokens, before, after, verified });
  }
  return gaps;
}

function corroborateGaps(legacy: ThreadLegacy, historical: number, gaps: readonly CheckpointGap[]): void {
  if (gaps.every(gap => gap.verified)) return;
  // [집계 정책] 미확정 구간을 시작·종료 시점의 입력·출력 누계로 각각 색인한다.
  const openings = new Map<string, CheckpointGap>();
  const closings = new Map<string, CheckpointGap>();
  for (const gap of gaps) {
    if (gap.verified) continue;
    openings.set(checkpointKey(gap.before), gap);
    closings.set(checkpointKey(gap.after), gap);
  }

  // [집계 정책] 복사 이력 이후의 레거시 누계에서 시작과 끝이 순서대로 나오면 확정하고 누계가 줄면 열린 구간을 비운다.
  const open = new Set<CheckpointGap>();
  let previous = emptyTokens(), next = emptyTokens();
  let hasPrevious = false;
  for (let index = historical; index < legacy.signatures.rowIds.length; index++) {
    const total = readOptionalThreadTokens(legacy.tokens, index * 2, next);
    if (!total) continue;
    if (hasPrevious && regressed(total, previous)) open.clear();
    next = previous;
    previous = total;
    hasPrevious = true;
    const key = checkpointKey(total);
    const closing = closings.get(key);
    if (closing && open.delete(closing)) closing.verified = true;
    const opening = openings.get(key);
    if (opening) open.add(opening);
  }
}

export function consumeCodexThread(source: CodexThreadEvidence, winners: CodexWinners,
  parent?: ThreadLegacy): ThreadUsage | undefined {
  // [집계 정책] 부모와 일치하는 접두사를 찾아 빼고 첫 응답 전에 기록된 레거시 사용량을 계산한다.
  const { legacy } = source;
  const historical = legacy && parent ? copiedLegacyPrefix(legacy.signatures, parent.signatures) : 0;
  let usage = legacy && leadingLegacyUsage(legacy, historical);
  if (!winners.rows.length) return usage;

  // [집계 정책] 최종 winner의 토큰을 스레드 합계와 모델별 합계에 한 번씩 더한다.
  const tokens = emptyTokens();
  for (let index = 0; index < winners.rows.length; index++) {
    readThreadTokens(winners.tokens, index, tokens);
    usage = accumulateThreadUsage(usage, tokens, winners.rows[index].model);
  }

  // [집계 정책] 체크포인트 증가량에서 winner 합계를 뺀 차이를 턴 누계나 레거시 기록으로 검증한 뒤 보충한다.
  const gaps = findCheckpointGaps(source, winners);
  if (legacy) corroborateGaps(legacy, historical, gaps);
  for (const gap of gaps) if (gap.verified) usage = accumulateThreadUsage(usage, gap.tokens, gap.model);
  return usage;
}
