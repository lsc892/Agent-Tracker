import * as vscode from 'vscode';
import type { TrackerConfiguration } from '../configuration';
import type { QuotaState, QuotaWindow } from '../quota/types';

const commands = [
  'agentTracker.refreshQuota', 'agentTracker.openUsage',
  'agentTracker.setStatusBarDetail', 'agentTracker.openSettings',
];

// Native hover rules extend through the content padding to both card edges.
const sectionDivider = '---';

function commandLink(label: string, command: string, args?: string[]): string {
  const query = args ? `?${encodeURIComponent(JSON.stringify(args))}` : '';
  return `[${label}](command:${command}${query})`;
}

function resetText(window: QuotaWindow, now: number): string {
  if (window.resetsAt === null || !Number.isFinite(window.resetsAt)) return '—';
  const minutes = Math.max(0, Math.ceil((window.resetsAt - now) / 60_000));
  if (!minutes) return '초기화 시각 지남 · 조회 대기';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  return `${[days ? `${days}일` : '', hours ? `${hours}시간` : '', `${minutes % 60}분`].filter(Boolean).join(' ')} 후`;
}

function countdown(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.ceil((timestamp - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function muted(text: string): string {
  return `<span style="color:var(--vscode-descriptionForeground);">${text}</span>`;
}

function usageMeter(used: number, percentage: 'used' | 'remaining', reset: string): string {
  const percent = Math.round(percentage === 'remaining' ? 100 - used : used);
  const color = used >= 80 ? '#fa3048' : used >= 50 ? '#e9a400' : '#22a06b';
  const label = `${percentage === 'remaining' ? '남음' : '사용'} ${percent}%`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="8" viewBox="0 0 36 8"><rect width="36" height="8" rx="4" fill="#888888" fill-opacity="0.2"/><rect width="${36 * percent / 100}" height="8" rx="4" fill="${color}"/></svg>`;
  const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  return `![${label}](${image}|width=36,height=8 "초기화: ${reset}") <span style="color:${color};">${percent}%</span>`;
}

function appendWindow(tooltip: vscode.MarkdownString, window: QuotaWindow, percentage: 'used' | 'remaining', now: number): void {
  tooltip.appendText(window.label === '7d' ? 'wk' : window.label.replace(/[\r\n]+/g, ' '));
  tooltip.appendMarkdown(' ');
  const used = Number.isFinite(window.usedPercent) ? Math.max(0, Math.min(100, window.usedPercent)) : null;
  tooltip.appendMarkdown(used === null ? '—' : usageMeter(used, percentage, resetText(window, now)));
}

/** Quota labels remain plain text even though the tooltip allows our command links. */
export function createQuotaTooltip(
  states: readonly QuotaState[],
  settings: Pick<TrackerConfiguration, 'percentage' | 'detail'> & Partial<Pick<TrackerConfiguration, 'usageEnabled'>>,
  now = Date.now(),
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.supportThemeIcons = true;
  // Only controlled header markup and color spans are emitted; provider text still goes through appendText.
  tooltip.supportHtml = true;
  tooltip.isTrusted = { enabledCommands: commands };
  const refresh = states.some(state => state.refreshing)
    ? '$(sync~spin) 현재 사용량 조회 중…'
    : '<a href="command:agentTracker.refreshQuota">$(refresh) 새로고침</a>';
  tooltip.appendMarkdown(`<table width="100%"><tr><td><h3>사용량</h3></td><td align="right">${refresh}</td></tr></table>\n\n`);
  const successTimes = states.flatMap(state => state.lastSuccessAt !== null && Number.isFinite(state.lastSuccessAt) ? [state.lastSuccessAt] : []);
  tooltip.appendText(`마지막 갱신: ${successTimes.length ? new Date(Math.max(...successTimes)).toLocaleString('ko-KR') : '—'}`);
  tooltip.appendMarkdown('\n\n');
  tooltip.appendMarkdown('상태 표시줄: ');
  tooltip.appendMarkdown((['detailed', 'compact'] as const).map(detail => {
    const label = detail === 'detailed' ? '상세' : '압축';
    return settings.detail === detail ? `**${label}**` : commandLink(label, 'agentTracker.setStatusBarDetail', [detail]);
  }).join(' · '));

  for (const provider of ['codex', 'claude'] as const) {
    const state = states.find(value => value.provider === provider);
    if (!state) continue;
    const section = new vscode.MarkdownString();
    const name = provider === 'codex' ? 'Codex' : 'Claude';
    const windows = state.snapshot?.windows ?? [];
    const overall = windows.filter(window => provider === 'codex' ? window.limitId === 'codex' : window.id === 'five_hour' || window.id === 'seven_day');
    const standard = overall.length ? overall : windows.filter(window => window.label === '5h' || window.label === '7d');
    const main = [...(standard.length ? standard : windows)].sort((a, b) =>
      (a.windowDurationMins === 300 ? 0 : a.windowDurationMins === 10080 ? 1 : 2) - (b.windowDurationMins === 300 ? 0 : b.windowDurationMins === 10080 ? 1 : 2));
    const extra = windows.filter(window => !main.includes(window));
    const resets = main.flatMap(window => window.resetsAt !== null && Number.isFinite(window.resetsAt) ? [window.resetsAt] : []);
    const nextReset = resets.length ? Math.min(...resets) : null;
    const reset = nextReset === null ? '' : nextReset <= now ? '초기화 시각 지남 · 조회 대기' : `${countdown(nextReset, now)} 후 초기화`;
    section.appendMarkdown(`$(agent-tracker-${provider}) **${name}**${reset ? ` &nbsp;&nbsp; ${muted(reset)}` : ''}\n\n`);
    if (!windows.length) {
      section.appendMarkdown(state.refreshing ? '조회 중…\n\n' : '조회불가\n\n');
    } else {
      for (const [index, window] of main.entries()) {
        if (index) section.appendMarkdown(' &nbsp;&nbsp; ');
        appendWindow(section, window, settings.percentage, now);
      }
      for (const window of extra) {
        section.appendMarkdown('  \n');
        appendWindow(section, window, settings.percentage, now);
      }
      section.appendMarkdown('\n\n');
      const credits = provider === 'codex' ? state.snapshot?.rateLimitResetCredits : undefined;
      if (credits) {
        section.appendMarkdown(`${muted(`<strong>rate-limit 재설정 ${credits.availableCount}회 사용 가능</strong>`)}\n\n`);
        if (credits.nextExpiresAt !== null) {
          const expiry = credits.nextExpiresAt <= now ? '다음 항목의 만료 시각 지남 · 조회 대기' : `다음 항목이 ${countdown(credits.nextExpiresAt, now)} 후 만료됨`;
          section.appendMarkdown(`${muted(expiry)}\n\n`);
        }
      }
      if (state.refreshing) section.appendMarkdown('$(sync~spin) 갱신 중…\n\n');
      if (state.status === 'stale') section.appendMarkdown('$(history) 마지막 조회 값 · 현재 사용량 조회 불가\n\n');
    }
    if (state.error) {
      section.appendText(state.error.message);
      section.appendMarkdown('\n\n');
    }
    tooltip.appendMarkdown(`\n\n${sectionDivider}\n\n${section.value}`);
  }
  tooltip.appendMarkdown(`\n\n${sectionDivider}\n\n${settings.usageEnabled === false ? '$(graph) 사용량 통계 (꺼짐)' : commandLink('$(graph) 사용량 통계', 'agentTracker.openUsage')}`);
  tooltip.appendMarkdown(`\n\n${commandLink('$(settings-gear) 설정', 'agentTracker.openSettings')}`);
  return tooltip;
}
