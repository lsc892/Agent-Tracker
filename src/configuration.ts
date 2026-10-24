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

/**
 * 책임: 통계에 사용할 시간대를 검증하고 경고를 만든다.
 * 알고리즘: 공백을 제거한 시간대를 Intl로 검증하고, 유효하지 않으면 시스템 시간대와 번역된 경고로 대체한다.
 */
function readUsageSettings(usage: ConfigurationValues['usage'], locale: string) {
  let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let timezoneWarning: string | undefined;
  const configuredTimezone: unknown = usage.timezone;
  if (configuredTimezone === '' || configuredTimezone === undefined) return { ...usage, timezone, timezoneWarning };
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
  return { ...usage, timezone, timezoneWarning };
}

/**
 * 책임: 공통 데이터 홈에서 제공자별 경로와 보존 기간을 확정한다.
 * 알고리즘: 상위 경로에 .claude·.codex를 붙이고 보존 기간은 안전한 양의 정수일 때만 적용한다.
 */
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

/**
 * 책임: 서비스가 사용할 독립적인 설정 스냅샷을 만든다.
 * 알고리즘: 공통 정의에서 값을 한 번씩 읽고 언어·경로·색상·시간대를 정규화한 뒤 활성 제공자의 로그 루트를 파생한다.
 */
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
