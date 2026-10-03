import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfiguration, type SettingsReader } from '../src/configuration';

function settings(values: Record<string, unknown>): SettingsReader {
  return { get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; } };
}

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
