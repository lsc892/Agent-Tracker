// 제공자별 quota와 초기화 시각·조회 상태를 Markdown 툴팁으로 구성한다.
import { getLocale, t } from '../localization';
import * as vscode from 'vscode';
import type { TrackerConfiguration } from '../configuration';
import type { DisplayPercentage } from '../configuration/schema';
import type { QuotaState, QuotaWindow } from '../quota/types';

const commands = [
  'agentTracker.refreshQuota', 'agentTracker.openUsage',
  'agentTracker.setStatusBarDetail', 'agentTracker.openSettings',
];

// Native hover rules extend through the content padding to both card edges.
const sectionDivider = '---';

type TooltipSettings = {
  display: Pick<TrackerConfiguration['display'], 'percentage' | 'detail'>;
  usage?: Pick<TrackerConfiguration['usage'], 'enabled'>;
  codex?: Pick<TrackerConfiguration['codex'], 'showReserve' | 'showResetCredits'>;
};

function commandLink(label: string, command: string, args?: string[]): string {
  const query = args ? `?${encodeURIComponent(JSON.stringify(args))}` : '';
  return `[${label}](command:${command}${query})`;
}

function resetText(window: QuotaWindow, now: number): string {
  if (window.resetsAt === null || !Number.isFinite(window.resetsAt)) return '—';
  const minutes = Math.max(0, Math.ceil((window.resetsAt - now) / 60_000));
  if (!minutes) return t('quota.resetElapsed');
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  return t('quota.afterDuration', { value0: [days ? t('quota.days', { value0: days }) : '', hours ? t('quota.hours', { value0: hours }) : '', t('quota.minutes', { value0: minutes % 60 })].filter(Boolean).join(' ') });
}

