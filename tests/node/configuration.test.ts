// 확장 설정의 기본값·정규화·독립 스냅샷·추적 범위를 검증한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { readConfiguration, type SettingsReader } from '../../src/configuration';
import { readSettingValues } from '../../src/configuration/reader';

function settings(values: Record<string, unknown>): SettingsReader {
  return { get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; } };
}

test('every native setting is read exactly once with the registered default', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8'));
  const properties = Object.assign({}, ...manifest.contributes.configuration.map(
    (section: { properties: Record<string, { default: unknown }> }) => section.properties,
  )) as Record<string, { default: unknown }>;
  const reads = new Map<string, unknown>();
  readSettingValues({ get<T>(key: string, fallback: T): T {
    assert.equal(reads.has(key), false, `${key} is read once per snapshot`);
    reads.set(key, fallback);
    return fallback;
  } });
  assert.deepEqual(Object.fromEntries([...reads].sort()), Object.fromEntries(Object.entries(properties)
    .map(([key, property]) => [key.replace(/^agentTracker\./, ''), property.default]).sort()));
});

test('configuration changes create independent snapshots for change detection', () => {
  const values: Record<string, unknown> = { 'usage.skillsEnabled': false, 'display.customColor': '#abc' };
  const previous = readConfiguration(settings(values));
  values['usage.skillsEnabled'] = true;
  values['display.customColor'] = '#1234';
  values['quota.pollingIntervalSeconds'] = 120;
  const next = readConfiguration(settings(values));
  assert.equal(previous.usage.skillsEnabled, false);
  assert.equal(previous.display.customColor, '#aabbcc');
  assert.equal(previous.quota.pollingIntervalSeconds, 900);
  assert.equal(next.usage.skillsEnabled, true);
  assert.equal(next.display.customColor, '#11223344');
  assert.equal(next.quota.pollingIntervalSeconds, 120);
  assert.notEqual(previous.quota, next.quota);
});

test('one shared data home defaults to the user home and expands home-relative paths', () => {
  for (const value of [undefined, '', '  ', '~', ' ~ ']) {
    const config = readConfiguration(settings(value === undefined ? {} : { dataHome: value }));
    assert.equal(config.dataHome, homedir());
    assert.equal(config.claude.dataHome, join(homedir(), '.claude'));
    assert.equal(config.codex.dataHome, join(homedir(), '.codex'));
  }
  assert.equal(readConfiguration(settings({ dataHome: ' ~/tracker-data ' })).dataHome, join(homedir(), 'tracker-data'));
  assert.equal(readConfiguration(settings({ dataHome: 'tracker-data' })).dataHome, join(homedir(), 'tracker-data'));
});

