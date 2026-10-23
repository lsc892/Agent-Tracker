import { createTranslator, resolveLocale } from './localization';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readSettingValues, type SettingsReader } from './configuration/reader';
import { settingDefinitions, type ConfigurationValues } from './configuration/schema';
import type { SourceRoot } from './summary/types';
import { colorMode, normalizeHexColor } from './ui/colors';

export type { SettingsReader } from './configuration/reader';
export type TrackerConfiguration = ReturnType<typeof readConfiguration>;

export function expandPath(value: string): string {
  return resolve(homedir(), value === '~' ? homedir() : /^~[/\\]/.test(value) ? join(homedir(), value.slice(2)) : value);
}

function readDisplaySettings(display: ConfigurationValues['display']) {
  return { ...display, colorMode: colorMode(display.colorMode), customColor: normalizeHexColor(display.customColor) };
}

function readUsageSettings(usage: ConfigurationValues['usage'], locale: string) {
  let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let timezoneWarning: string | undefined;
  const configuredTimezone: unknown = usage.timezone;
  if (configuredTimezone !== '' && configuredTimezone !== undefined) {
    try {
      if (typeof configuredTimezone !== 'string') throw new TypeError('Invalid timezone');
      const selected = configuredTimezone.trim();
      if (selected) {
        new Intl.DateTimeFormat('en', { timeZone: selected }).format(0);
        timezone = selected;
      }
    } catch {
      timezoneWarning = String(createTranslator(locale).t('configuration.invalidTimezone', { value0: timezone }));
    }
  }
  return { ...usage, timezone, timezoneWarning };
}

function readProviderSettings(values: ConfigurationValues, dataHome: string) {
  const cleanup = values.claude.cleanupPeriodDays;
  return {
    claude: { ...values.claude, dataHome: join(dataHome, '.claude'),
      cleanupPeriodDays: typeof cleanup === 'number' && Number.isSafeInteger(cleanup)
        && cleanup >= settingDefinitions.claude.cleanupPeriodDays.minimum ? cleanup : null },
    codex: { ...values.codex, dataHome: join(dataHome, '.codex') },
  };
}

function buildSourceRoots(providers: ReturnType<typeof readProviderSettings>): SourceRoot[] {
  return [
    { provider: 'claude' as const, path: join(providers.claude.dataHome, 'projects'), dataHome: providers.claude.dataHome },
    ...['sessions', 'archived_sessions'].map(directory => ({ provider: 'codex' as const,
      path: join(providers.codex.dataHome, directory), dataHome: providers.codex.dataHome })),
  ].filter(root => providers[root.provider].enabled);
}

export function readConfiguration(settings: SettingsReader, editorLanguage = 'ko') {
  const values = readSettingValues(settings);
  const locale = resolveLocale(values.language, editorLanguage);
  const dataHome = expandPath(values.dataHome.trim() || settingDefinitions.dataHome.default);
  const providers = readProviderSettings(values, dataHome);
  return {
    ...values,
    locale,
    dataHome,
    display: readDisplaySettings(values.display),
    usage: readUsageSettings(values.usage, locale),
    ...providers,
    roots: buildSourceRoots(providers),
  };
}
