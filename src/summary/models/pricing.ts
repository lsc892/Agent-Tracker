// 모델별 표준 단가로 기록된 토큰의 API 추정 비용을 계산한다.
import type { ModelUsageInput, Provider } from '../db/types';

// Standard text-token list prices, USD per million tokens, checked on 2026-10-07.
// https://platform.claude.com/docs/en/about-claude/pricing
// https://developers.openai.com/api/docs/pricing
export const PRICING_VERSION = '2026-10-07-standard-text';
type Rate = readonly [input: number, output: number, cacheWrite: number | null, cacheRead: number];
const claude: Record<string, Rate> = {
  'claude-fable-5-1': [10,50,12.5,0.25],
  'claude-opus-5-5': [4,20,5,0.2], 'claude-sonnet-5-5': [2,10,2.5,0.2],
  'claude-sonnet-5': [2,10,2.5,0.2], 'claude-opus-5': [5,25,6.25,0.5],
  'claude-opus-4-8': [5,25,6.25,0.5], 'claude-opus-4-7': [5,25,6.25,0.5],
  'claude-opus-4-6': [5,25,6.25,0.5], 'claude-opus-4-5': [5,25,6.25,0.5],
  'claude-opus-4-1': [15,75,18.75,1.5], 'claude-opus-4': [15,75,18.75,1.5],
  'claude-sonnet-4-6': [3,15,3.75,0.3], 'claude-sonnet-4-5': [3,15,3.75,0.3],
  'claude-sonnet-4': [3,15,3.75,0.3], 'claude-haiku-4-5': [1,5,1.25,0.1],
  'claude-3-5-haiku': [0.8,4,1,0.08],
};
const codex: Record<string, Rate> = {
  'gpt-6-astra': [10,50,12.5,1], 'gpt-6.1-sol': [2,10,2.5,0.1],
  'gpt-6-luna': [0.1,0.5,0.125,0.01], 'gpt-5.6-sol': [4,20,5,0.4],
  'gpt-5.3-codex': [1.75,14,null,0.175],
  // Older models retain their separately documented standard prices.
  // https://developers.openai.com/api/docs/models/gpt-5.4
  // https://developers.openai.com/api/docs/models/gpt-5.2
  'gpt-5.4': [2.5,15,null,0.25], 'gpt-5.2': [1.75,14,null,0.175],
};

/**
 * 책임: 기록된 모델별 토큰으로 표준 API 추정 비용을 계산한다.
 * 알고리즘: snapshot·latest 접미사를 제거해 단가를 찾고 입력·출력·캐시 쓰기·읽기를 분리 곱셈하며 미지원 단가·미상 캐시는 null로 유지한다.
 */
export function estimateCost(provider: Provider, usage: ModelUsageInput): number | null {
  // [비용 정책] 날짜·latest를 뗀 모델명으로 제공자별 단가를 찾고 캐시 성분이 불명확하면 비용을 알 수 없음으로 남긴다.
  const id = usage.model.replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$|-latest$/,'');
  const rates = provider === 'claude' ? claude : codex;
  const rate = Object.hasOwn(rates,id) ? rates[id] : undefined;
  const write = usage.cache_write_input_tokens, read = usage.cache_read_input_tokens;
  if (!rate || write === null || read === null || write > 0 && rate[2] === null) return null;
  // [비용 정책] 입력 총량에서 캐시 성분을 빼고 입력·출력·캐시별 단가를 적용한다.
  const input = usage.input_tokens - write - read;
  if (input < 0) return null;
  return (input * rate[0] + usage.output_tokens * rate[1] + write * (rate[2] ?? 0) + read * rate[3]) / 1_000_000;
}