test('only the shared data home controls credentials, metadata and both providers log roots', () => {
  const original = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  const base = join(homedir(), 'tracker-data');
  try {
    process.env.CLAUDE_CONFIG_DIR = join(base, 'env-claude');
    process.env.CODEX_HOME = join(base, 'env-codex');
    for (const selected of ['~', base]) {
      const config = readConfiguration(settings({
        dataHome: selected,
        'claude.dataHome': join(base, 'old-claude'), 'codex.dataHome': join(base, 'old-codex'),
        'usage.claudeRoots': [join(base, 'old-projects')], 'usage.codexRoots': [join(base, 'old-sessions')],
      }));
      const expected = selected === '~' ? homedir() : base;
      assert.deepEqual(config.roots.map(root => root.path), [
        join(expected, '.claude', 'projects'), join(expected, '.codex', 'sessions'), join(expected, '.codex', 'archived_sessions'),
      ]);
      assert.ok(config.roots.every(root => root.dataHome === config[root.provider].dataHome));
      assert.equal(config.claude.dataHome, join(expected, '.claude'));
      assert.equal(config.codex.dataHome, join(expected, '.codex'));
    }
  } finally {
    for (const [key, value] of [['CLAUDE_CONFIG_DIR', original.claude], ['CODEX_HOME', original.codex]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('quota polling uses one common interval setting', () => {
  assert.equal(readConfiguration(settings({})).quota.pollingIntervalSeconds, 900);
  assert.equal(readConfiguration(settings({ 'quota.pollingIntervalSeconds': 120 })).quota.pollingIntervalSeconds, 120);
});

test('quota extras, empty usage and Claude retention use independent defaults and explicit settings', () => {
  const defaults = readConfiguration(settings({}));
  assert.equal(defaults.codex.showReserve, false);
  assert.equal(defaults.codex.showResetCredits, true);
  assert.equal(defaults.usage.excludeEmptyUsage, true);
  assert.equal(defaults.claude.cleanupPeriodDays, null);
  const changed = readConfiguration(settings({ 'codex.showReserve': true, 'codex.showResetCredits': false,
    'usage.excludeEmptyUsage': false, 'claude.cleanupPeriodDays': 365 }));
  assert.equal(changed.codex.showReserve, true);
  assert.equal(changed.codex.showResetCredits, false);
  assert.equal(changed.usage.excludeEmptyUsage, false);
  assert.equal(changed.claude.cleanupPeriodDays, 365);
  for (const value of [0, -1, 1.5, '30']) assert.equal(readConfiguration(settings({ 'claude.cleanupPeriodDays': value })).claude.cleanupPeriodDays, null);
});

test('API cost display is controlled by extension settings and defaults off',()=>{
  assert.equal(readConfiguration(settings({})).usage.showApiCosts,false);
  const enabled=readConfiguration(settings({'usage.showApiCosts':true}));
  assert.equal(enabled.usage.showApiCosts,true);assert.equal(enabled.usage.enabled,true);assert.equal(enabled.usage.skillsEnabled,true);
});

test('deleted-source usage retention defaults on and can be disabled independently',()=>{
  assert.equal(readConfiguration(settings({})).usage.retainDeletedSourceUsage,true);
  const disabled=readConfiguration(settings({'usage.retainDeletedSourceUsage':false}));
  assert.equal(disabled.usage.retainDeletedSourceUsage,false);assert.equal(disabled.usage.enabled,true);
});

test('Skill statistics include AI calls by default and can be disabled independently of tokens and quota',()=>{
  const defaults=readConfiguration(settings({}));assert.equal(defaults.usage.skillsEnabled,true);
  const disabled=readConfiguration(settings({'usage.skillsEnabled':false}));
  assert.equal(disabled.usage.skillsEnabled,false);assert.equal(disabled.usage.enabled,true);
  assert.equal(disabled.claude.enabled,true);assert.equal(disabled.codex.enabled,true);
});

test('tracking switches exclude source roots independently of status visibility', () => {
  const defaults = readConfiguration(settings({}));
  assert.equal(defaults.usage.enabled, true);
  assert.equal(defaults.quota.refreshPolicy, 'automatic');
  for (const provider of ['claude', 'codex'] as const) {
    const config = readConfiguration(settings({ [`${provider}.enabled`]: false, 'usage.enabled': false, 'quota.refreshPolicy': 'manual' }));
    assert.equal(config[provider].enabled, false);
    assert.ok(config.roots.length > 0 && config.roots.every(root => root.provider !== provider));
    assert.equal(config.usage.enabled, false);
    assert.equal(config.quota.refreshPolicy, 'manual');
  }
  assert.equal(readConfiguration(settings({'codex.showStatusBar': false})).codex.enabled, true);
  assert.deepEqual(readConfiguration(settings({'claude.enabled': false, 'codex.enabled': false})).roots, []);
});

test('configured timezone is trimmed and keeps quota and summary on the same valid timezone', () => {
  const config = readConfiguration(settings({ 'usage.timezone': ' Asia/Seoul ' }));
  assert.equal(config.usage.timezone, 'Asia/Seoul');
  assert.equal(config.usage.timezoneWarning, undefined);
});

test('invalid timezone falls back with a visible warning and a corrected setting clears it', () => {
  for (const invalid of ['Not/A_Timezone', 42]) {
    const config = readConfiguration(settings({ 'usage.timezone': invalid }));
    assert.equal(config.usage.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.match(config.usage.timezoneWarning!, /agentTracker\.usage\.timezone/);
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: config.usage.timezone }).format(0));
  }
  assert.equal(readConfiguration(settings({ 'usage.timezone': 'UTC' })).usage.timezoneWarning, undefined);
});

test('empty timezone uses the system zone without warning', () => {
  for (const value of ['', '  ']) {
    const config = readConfiguration(settings({ 'usage.timezone': value }));
    assert.equal(config.usage.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(config.usage.timezoneWarning, undefined);
  }
});
