// 설정 값을 정규화해 서비스 설정과 제공자별 로그 경로를 구성한다.
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
  // [설정 정책] 물결표와 상대 경로를 사용자 홈을 기준으로 절대 경로로 해석한다.
  const home = homedir();
  const path = value === '~' ? home : /^~[/\\]/.test(value) ? join(home, value.slice(2)) : value;
  return resolve(home, path);
}

function readDisplaySettings(display: ConfigurationValues['display']) {
  return { ...display, colorMode: colorMode(display.colorMode), customColor: normalizeHexColor(display.customColor) };
}

/**
 * 책임: 통계에 사용할 시간대를 검증하고 경고를 만든다.
 * 알고리즘: 공백을 제거한 시간대를 Intl로 검증하고, 유효하지 않으면 시스템 시간대와 번역된 경고로 대체한다.
 */
function readUsageSettings(usage: ConfigurationValues['usage'], locale: string) {
  // [설정 정책] 시스템 시간대를 기본으로 두고 시스템 값이 비어 있으면 UTC를 쓴다.
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const configuredTimezone: unknown = usage.timezone;
  const selected = typeof configuredTimezone === 'string' ? configuredTimezone.trim() : undefined;
  if (configuredTimezone === undefined || selected === '') return { ...usage, timezone, timezoneWarning: undefined };
  // [설정 정책] 공백을 제거한 설정을 Intl로 검증하고 잘못된 값은 기본값과 번역된 경고로 처리한다.
  if (selected !== undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: selected }).format(0);
      return { ...usage, timezone: selected, timezoneWarning: undefined };
    } catch { /* Intl rejects unsupported time zones. */ }
  }
  const timezoneWarning = String(createTranslator(locale).t('configuration.invalidTimezone', { value0: timezone }));
  return { ...usage, timezone, timezoneWarning };
}

/**
 * 책임: 공통 데이터 홈에서 제공자별 경로와 보존 기간을 확정한다.
 * 알고리즘: 상위 경로에 .claude·.codex를 붙이고 보존 기간은 안전한 양의 정수일 때만 적용한다.
 */
function readProviderSettings(values: ConfigurationValues, dataHome: string) {
  // [설정 정책] 공통 홈에서 제공자별 경로를 만들고 Claude 보존 기간이 허용 범위 밖이면 비운다.
  const cleanup = values.claude.cleanupPeriodDays;
  return {
    claude: { ...values.claude, dataHome: join(dataHome, '.claude'),
      cleanupPeriodDays: typeof cleanup === 'number' && Number.isSafeInteger(cleanup)
        && cleanup >= settingDefinitions.claude.cleanupPeriodDays.minimum ? cleanup : null },
    codex: { ...values.codex, dataHome: join(dataHome, '.codex') },
  };
}

function buildSourceRoots(providers: ReturnType<typeof readProviderSettings>): SourceRoot[] {
  // [수집 정책] 활성 제공자만 남기고 Codex는 현재 세션과 보관 세션을 모두 수집 대상으로 잡는다.
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
  // [설정 정책] 언어와 공통 홈을 먼저 확정해 제공자 설정과 수집 경로의 기준으로 사용한다.
  const values = readSettingValues(settings);
  const locale = resolveLocale(values.language, editorLanguage);
  const dataHome = expandPath(values.dataHome.trim() || settingDefinitions.dataHome.default);
  const providers = readProviderSettings(values, dataHome);
  // [DTO 정책] 원래 설정과 정규화한 표시·통계·제공자 설정을 하나의 스냅샷으로 반환한다.
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