function countdown(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.ceil((timestamp - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  if (days) return t('duration.daysHours', { value0: days, value1: hours });
  if (hours) return t('duration.hoursMinutes', { value0: hours, value1: minutes % 60 });
  return t('duration.minutes', { value0: minutes });
}

function muted(text: string): string {
  return `<span style="color:var(--vscode-descriptionForeground);">${text}</span>`;
}

function usageMeter(used: number, percentage: DisplayPercentage, reset: string, width: number, table = false): string {
  const percent = Math.round(percentage === 'remaining' ? 100 - used : used);
  const color = used >= 80 ? '#fa3048' : used >= 50 ? '#e9a400' : '#22a06b';
  const label = t(percentage === 'remaining' ? 'quota.remainingPercentage' : 'quota.usedPercentage', { value0: percent });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="8" viewBox="0 0 ${width} 8"><rect width="${width}" height="8" rx="4" fill="#888888" fill-opacity="0.2"/><rect width="${width * percent / 100}" height="8" rx="4" fill="${color}"/></svg>`;
  const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  return `![${label}](${image}${table ? '\\|' : '|'}width=${width},height=8 "${t('quota.resetTitle', {value0: reset})}") <span style="color:${color};">${percent}%</span>`;
}

function appendWindow(tooltip: vscode.MarkdownString, window: QuotaWindow, percentage: DisplayPercentage, now: number, width: number, table = false): void {
  tooltip.appendText(window.label === '7d' ? 'wk' : window.label.replace(/[\r\n]+/g, ' '));
  tooltip.appendMarkdown(' ');
  const used = Number.isFinite(window.usedPercent) ? Math.max(0, Math.min(100, window.usedPercent)) : null;
  tooltip.appendMarkdown(used === null ? '—' : usageMeter(used, percentage, resetText(window, now), width, table));
}

function resetCaption(window: QuotaWindow, now: number): string {
  if (window.resetsAt === null || !Number.isFinite(window.resetsAt)) return t('quota.resetUnknown');
  if (window.resetsAt <= now) return t('quota.resetElapsed');
  return t('quota.resetIn', { value0: countdown(window.resetsAt, now) });
}

/**
 * 책임: 네이티브 Markdown 카드에서 형제 사용률 막대의 폭을 맞춘다.
 * 알고리즘: 초기화 안내의 문자 폭을 한글 등 비ASCII와 ASCII로 나눠 추정하고 상·하한을 적용한 최댓값으로 공통 막대 폭을 정한다.
 */
function meterWidth(windows: readonly QuotaWindow[], now: number): number {
  // Native Markdown hovers do not expose font metrics or allow arbitrary layout styles.
  // Estimate full-width Korean characters separately, and keep sibling meters aligned.
  const width = windows.reduce((width, window) => {
    const captionWidth = Array.from(resetCaption(window, now)).reduce((total, char) => total + (char.charCodeAt(0) > 127 ? 14 : 7), 0);
    return Math.max(width, Math.min(160, captionWidth));
  }, 96);
  return Math.round(width * 0.8) - 15;
}

/**
 * 책임: 공통 quota 카드에 사용률·초기화·오래된 값·허용된 동작을 표시한다.
 * 알고리즘: 제공자별 표시 정책으로 창을 고르고 기본 기간·추가 창을 배치하며, 외부 문구는 plain text로 넣고 명시된 command 링크만 허용한다.
 */
export function createQuotaTooltip(
  states: readonly QuotaState[],
  settings: TooltipSettings,
  now = Date.now(),
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.supportThemeIcons = true;
  // Only controlled header markup and color spans are emitted; provider text still goes through appendText.
  tooltip.supportHtml = true;
  tooltip.isTrusted = { enabledCommands: commands };
  const refresh = states.some(state => state.refreshing)
    ? t('quota.loading')
    : `<a href="command:agentTracker.refreshQuota">$(refresh) ${t('common.refresh')}</a>`;
  tooltip.appendMarkdown(`<table width="100%"><tr><td><h3>${t('quota.usage')}</h3></td><td align="right">${refresh}</td></tr></table>\n\n`);
  const successTimes = states.flatMap(state => state.lastSuccessAt !== null && Number.isFinite(state.lastSuccessAt) ? [state.lastSuccessAt] : []);
  tooltip.appendText(t('quota.lastUpdated', { value0: successTimes.length ? new Date(Math.max(...successTimes)).toLocaleString(getLocale()) : '—' }));
  tooltip.appendMarkdown('\n\n');
  tooltip.appendMarkdown(t('quota.statusBarLabel'));
  tooltip.appendMarkdown((['detailed', 'compact'] as const).map(detail => {
    const label = detail === 'detailed' ? t('quota.detailed') : t('quota.compact');
    return settings.display.detail === detail ? `**${label}**` : commandLink(label, 'agentTracker.setStatusBarDetail', [detail]);
  }).join(' · '));

  for (const provider of ['codex', 'claude'] as const) {
    const state = states.find(value => value.provider === provider);
    if (!state) continue;
    const section = new vscode.MarkdownString();
    appendProviderWindows(section, state, provider, settings, now);
    appendResetCredits(section, state, provider, settings, now);
    appendProviderStatus(section, state);
    tooltip.appendMarkdown(`\n\n${sectionDivider}\n\n${section.value}`);
  }
  tooltip.appendMarkdown(`\n\n${sectionDivider}\n\n${settings.usage?.enabled === false ? t('quota.statisticsDisabled') : commandLink(t('quota.statistics'), 'agentTracker.openUsage')}`);
  tooltip.appendMarkdown(`\n\n${commandLink(t('quota.settings'), 'agentTracker.openSettings')}`);
  return tooltip;
}

function appendProviderWindows(section: vscode.MarkdownString, state: QuotaState, provider: QuotaState['provider'], settings: TooltipSettings, now: number): void {
  const name = provider === 'codex' ? 'Codex' : 'Claude';
  // The server reports gpt-reserve under limitId=base_model_inference.
  // Retain the name separately: single-bucket labels contain only the duration.
  const windows = (state.snapshot?.windows ?? []).filter(window =>
    provider !== 'codex' || settings.codex?.showReserve === true ||
    window.limitId !== 'gpt-reserve' && window.limitName !== 'gpt-reserve');
  const overall = windows.filter(window => provider === 'codex' ? window.limitId === 'codex' : window.id === 'five_hour' || window.id === 'seven_day');
  const standard = overall.length ? overall : windows.filter(window => window.label === '5h' || window.label === '7d');
  const main = [...(standard.length ? standard : windows)].sort((a, b) => windowPriority(a) - windowPriority(b));
  const extra = windows.filter(window => !main.includes(window));
  section.appendMarkdown(`$(agent-tracker-${provider}) **${name}**\n\n`);
  if (!windows.length) {
    section.appendMarkdown(emptyWindowsMessage(state));
    return;
  }

  const width = meterWidth(main, now);
  const columnGap = (index: number): string => index < main.length - 1 ? ' &nbsp;&nbsp;&nbsp;' : '';
  section.appendMarkdown('| ' + main.map((window, index) => {
    const cell = new vscode.MarkdownString();
    appendWindow(cell, window, settings.display.percentage, now, width, true);
    return cell.value + columnGap(index);
  }).join(' | ') + ' |\n');
  section.appendMarkdown('| ' + main.map(() => ':---').join(' | ') + ' |\n');
  section.appendMarkdown('| ' + main.map((window, index) => muted(resetCaption(window, now)) + columnGap(index)).join(' | ') + ' |\n');
  for (const window of extra) {
    section.appendMarkdown('\n\n');
    appendWindow(section, window, settings.display.percentage, now, meterWidth([window], now));
    section.appendMarkdown(`  \n${muted(resetCaption(window, now))}`);
  }
  section.appendMarkdown('\n\n');
}

function windowPriority(window: QuotaWindow): number {
  if (window.windowDurationMins === 300) return 0;
  if (window.windowDurationMins === 10080) return 1;
  return 2;
}

function emptyWindowsMessage(state: QuotaState): string {
  if (state.snapshot?.windows.length) return t('quota.noVisibleWindows');
  return state.refreshing ? t('quota.loadingLine') : t('quota.unavailableLine');
}

function appendResetCredits(section: vscode.MarkdownString, state: QuotaState, provider: QuotaState['provider'], settings: TooltipSettings, now: number): void {
  const credits = provider === 'codex' && settings.codex?.showResetCredits !== false ? state.snapshot?.rateLimitResetCredits : undefined;
  if (!credits) return;
  section.appendMarkdown(`${muted(`<strong>${t('quota.resetCredits', { value0: credits.availableCount })}</strong>`)}\n\n`);
  if (credits.nextExpiresAt === null) return;
  const expiry = credits.nextExpiresAt <= now ? t('quota.expiryElapsed') : t('quota.expiresIn', { value0: countdown(credits.nextExpiresAt, now) });
  section.appendMarkdown(`${muted(expiry)}\n\n`);
}

function appendProviderStatus(section: vscode.MarkdownString, state: QuotaState): void {
  const hasSnapshot = !!state.snapshot;
  if (hasSnapshot && state.refreshing) section.appendMarkdown(t('quota.refreshingLine'));
  if (hasSnapshot && state.status === 'stale') section.appendMarkdown(t('quota.staleLine'));
  if (!state.error) return;
  section.appendText(state.error.translation ? t(state.error.translation.key, state.error.translation.values) : state.error.message);
  section.appendMarkdown('\n\n');
}
