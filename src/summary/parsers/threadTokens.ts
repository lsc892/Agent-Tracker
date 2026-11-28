// Stores repeated token vectors in an ArrayBuffer that can move between workers.
import { tokenUsageScore } from '../aggregation/winners';
import type { TokenVector } from '../types';

export type ThreadTokens = Pick<TokenVector, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>;

const TOKEN_FIELDS = 4;
const EMPTY_TOKENS = new Float64Array(0);

export function readThreadTokens(values: Float64Array, index: number, tokens: ThreadTokens): void {
  const offset = index * TOKEN_FIELDS;
  tokens.input = values[offset];
  tokens.output = values[offset + 1];
  tokens.cacheRead = values[offset + 2];
  tokens.cacheWrite = values[offset + 3];
}

export function readOptionalThreadTokens(values: Float64Array, index: number, tokens: ThreadTokens): ThreadTokens | undefined {
  if (Number.isNaN(values[index * TOKEN_FIELDS])) return undefined;
  readThreadTokens(values, index, tokens);
  return tokens;
}

export function scoreThreadTokens(values: Float64Array, index: number): number | bigint {
  const offset = index * TOKEN_FIELDS;
  return tokenUsageScore(values[offset], values[offset + 1]);
}

export class ThreadTokenBuffer {
  constructor(public values: Float64Array<ArrayBuffer> = EMPTY_TOKENS) {}

  write(index: number, tokens: ThreadTokens | undefined): void {
    const offset = this.reserve(index);
    // A missing legacy vector has a NaN marker because parsed token values are numeric.
    this.values[offset] = tokens?.input ?? NaN;
    if (!tokens) return;
    this.values[offset + 1] = tokens.output;
    this.values[offset + 2] = tokens.cacheRead;
    this.values[offset + 3] = tokens.cacheWrite;
  }

  copy(index: number, source: Float64Array, sourceIndex: number): void {
    const offset = this.reserve(index);
    const start = sourceIndex * TOKEN_FIELDS;
    for (let field = 0; field < TOKEN_FIELDS; field++) this.values[offset + field] = source[start + field];
  }

  private reserve(index: number): number {
    const offset = index * TOKEN_FIELDS;
    if (offset >= this.values.length) {
      const capacity = this.values.length / TOKEN_FIELDS;
      const vectors = Math.max(index + 1, capacity + Math.ceil(capacity / 2), 2);
      const expanded = new Float64Array(new ArrayBuffer(vectors * TOKEN_FIELDS * Float64Array.BYTES_PER_ELEMENT));
      expanded.set(this.values);
      this.values = expanded;
    }
    return offset;
  }
}
