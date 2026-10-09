import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SourceRoot } from './summary/types';
import { colorMode, normalizeHexColor, type StatusColorMode } from './ui/colors';

export interface SettingsReader { get<T>(key: string, fallback: T): T }
export interface TrackerConfiguration {
  dataHome: string;
  percentage: 'used' | 'remaining';
  detail: 'compact' | 'detailed';
  colorMode: StatusColorMode;
  customColor: string | undefined;
  refreshPolicy: 'automatic' | 'manual';
  pollingSeconds: number;
  usageEnabled: boolean;
  skillsEnabled: boolean;
  showApiCosts: boolean;
  excludeEmptyUsage: boolean;
  claude: { enabled: boolean; dataHome: string; cleanupPeriodDays: number | null };
  codex: { enabled: boolean; dataHome: string; executable: string; showStatusBar: boolean; showReserve: boolean; showResetCredits: boolean };
  roots: SourceRoot[];
  timezone: string;
  timezoneWarning?: string;
}

export function expandPath(value: string): string {
  return resolve(homedir(), value === '~' ? homedir() : /^~[/\\]/.test(value) ? join(homedir(), value.slice(2)) : value);
}

export function readConfiguration(settings: SettingsReader): TrackerConfiguration {
  const dataHome = expandPath(settings.get('dataHome', '~').trim() || '~');
  const claudeHome = join(dataHome, '.claude');
  const codexHome = join(dataHome, '.codex');
  const enabled = { claude: settings.get('claude.enabled', true), codex: settings.get('codex.enabled', true) };
  const cleanup = settings.get<unknown>('claude.cleanupPeriodDays', null);
  let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let timezoneWarning: string | undefined;
  const configuredTimezone = settings.get<unknown>('usage.timezone', '');
  if (configuredTimezone !== '' && configuredTimezone !== undefined) {
    try {
      if (typeof configuredTimezone !== 'string') throw new TypeError('Invalid timezone');
      const selected = configuredTimezone.trim();
      if (selected) {
        new Intl.DateTimeFormat('en', { timeZone: selected }).format(0);
        timezone = selected;
      }
    } catch {
      timezoneWarning = `시간대 설정을 해석할 수 없어 시스템 시간대(${timezone})를 사용합니다. agentTracker.usage.timezone 설정을 확인해 주세요.`;
    }
  }
  return {
    dataHome,
    percentage: settings.get('display.percentage', 'used'),
    detail: settings.get('display.detail', 'detailed'),
    colorMode: colorMode(settings.get<unknown>('display.colorMode', 'automatic')),
    customColor: normalizeHexColor(settings.get<unknown>('display.customColor', '#ffffff')),
    refreshPolicy: settings.get('quota.refreshPolicy', 'automatic'),
    pollingSeconds: settings.get('quota.pollingIntervalSeconds', 900),
    usageEnabled: settings.get('usage.enabled', true),
    skillsEnabled: settings.get('usage.skillsEnabled', true),
    showApiCosts: settings.get('usage.showApiCosts', false),
    excludeEmptyUsage: settings.get('usage.excludeEmptyUsage', true),
    claude: { enabled: enabled.claude, dataHome: claudeHome,
      cleanupPeriodDays: typeof cleanup === 'number' && Number.isSafeInteger(cleanup) && cleanup >= 1 ? cleanup : null },
    codex: { enabled: enabled.codex, dataHome: codexHome, executable: settings.get('codex.executable', 'codex'),
      showStatusBar: settings.get('codex.showStatusBar', true), showReserve: settings.get('codex.showReserve', false),
      showResetCredits: settings.get('codex.showResetCredits', true) },
    roots: [
      { provider: 'claude' as const, path: join(claudeHome, 'projects'), dataHome: claudeHome },
      ...['sessions', 'archived_sessions'].map(directory => ({ provider: 'codex' as const, path: join(codexHome, directory), dataHome: codexHome })),
    ].filter(root => enabled[root.provider]),
    timezone, timezoneWarning,
  };
}
