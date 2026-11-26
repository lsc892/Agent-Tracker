// quota 상태를 상태바 문구·백분율 아이콘·접근성 설명으로 변환한다.
import { t } from '../localization';
import type { QuotaState, QuotaWindow } from '../quota/types';
import type { DisplayPercentage, DisplayDetail } from '../configuration/schema';

/** StatusBarItem accepts contributed font icons, rather than SVG or HTML. */
function quotaBar(percent: number): string {
  // [표시 정책] 백분율을 0~100으로 제한하고 10% 단위의 가장 가까운 아이콘을 고른다.
  const filled = Math.max(0, Math.min(100, percent));
  return `$(agent-tracker-quota-${Math.round(filled / 10)})`;
}

export function remainingBar(usedPercent: number): string {
  return quotaBar(100 - usedPercent);
}

function resetTime(window: QuotaWindow, now: number): string {
  // [기간 정책] 초기화까지 남은 시간을 분 단위로 올림하고 경과한 시각은 대기 상태로 표시한다.
  if (window.resetsAt === null || !Number.isFinite(window.resetsAt)) return '';
  const minutes = Math.max(0, Math.ceil((window.resetsAt - now) / 60_000));
  if (!minutes) return t('status.waitingReset');
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return t('duration.daysHours', { value0: days, value1: hours });
  return hours ? t('duration.hoursMinutes', { value0: hours, value1: minutes % 60 }) : t('duration.minutes', { value0: minutes });
}

/** A detailed accessible label, independent of the status bar's display mode. */
export function quotaHoverSummary(states: readonly QuotaState[], now = Date.now()): string {
  // [접근성 정책] 상태바 설정과 무관하게 Codex·Claude 순으로 상세 잔여 한도를 읽어 준다.
  const lines = (['codex', 'claude'] as const).map(provider => {
    const state = states.find(value => value.provider === provider);
    if (!state) return undefined;
    return statusBarPresentation(state, 'remaining', 'detailed', now, true).accessibleText;
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
  // [한도 정책] Codex 기본 한도가 있으면 우선하고 5시간·7일 창은 ID 다음에 기간으로 찾는다.
  const codexWindows = state.provider === 'codex' ? windows.filter(window => window.limitId === 'codex') : [];
  const mainWindows = codexWindows.length ? codexWindows : windows;
  const fiveHour = mainWindows.find(window => window.id === 'five_hour')
    ?? mainWindows.find(window => window.windowDurationMins === 300);
  const sevenDay = mainWindows.find(window => window.id === 'seven_day')
    ?? mainWindows.find(window => window.windowDurationMins === 10080);
  const selected = selectStatusWindows(detail, fiveHour, sevenDay, mainWindows);
  if (!selected.length) return { text: t('status.missingFiveHour', { value0: icon }), accessibleText: t('status.missingFiveHourAccessible', { value0: name }) };
  // [표시 정책] 사용·잔여 모드에 맞게 백분율을 계산하고 같은 값으로 문구와 접근성 설명을 만든다.
  const values = selected.map(window => {
    const used = Math.max(0, Math.min(100, window.usedPercent));
    const percent = Math.round(percentage === 'remaining' ? 100 - used : used);
    const label = t(percentage === 'remaining' ? 'quota.remainingPercentage' : 'quota.usedPercentage', { value0: percent });
    const resets = resetTime(window, now);
    const period = windowPeriod(window);
    return {
      text: `${period} ${quotaBar(percent)} ${label}${resets ? ` ${resets}` : ''}`,
      accessibleText: `${period}${hover ? ' -' : ':'} ${label}${resets ? t(hover ? 'status.resetUntil' : 'status.resetSuffix', { value0: resets }) : ''}`,
    };
  });
  const stale = state.status === 'stale';
  return {
    text: `${icon} ${values.map(value => value.text).join(' · ')}${stale ? ' $(history)' : ''}`,
    accessibleText: `${name}: ${values.map(value => value.accessibleText).join(', ')}${stale ? t('status.staleSuffix') : ''}`,
  };
}

function selectStatusWindows(detail: DisplayDetail, fiveHour: QuotaWindow | undefined, sevenDay: QuotaWindow | undefined, mainWindows: readonly QuotaWindow[]): QuotaWindow[] {
  // [한도 정책] 간결 모드는 5시간만, 상세 모드는 표준 창을 우선하고 없으면 처음 두 창을 표시한다.
  if (detail === 'compact') return fiveHour ? [fiveHour] : [];
  if (fiveHour || sevenDay) return [sevenDay, fiveHour].filter((window): window is QuotaWindow => window !== undefined);
  return mainWindows.slice(0, 2);
}

function windowPeriod(window: QuotaWindow): string {
  if (window.windowDurationMins === 300) return t('status.fiveHour');
  if (window.windowDurationMins === 10080) return t('status.sevenDay');
  return window.label;
}
