import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { dashboardHtml } from '../src/ui/html';
import { parseDashboardMessage } from '../src/ui/presentation';

test('webview boundary only permits bounded known queries and provider commands', () => {
  assert.equal(parseDashboardMessage({ type: 'executeCommand', command: 'arbitrary' }), null);
  assert.equal(parseDashboardMessage({ type: 'refreshQuota', provider: '../../credential' }), null);
  assert.equal(parseDashboardMessage({ type: 'settings', provider: 'other' }), null);
  assert.equal(parseDashboardMessage({ type: 'refreshUsage' }), null);
  assert.equal(parseDashboardMessage({ type: 'tab', tab: 'quota' }), null);
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
  assert.doesNotMatch(html, /id="quota"|data-tab="quota"|id="refresh-usage"/);
  const source = readFileSync(join(__dirname, '../../media/dashboard.js'), 'utf8');
  assert.doesNotThrow(() => new Script(source));
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML/);
});
