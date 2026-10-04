import type { QuotaState, QuotaWindow } from '../quota/types';

/** StatusBarItem accepts contributed font icons, rather than SVG or HTML. */
export function remainingBar(usedPercent: number): string {
  const remaining = Math.max(0, Math.min(100, 100 - usedPercent));
  return `$(agent-tracker-quota-${Math.round(remaining / 10)})`;
}

function resetTime(window: QuotaWindow, now: number): string {
  if (window.resetsAt === null) return '';
  const minutes = Math.max(0, Math.ceil((window.resetsAt - now) / 60_000));
  if (!minutes) return '재설정 대기';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}d ${hours}h`;
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export function statusBarPresentation(
  state: QuotaState,
  percentage: 'used' | 'remaining',
  detail: 'compact' | 'detailed',
  now = Date.now(),
): { text: string; accessibleText: string } {
  const name = state.provider === 'claude' ? 'Claude' : 'Codex';
  const icon = `$(agent-tracker-${state.provider})`;
  const windows = state.snapshot?.windows ?? [];
  if (!windows.length) {
    const message = state.refreshing ? '조회 중…' : '조회 불가.';
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
  if (!selected.length) return { text: `${icon} 5시간 정보 없음`, accessibleText: `${name}: 5시간 정보 없음` };
  const values = selected.map(window => {
    const used = Math.max(0, Math.min(100, window.usedPercent));
    const percent = Math.round(percentage === 'remaining' ? 100 - used : used);
    const label = percentage === 'remaining' ? '남음' : '사용';
    const resets = resetTime(window, now);
    const period = window.windowDurationMins === 300 ? '5시간' : window.windowDurationMins === 10080 ? '7일' : window.label;
    return {
      text: `${period} ${remainingBar(used)} ${percent}% ${label}${resets ? ` ${resets}` : ''}`,
      accessibleText: `${period}: ${percent}% ${label}${resets ? `, 재설정 ${resets}` : ''}`,
    };
  });
  const stale = state.status === 'stale';
  return {
    text: `${icon} ${values.map(value => value.text).join(' · ')}${stale ? ' $(history)' : ''}`,
    accessibleText: `${name}: ${values.map(value => value.accessibleText).join(', ')}${stale ? ', 이전 조회 값' : ''}`,
  };
}

