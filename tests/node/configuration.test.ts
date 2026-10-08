import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfiguration, type SettingsReader } from '../../src/configuration';

function settings(values: Record<string, unknown>): SettingsReader {
  return { get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; } };
}

test('quota polling uses one common interval setting', () => {
  assert.equal(readConfiguration(settings({})).pollingSeconds, 900);
  assert.equal(readConfiguration(settings({ 'quota.pollingIntervalSeconds': 120 })).pollingSeconds, 120);
});

test('quota extras, empty usage and Claude retention use independent defaults and explicit settings', () => {
  const defaults = readConfiguration(settings({}));
  assert.equal(defaults.codex.showReserve, false);
  assert.equal(defaults.codex.showResetCredits, true);
  assert.equal(defaults.excludeEmptyUsage, true);
  assert.equal(defaults.claude.cleanupPeriodDays, null);
  const changed = readConfiguration(settings({ 'codex.showReserve': true, 'codex.showResetCredits': false,
    'usage.excludeEmptyUsage': false, 'claude.cleanupPeriodDays': 365 }));
  assert.equal(changed.codex.showReserve, true);
  assert.equal(changed.codex.showResetCredits, false);
  assert.equal(changed.excludeEmptyUsage, false);
  assert.equal(changed.claude.cleanupPeriodDays, 365);
  for (const value of [0, -1, 1.5, '30']) assert.equal(readConfiguration(settings({ 'claude.cleanupPeriodDays': value })).claude.cleanupPeriodDays, null);
});

test('API cost display is controlled by extension settings and defaults off',()=>{
  assert.equal(readConfiguration(settings({})).showApiCosts,false);
  const enabled=readConfiguration(settings({'usage.showApiCosts':true}));
  assert.equal(enabled.showApiCosts,true);assert.equal(enabled.usageEnabled,true);assert.equal(enabled.skillsEnabled,true);
});

test('Skill statistics include AI calls by default and can be disabled independently of tokens and quota',()=>{
  const defaults=readConfiguration(settings({}));assert.equal(defaults.skillsEnabled,true);
  const disabled=readConfiguration(settings({'usage.skillsEnabled':false}));
  assert.equal(disabled.skillsEnabled,false);assert.equal(disabled.usageEnabled,true);
  assert.equal(disabled.claude.enabled,true);assert.equal(disabled.codex.enabled,true);
});

test('tracking switches exclude source roots independently of status visibility', () => {
  const defaults = readConfiguration(settings({}));
  assert.equal(defaults.usageEnabled, true);
  assert.equal(defaults.refreshPolicy, 'automatic');
  for (const provider of ['claude', 'codex'] as const) {
    const config = readConfiguration(settings({ [`${provider}.enabled`]: false, 'usage.enabled': false, 'quota.refreshPolicy': 'manual' }));
    assert.equal(config[provider].enabled, false);
    assert.ok(config.roots.length > 0 && config.roots.every(root => root.provider !== provider));
    assert.equal(config.usageEnabled, false);
    assert.equal(config.refreshPolicy, 'manual');
  }
  assert.equal(readConfiguration(settings({'codex.showStatusBar': false})).codex.enabled, true);
  assert.deepEqual(readConfiguration(settings({'claude.enabled': false, 'codex.enabled': false})).roots, []);
});

test('configured timezone is trimmed and keeps quota and summary on the same valid timezone', () => {
  const config = readConfiguration(settings({ 'usage.timezone': ' Asia/Seoul ' }));
  assert.equal(config.timezone, 'Asia/Seoul');
  assert.equal(config.timezoneWarning, undefined);
});

test('invalid timezone falls back with a visible warning and a corrected setting clears it', () => {
  for (const invalid of ['Not/A_Timezone', 42]) {
    const config = readConfiguration(settings({ 'usage.timezone': invalid }));
    assert.equal(config.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.match(config.timezoneWarning!, /agentTracker\.usage\.timezone/);
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: config.timezone }).format(0));
  }
  assert.equal(readConfiguration(settings({ 'usage.timezone': 'UTC' })).timezoneWarning, undefined);
});

test('empty timezone uses the system zone without warning', () => {
  for (const value of ['', '  ']) {
    const config = readConfiguration(settings({ 'usage.timezone': value }));
    assert.equal(config.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(config.timezoneWarning, undefined);
  }
});
