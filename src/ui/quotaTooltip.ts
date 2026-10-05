import * as vscode from 'vscode';
import type { TrackerConfiguration } from '../configuration';
import type { QuotaState, QuotaWindow } from '../quota/types';
import { remainingBar } from './statusBarPresentation';

const commands = [
  'agentTracker.refreshQuota', 'agentTracker.refreshClaude', 'agentTracker.refreshCodex',
  'agentTracker.openUsage', 'agentTracker.setStatusBarDetail', 'agentTracker.manageProvider',
];

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

/** Quota labels remain plain text even though the tooltip allows our command links. */
export function createQuotaTooltip(
  states: readonly QuotaState[],
  settings: Pick<TrackerConfiguration, 'percentage' | 'detail'>,
  now = Date.now(),
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.supportThemeIcons = true;
  tooltip.isTrusted = { enabledCommands: commands };
  tooltip.appendMarkdown('### 사용량\n\n');
  tooltip.appendMarkdown(states.some(state => state.refreshing)
    ? '$(sync~spin) 현재 사용량 조회 중…\n\n'
    : `${commandLink('$(refresh) 새로고침', 'agentTracker.refreshQuota')}\n\n`);
  tooltip.appendMarkdown('상태 표시줄: ');
  tooltip.appendMarkdown((['detailed', 'compact'] as const).map(detail => {
    const label = detail === 'detailed' ? '상세' : '압축';
    return settings.detail === detail ? `**${label}**` : commandLink(label, 'agentTracker.setStatusBarDetail', [detail]);
  }).join(' · '));

  for (const provider of ['codex', 'claude'] as const) {
    const state = states.find(value => value.provider === provider);
    if (!state) continue;
    const name = provider === 'codex' ? 'Codex' : 'Claude';
    const refresh = provider === 'codex' ? 'agentTracker.refreshCodex' : 'agentTracker.refreshClaude';
    tooltip.appendMarkdown(`\n\n---\n\n#### $(agent-tracker-${provider}) ${name}\n\n`);
    const windows = state.snapshot?.windows ?? [];
    if (!windows.length) {
      tooltip.appendMarkdown(state.refreshing ? '조회 중…\n\n' : '조회 불가\n\n');
    } else {
      const percentageLabel = settings.percentage === 'remaining' ? '남음' : '사용';
      tooltip.appendMarkdown(`| 기간 | 잔량 | ${percentageLabel} | 초기화 |\n| --- | --- | ---: | --- |\n`);
      for (const window of windows) {
        tooltip.appendMarkdown('| ');
        // Newlines and pipes cannot introduce extra rows or columns in this table.
        tooltip.appendText(window.label.replace(/[\r\n]+/g, ' ').replace(/\|/g, '｜'));
        const used = Number.isFinite(window.usedPercent) ? Math.max(0, Math.min(100, window.usedPercent)) : null;
        const value = used === null ? '—' : `${Math.round(settings.percentage === 'remaining' ? 100 - used : used)}%`;
        tooltip.appendMarkdown(` | ${used === null ? '—' : remainingBar(used)} | ${value} | ${resetText(window, now)} |\n`);
      }
      tooltip.appendMarkdown('\n');
      if (state.refreshing) tooltip.appendMarkdown('$(sync~spin) 갱신 중…\n\n');
      if (state.status === 'stale') tooltip.appendMarkdown('$(history) 마지막 조회 값 · 현재 사용량 조회 불가\n\n');
    }
    if (state.error) {
      tooltip.appendText(state.error.message);
      tooltip.appendMarkdown('\n\n');
    }
    if (state.lastSuccessAt !== null && Number.isFinite(state.lastSuccessAt)) {
      tooltip.appendText(`마지막 갱신: ${new Date(state.lastSuccessAt).toLocaleString('ko-KR')}`);
      tooltip.appendMarkdown('\n\n');
    }
    if (!state.refreshing) tooltip.appendMarkdown(`${commandLink('새로고침', refresh)} · `);
    tooltip.appendMarkdown(commandLink('확장 관리', 'agentTracker.manageProvider', [provider]));
  }
  tooltip.appendMarkdown(`\n\n---\n\n${commandLink('$(graph) 사용량 통계', 'agentTracker.openUsage')}`);
  return tooltip;
}
