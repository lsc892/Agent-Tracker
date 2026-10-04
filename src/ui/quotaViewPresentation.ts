import type { QuotaProviderId } from '../quota/types';
import { escapeHtml } from './presentation';

export type QuotaMessage = { type: 'ready' | 'refreshQuota' | 'openUsage' }
  | { type: 'manage'; provider: QuotaProviderId }
  | { type: 'detail'; detail: 'compact' | 'detailed' };

export function parseQuotaMessage(input: unknown): QuotaMessage | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  switch (value.type) {
    case 'ready': case 'refreshQuota': case 'openUsage': return { type: value.type };
    case 'manage': return value.provider === 'claude' || value.provider === 'codex' ? { type: 'manage', provider: value.provider } : null;
    case 'detail': return value.detail === 'compact' || value.detail === 'detailed' ? { type: 'detail', detail: value.detail } : null;
    default: return null;
  }
}

export function quotaHtml(assets: { script: string; style: string; claude: string; codex: string; csp: string; nonce: string }): string {
  const { script, style, claude, codex, csp, nonce } = Object.fromEntries(Object.entries(assets).map(([key, value]) => [key, escapeHtml(value)]));
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp}; style-src ${csp}; script-src 'nonce-${nonce}';">
<title>사용량</title><link rel="stylesheet" href="${style}"></head>
<body><main class="quota-panel" aria-label="에이전트 사용량">
<header><h1>사용량</h1><button id="refresh" class="icon-button" aria-label="현재 사용량 새로고침" title="현재 사용량 새로고침"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17"/></svg></button></header>
<div class="display-options" role="group" aria-label="상태 표시줄 표시 방식"><span class="display-options-label">상태 표시줄</span><button data-detail="detailed" aria-pressed="true" title="상태 표시줄에 7일·5시간 사용량 표시">상세</button><button data-detail="compact" aria-pressed="false" title="상태 표시줄에 5시간 사용량만 표시">압축</button></div>
<div class="providers">
${(['codex', 'claude'] as const).map(provider => `<section class="provider" id="provider-${provider}" aria-label="${provider === 'codex' ? 'Codex' : 'Claude'}">
<img class="provider-icon ${provider}-icon" src="${provider === 'codex' ? codex : claude}" alt="" width="22" height="22">
<div class="provider-content"><div class="provider-heading"><h2>${provider === 'codex' ? 'Codex' : 'Claude'}</h2><span class="availability" role="status"></span></div><div class="windows"></div><p class="stale" hidden></p></div>
<button class="manage icon-button" data-provider="${provider}" aria-label="${provider === 'codex' ? 'Codex' : 'Claude'} 확장 관리" title="${provider === 'codex' ? 'Codex' : 'Claude'} 확장 관리"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button></section>`).join('')}
</div><button id="open-usage" class="statistics"><span>사용량 통계</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button>
</main><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
