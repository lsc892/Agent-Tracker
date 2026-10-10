import * as vscode from 'vscode';
import { writeFile } from 'node:fs/promises';
import type { QuotaState } from '../../src/quota/types';
import { QuotaStatusBar } from '../../src/ui/statusBar';
import { parseCodexQuota } from '../../src/quota/codex';

/** Synthetic quotas for the native popup screenshot test; no live account is read. */
export async function run(): Promise<void> {
  const now = Date.now();
  const states: QuotaState[] = (['codex', 'claude'] as const).map(provider => ({
    provider, status: 'ready', refreshing: false, error: null, lastSuccessAt: now, nextAllowedAt: 0,
    snapshot: { provider, fetchedAt: now,
      ...(provider === 'codex' ? { rateLimitResetCredits: { availableCount: 2, nextExpiresAt: now + (17 * 24 + 8) * 3_600_000 } } : {}),
      windows: [
        { id: provider === 'claude' ? 'five_hour' : 'codex:primary', limitId: provider, label: '5h', usedPercent: provider === 'codex' ? 69 : 33,
          current: 0, maximum: 100, resetsAt: now + (4 * 60 + 37) * 60_000, windowDurationMins: 300 },
        { id: provider === 'claude' ? 'seven_day' : 'codex:secondary', limitId: provider, label: '7d', usedPercent: provider === 'codex' ? 86 : 14,
          current: 0, maximum: 100, resetsAt: now + 6 * 86_400_000, windowDurationMins: 10080 },
        ...(provider === 'codex' ? parseCodexQuota({ rateLimitsByLimitId: {
          base_model_inference: { limitId: 'base_model_inference', limitName: 'gpt-reserve',
            secondary: { usedPercent: 0, resetsAt: (now + 7 * 86_400_000) / 1000, windowDurationMins: 10080 } },
          codex: { primary: null, secondary: null },
        } }, now).windows : []),
      ],
    },
  }));
  const update = QuotaStatusBar.prototype.update;
  QuotaStatusBar.prototype.update = function (_states, settings) { update.call(this, states, settings); };
  await vscode.extensions.getExtension('AgentTracker.agent-tracker')!.activate();
  const config = vscode.workspace.getConfiguration('agentTracker');
  await config.update('display.detail', 'detailed', vscode.ConfigurationTarget.Global);
  await config.update('display.detail', 'compact', vscode.ConfigurationTarget.Global);
  if (process.env.AGENT_TRACKER_QUOTA_FIXTURE_READY) await writeFile(process.env.AGENT_TRACKER_QUOTA_FIXTURE_READY, 'ready');
  // The CDP driver owns the isolated host lifetime and closes it after its assertions.
  await new Promise<void>(() => {});
}
