import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { remainingBar, statusBarPresentation } from '../src/ui/statusBarPresentation';
import type { QuotaState } from '../src/quota/types';

const state: QuotaState = {
  provider: 'codex', status: 'ready', refreshing: false, lastSuccessAt: 0, error: null, nextAllowedAt: 0,
  snapshot: { provider: 'codex', fetchedAt: 0, windows: [
    { id: 'primary', label: '5h', usedPercent: 23, current: 23, maximum: 100, resetsAt: 10_320_000, windowDurationMins: 300 },
    { id: 'secondary', label: '7d', usedPercent: 92, current: 92, maximum: 100, resetsAt: 507_600_000, windowDurationMins: 10080 },
  ] },
};

test('status uses logo glyphs, remaining meters, reset times, and accessible provider names', () => {
  const view = statusBarPresentation(state, 'used', 'detailed', 0);
  assert.equal(view.text, '$(agent-tracker-codex) $(agent-tracker-quota-8) 23% 사용 2h 52m · $(agent-tracker-quota-1) 92% 사용 5d 21h');
  assert.match(view.accessibleText, /Codex: 5h: 23% 사용/);
  assert.doesNotMatch(view.accessibleText, /\$\(/);
  const compact = statusBarPresentation(state, 'remaining', 'compact', 0);
  assert.equal(compact.text, '$(agent-tracker-codex) $(agent-tracker-quota-1) 8% 남음 5d 21h');
  assert.equal(remainingBar(100), '$(agent-tracker-quota-0)');
  assert.equal(remainingBar(0), '$(agent-tracker-quota-10)');
  assert.equal(remainingBar(120), '$(agent-tracker-quota-0)');
});

test('unavailable, refreshing, and stale states remain distinct', () => {
  const unavailable = { ...state, provider: 'claude' as const, snapshot: null };
  assert.equal(statusBarPresentation(unavailable, 'used', 'detailed').text, '$(agent-tracker-claude) 조회 불가.');
  assert.equal(statusBarPresentation({ ...unavailable, refreshing: true }, 'used', 'detailed').text, '$(agent-tracker-claude) 조회 중…');
  assert.match(statusBarPresentation({ ...state, status: 'stale' }, 'used', 'compact', 0).text, /\$\(history\)/);
  assert.match(statusBarPresentation(state, 'used', 'compact', 600_000_000).text, /재설정 대기/);
});

test('every status meter and logo references a shipped contributed icon font', () => {
  const root = join(__dirname, '../..');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    contributes: { icons: Record<string, { default: { fontPath: string; fontCharacter: string } }> };
  };
  const ids = ['agent-tracker-codex', 'agent-tracker-claude', ...Array.from({ length: 11 }, (_, step) => `agent-tracker-quota-${step}`)];
  const codes = new Set<string>();
  for (const id of ids) {
    const icon = manifest.contributes.icons[id].default;
    assert.match(icon.fontCharacter, /^\\e[0-9a-f]{3}$/);
    codes.add(icon.fontCharacter);
    assert.equal(readFileSync(join(root, icon.fontPath)).subarray(0, 4).toString(), 'wOFF');
  }
  assert.equal(codes.size, ids.length);
});
