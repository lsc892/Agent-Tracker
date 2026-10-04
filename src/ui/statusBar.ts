import * as vscode from 'vscode';
import type { TrackerConfiguration } from '../configuration';
import type { QuotaState } from '../quota/types';
import { statusBarPresentation } from './statusBarPresentation';
export { statusBarPresentation, remainingBar } from './statusBarPresentation';

type StatusSettings = Pick<TrackerConfiguration, 'percentage' | 'detail' | 'claude' | 'codex'>;

/** One combined quota button, followed by a refresh button on its right. */
export class QuotaStatusBar implements vscode.Disposable {
  private readonly quota = vscode.window.createStatusBarItem('agentTracker.quota', vscode.StatusBarAlignment.Right, -1000);
  private readonly refresh = vscode.window.createStatusBarItem('agentTracker.refreshQuota', vscode.StatusBarAlignment.Right, -1001);
  private readonly themeSubscription: vscode.Disposable;
  private readonly clock: ReturnType<typeof setInterval>;
  private latest: { states: readonly QuotaState[]; settings: StatusSettings } | undefined;

  constructor() {
    this.quota.name = 'Agent Tracker: 사용량';
    this.quota.command = 'agentTracker.toggleQuota';
    this.refresh.name = 'Agent Tracker: 현재 사용량 새로고침';
    this.refresh.command = 'agentTracker.refreshQuota';
    this.refresh.tooltip = '현재 Claude/Codex 사용량 새로고침';
    this.refresh.accessibilityInformation = { label: 'Claude와 Codex 현재 사용량 새로고침', role: 'button' };
    this.themeSubscription = vscode.window.onDidChangeActiveColorTheme(() => this.applyTheme());
    this.applyTheme();
    // Relative reset times advance without starting provider reads or summary scans.
    this.clock = setInterval(() => {
      if (this.latest) this.update(this.latest.states, this.latest.settings);
    }, 60_000);
    this.clock.unref();
  }

  update(states: readonly QuotaState[], settings: StatusSettings): void {
    this.latest = { states, settings };
    const visible = ['claude', 'codex'].flatMap(provider => states.filter(state => state.provider === provider && settings[state.provider].showStatusBar));
    const views = visible.map(state => statusBarPresentation(state, settings.percentage, settings.detail));
    this.quota.text = views.map(view => view.text).join('   ');
    this.quota.tooltip = `${views.map(view => view.accessibleText).join('\n')}\n클릭하여 사용량 열기 / 닫기`;
    this.quota.accessibilityInformation = { label: `${views.map(view => view.accessibleText).join('. ')}. 사용량 열기 / 닫기`, role: 'button' };
    this.refresh.text = states.some(state => state.refreshing) ? '$(sync~spin)' : '$(refresh)';
    if (visible.length) {
      this.quota.show();
      this.refresh.show();
    } else {
      this.quota.hide();
      this.refresh.hide();
    }
  }

  private applyTheme(): void {
    const kind = vscode.window.activeColorTheme.kind;
    // A status item has one foreground color for all its text and icon glyphs.
    this.quota.color = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? '#000000' : '#ffffff';
  }

  dispose(): void {
    clearInterval(this.clock);
    this.themeSubscription.dispose();
    this.quota.dispose();
    this.refresh.dispose();
  }
}
