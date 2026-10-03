import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { dashboardHtml } from '../src/ui/html';
import { parseDashboardMessage, statusPresentation } from '../src/ui/presentation';
import type { QuotaState } from '../src/quota/types';

const state: QuotaState = { provider: 'claude', status: 'ready', refreshing: false, lastSuccessAt: 1, error: null, nextAllowedAt: 0,
  snapshot: { provider: 'claude', fetchedAt: 1, windows: [
    { id: 'a', label: '5h', current: 42, maximum: 100, usedPercent: 42, resetsAt: 2, windowDurationMins: 300 },
    { id: 'b', label: '7d', current: 92, maximum: 100, usedPercent: 92, resetsAt: 3, windowDurationMins: 10080 },
  ] } };

test('status bar uses observed windows and used threshold in remaining mode', () => {
  assert.deepEqual(statusPresentation(state, 'remaining', 'compact'), { text: 'Claude 남음 7d:8%', warning: true });
  assert.deepEqual(statusPresentation(state, 'used', 'detailed'), { text: 'Claude 5h:42% 7d:92%', warning: true });
  assert.equal(statusPresentation({ ...state, snapshot: null }, 'used', 'detailed').text, 'Claude 조회 불가');
  assert.match(statusPresentation({ ...state, status: 'stale' }, 'used', 'compact').text, /history/);
});

test('webview boundary only permits bounded known queries and provider commands', () => {
  assert.equal(parseDashboardMessage({ type: 'executeCommand', command: 'arbitrary' }), null);
  assert.equal(parseDashboardMessage({ type: 'refreshQuota', provider: '../../credential' }), null);
  assert.equal(parseDashboardMessage({ type: 'settings', provider: 'other' }), null);
  assert.deepEqual(parseDashboardMessage({ type: 'queryUsage', query: { groupBy: 'turn', limit: 1000000, offset: -1, dbPath: '/secret', provider: 'claude' } }), {
    type: 'queryUsage', query: { groupBy: 'turn', limit: 100, offset: 0, provider: 'claude' },
  });
  assert.equal(parseDashboardMessage({ type: 'queryUsage', query: { groupBy: 'DROP TABLE' } }), null);
});

test('webview uses external local assets, a nonce CSP, and text-only dynamic labels', () => {
  const html = dashboardHtml('local/script.js', 'local/style.css', 'local:', 'safe');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-safe'/);
  assert.doesNotMatch(html, /unsafe-inline|onclick=/);
  assert.match(dashboardHtml('" onload="bad', 'style', 'local:', 'nonce'), /&quot; onload=&quot;bad/);
  const source = readFileSync(join(__dirname, '../../media/dashboard.js'), 'utf8');
  assert.doesNotThrow(() => new Script(source));
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML/);
});
