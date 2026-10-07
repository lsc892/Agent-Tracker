import type { ModelUsageInput, Provider } from './db/types';

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

export function estimateCost(provider: Provider, usage: ModelUsageInput): number | null {
  const id = usage.model.replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$|-latest$/,'');
  const rates = provider === 'claude' ? claude : codex;
  const rate = Object.hasOwn(rates,id) ? rates[id] : undefined;
  const write = usage.cache_write_input_tokens, read = usage.cache_read_input_tokens;
  if (!rate || write === null || read === null || write > 0 && rate[2] === null) return null;
  const input = usage.input_tokens - write - read;
  if (input < 0) return null;
  return (input * rate[0] + usage.output_tokens * rate[1] + write * (rate[2] ?? 0) + read * rate[3]) / 1_000_000;
}
