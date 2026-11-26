// winner 비교에 쓰는 토큰 점수와 동점 순서를 계산한다.
import type { TokenVector } from '../types';

export function usageScore({ tokens }: { tokens: Pick<TokenVector, 'input' | 'output'> }): number | bigint {
  // [Winner 정책] 입력과 출력 토큰을 더하고 안전 정수 범위를 넘으면 BigInt로 정확한 점수를 계산한다.
  const total = tokens.input + tokens.output;
  return Number.isSafeInteger(total) ? total : BigInt(tokens.input) + BigInt(tokens.output);
}

export function isBetterUsage(score: number | bigint, order: number, previousScore: number | bigint, previousOrder: number): boolean {
  // [Winner 정책] 토큰 점수가 높은 후보를 우선하고 동점이면 순번이 큰 후보를 고른다.
  return score > previousScore || score === previousScore && order > previousOrder;
}
