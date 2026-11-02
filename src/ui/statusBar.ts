// quota 상태를 VS Code 상태바 항목과 새로고침 버튼에 반영한다.
import { t } from '../localization';
import * as vscode from 'vscode';
import type { TrackerConfiguration } from '../configuration';
import type { QuotaState } from '../quota/types';
import { quotaHoverSummary, statusBarPresentation } from './statusBarPresentation';
import { createQuotaTooltip } from './quotaTooltip';
import { statusForeground } from './colors';
export { statusBarPresentation, remainingBar } from './statusBarPresentation';

type StatusSettings = Pick<TrackerConfiguration, 'display' | 'claude' | 'codex' | 'usage'>;

/** quota 상태바 항목·툴팁·새로고침 버튼과 남은 시간의 주기적 표시를 관리한다. */
export class QuotaStatusBar implements vscode.Disposable {
  private readonly quota = vscode.window.createStatusBarItem('agentTracker.quota', vscode.StatusBarAlignment.Right, -1000);
  private readonly refresh = vscode.window.createStatusBarItem('agentTracker.refreshQuota', vscode.StatusBarAlignment.Right, -1001);
  private readonly clock: ReturnType<typeof setInterval>;
  private latest: { states: readonly QuotaState[]; settings: StatusSettings } | undefined;

  constructor() {
    this.quota.name = t('status.name');
    this.quota.command = 'agentTracker.toggleQuotaTooltip';
    this.refresh.name = t('status.refreshName');
    this.refresh.command = 'agentTracker.refreshQuota';
    this.refresh.tooltip = t('status.refreshTooltip');
    this.refresh.accessibilityInformation = { label: t('status.refreshAccessible'), role: 'button' };
    // Relative reset times advance without starting provider reads or summary scans.
    this.clock = setInterval(() => {
      if (this.latest) this.update(this.latest.states, this.latest.settings);
    }, 60_000);
    this.clock.unref();
  }

  /**
   * 책임: 현재 설정에 맞는 상태바 텍스트·quota 카드·새로고침 상태를 반영한다.
   * 알고리즘: 활성·표시 설정으로 제공자를 선택해 순서대로 조합하고 공통 색상·접근성 설명·갱신 아이콘을 적용하며 표시 대상이 없으면 항목을 숨긴다.
   */
  update(states: readonly QuotaState[], settings: StatusSettings): void {
    this.quota.name = t('status.name');
    this.refresh.name = t('status.refreshName');
    this.refresh.tooltip = t('status.refreshTooltip');
    this.refresh.accessibilityInformation = { label: t('status.refreshAccessible'), role: 'button' };
    this.latest = { states, settings };
    const color = statusForeground(settings.display.colorMode, settings.display.customColor);
    this.quota.color = color;
    this.refresh.color = color;
    const tracked = states.filter(state => settings[state.provider].enabled);
    const visible = ['claude', 'codex'].flatMap(provider => tracked.filter(state => state.provider === provider && (state.provider === 'claude' || settings.codex.showStatusBar)));
    const views = visible.map(state => statusBarPresentation(state, settings.display.percentage, settings.display.detail));
    this.quota.text = views.map(view => view.text).join('  │  ');
    this.quota.tooltip = createQuotaTooltip(tracked, settings);
    // Mouse hover and the native click toggle share the Markdown card above.
    // Keep the plain-text quota summary available to screen readers.
    this.quota.accessibilityInformation = { label: quotaHoverSummary(tracked), role: 'button' };
    this.refresh.text = tracked.some(state => state.refreshing) ? '$(sync~spin)' : '$(refresh)';
    if (visible.length) {
      this.quota.show();
      this.refresh.show();
    } else {
      this.quota.hide();
      this.refresh.hide();
    }
  }

  dispose(): void {
    clearInterval(this.clock);
    this.quota.dispose();
    this.refresh.dispose();
  }
}
