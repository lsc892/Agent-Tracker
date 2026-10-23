import { t } from '../localization';
import type { QuotaState, QuotaWindow } from '../quota/types';
import type { DisplayPercentage, DisplayDetail } from '../configuration/schema';

/** StatusBarItem accepts contributed font icons, rather than SVG or HTML. */
export function remainingBar(usedPercent: number): string {
  const remaining = Math.max(0, Math.min(100, 100 - usedPercent));
  return `$(agent-tracker-quota-${Math.round(remaining / 10)})`;
}

function resetTime(window: QuotaWindow, now: number): string {
  if (window.resetsAt === null || !Number.isFinite(window.resetsAt)) return '';
  const minutes = Math.max(0, Math.ceil((window.resetsAt - now) / 60_000));
  if (!minutes) return t('status.waitingReset');
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return t('duration.daysHours', { value0: days, value1: hours });
  return hours ? t('duration.hoursMinutes', { value0: hours, value1: minutes % 60 }) : t('duration.minutes', { value0: minutes });
}

/** A short, plain-text preview, also used as the status item's accessible label. */
export function quotaHoverSummary(states: readonly QuotaState[], now = Date.now()): string {
  const lines = (['claude', 'codex'] as const).map(provider => {
    const state = states.find(value => value.provider === provider);
    if (!state) return undefined;
    return statusBarPresentation(state, 'remaining', 'compact', now, true).accessibleText;
  }).filter((line): line is string => line !== undefined);
  return [...lines, t('status.toggleHint')].join('\n');
}

/**
 * 책임: quota 상태를 짧은 상태바 문구와 접근성 설명으로 변환한다.
 * 알고리즘: 기본 Codex 한도와 5시간·7일 창을 우선 선택하고 표시 모드에 맞춰 사용·잔여 백분율·초기화 시간·오래된 값 표시를 조합한다.
 */
export function statusBarPresentation(
  state: QuotaState,
  percentage: DisplayPercentage,
  detail: DisplayDetail,
  now = Date.now(),
  hover = false,
): { text: string; accessibleText: string } {
  const name = state.provider === 'claude' ? 'Claude' : 'Codex';
  const icon = `$(agent-tracker-${state.provider})`;
  const windows = state.snapshot?.windows ?? [];
  if (!windows.length) {
    const message = state.refreshing ? t('status.loading') : t('status.unavailable');
    return { text: `${icon} ${message}`, accessibleText: `${name}: ${message}` };
  }
  const codexWindows = state.provider === 'codex' ? windows.filter(window => window.limitId === 'codex') : [];
  const mainWindows = codexWindows.length ? codexWindows : windows;
  const fiveHour = mainWindows.find(window => window.id === 'five_hour')
    ?? mainWindows.find(window => window.windowDurationMins === 300);
  const sevenDay = mainWindows.find(window => window.id === 'seven_day')
    ?? mainWindows.find(window => window.windowDurationMins === 10080);
  const selected = detail === 'compact'
    ? fiveHour ? [fiveHour] : []
    : fiveHour || sevenDay ? [sevenDay, fiveHour].filter((window): window is QuotaWindow => window !== undefined) : mainWindows.slice(0, 2);
  if (!selected.length) return { text: t('status.missingFiveHour', { value0: icon }), accessibleText: t('status.missingFiveHourAccessible', { value0: name }) };
  const values = selected.map(window => {
    const used = Math.max(0, Math.min(100, window.usedPercent));
    const percent = Math.round(percentage === 'remaining' ? 100 - used : used);
    const label = t(percentage === 'remaining' ? 'quota.remainingPercentage' : 'quota.usedPercentage', { value0: percent });
    const resets = resetTime(window, now);
    const period = window.windowDurationMins === 300 ? t('status.fiveHour') : window.windowDurationMins === 10080 ? t('status.sevenDay') : window.label;
    return {
      text: `${period} ${remainingBar(used)} ${label}${resets ? ` ${resets}` : ''}`,
      accessibleText: `${period}${hover ? ' -' : ':'} ${label}${resets ? t(hover ? 'status.resetUntil' : 'status.resetSuffix', { value0: resets }) : ''}`,
    };
  });
  const stale = state.status === 'stale';
  return {
    text: `${icon} ${values.map(value => value.text).join(' · ')}${stale ? ' $(history)' : ''}`,
    accessibleText: `${name}: ${values.map(value => value.accessibleText).join(', ')}${stale ? t('status.staleSuffix') : ''}`,
  };
}
