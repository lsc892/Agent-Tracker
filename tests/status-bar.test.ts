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
  assert.equal(view.text, '$(agent-tracker-codex) 7일 $(agent-tracker-quota-1) 92% 사용 5d 21h · 5시간 $(agent-tracker-quota-8) 23% 사용 2h 52m');
  assert.match(view.accessibleText, /Codex: 7일: 92% 사용, 재설정 5d 21h, 5시간: 23% 사용/);
  assert.doesNotMatch(view.accessibleText, /\$\(/);
  const compact = statusBarPresentation(state, 'remaining', 'compact', 0);
  assert.equal(compact.text, '$(agent-tracker-codex) 5시간 $(agent-tracker-quota-8) 77% 남음 2h 52m');
  assert.equal(remainingBar(100), '$(agent-tracker-quota-0)');
  assert.equal(remainingBar(0), '$(agent-tracker-quota-10)');
  assert.equal(remainingBar(120), '$(agent-tracker-quota-0)');
});

test('compact status uses the five-hour window for both providers regardless of usage or source order', () => {
  for (const provider of ['claude','codex'] as const) {
    const windows=[...state.snapshot!.windows].reverse();
    const view=statusBarPresentation({...state,provider,snapshot:{...state.snapshot!,provider,windows}},'used','compact',0);
    assert.match(view.text,/5시간 .*23% 사용 2h 52m/);
    assert.doesNotMatch(view.text,/7일|92%|5d 21h/);
  }
});

test('compact status does not substitute weekly quota when the five-hour window is absent', () => {
  const weeklyOnly={...state,snapshot:{...state.snapshot!,windows:[state.snapshot!.windows[1]]}};
  assert.equal(statusBarPresentation(weeklyOnly,'used','compact',0).text,'$(agent-tracker-codex) 5시간 정보 없음');
  assert.match(statusBarPresentation(weeklyOnly,'used','detailed',0).text,/7일 .*92% 사용/);
});

test('status prefers overall provider windows while other quota buckets remain available to the panel', () => {
  const windows=state.snapshot!.windows.map(window=>({...window,limitId:'codex'}));
  const codex={...state,snapshot:{...state.snapshot!,windows:[{...windows[0],id:'review:primary',limitId:'review',usedPercent:99},...windows]}};
  assert.match(statusBarPresentation(codex,'used','compact',0).text,/23% 사용/);
  assert.doesNotMatch(statusBarPresentation(codex,'used','detailed',0).text,/99%/);
  const claude={...state,provider:'claude' as const,snapshot:{...state.snapshot!,provider:'claude' as const,windows:[
    {...windows[1],id:'seven_day_sonnet',usedPercent:99},
    {...windows[0],id:'five_hour'},{...windows[1],id:'seven_day'},
  ]}};
  assert.match(statusBarPresentation(claude,'used','detailed',0).text,/7일 .*92% 사용.*5시간 .*23% 사용/);
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
