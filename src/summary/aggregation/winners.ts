// winner 비교에 쓰는 토큰 점수와 동점 순서를 계산한다.
import type { TokenVector } from '../types';

export function usageScore({ tokens }: { tokens: Pick<TokenVector, 'input' | 'output'> }): number | bigint {
  const total = tokens.input + tokens.output;
  return Number.isSafeInteger(total) ? total : BigInt(tokens.input) + BigInt(tokens.output);
}

export function isBetterUsage(score: number | bigint, order: number, previousScore: number | bigint, previousOrder: number): boolean {
  return score > previousScore || score === previousScore && order > previousOrder;
}
