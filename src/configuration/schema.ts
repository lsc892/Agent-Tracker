// 설정 키·기본값·선택지·VS Code 메타데이터와 공통 트리 순회 규칙을 정의한다.
export const settingCategories = {
  localization: { title: '%manifest.languageCategory%', order: 0 },
  tracking: { title: '%manifest.tracking%', order: 1 },
  statusBar: { title: '%manifest.statusBar%', order: 2 },
  quotaDetails: { title: '%manifest.quotaCard%', order: 3 },
  statistics: { title: '%dashboard.usageStatistics%', order: 4 },
  data: { title: '%manifest.data%', order: 5 },
} as const;

interface SettingMetadata {
  category: keyof typeof settingCategories;
  order?: number;
  scope?: 'window' | 'machine';
  description?: string;
  markdownDescription?: string;
  enumItemLabels?: readonly string[];
  enumDescriptions?: readonly string[];
  enumSource?: 'languages';
  format?: string;
  pattern?: string;
  patternErrorMessage?: string;
}

export type SettingDefinition = SettingMetadata & (
  | { type: 'boolean'; default: boolean }
  | { type: 'number'; default: number; minimum?: number }
  | { type: 'string'; default: string; enum?: readonly string[] }
  | { type: readonly ['integer', 'null']; default: null; minimum?: number }
);
export interface SettingTree { [name: string]: SettingDefinition | SettingTree }

export const settingDefinitions = {
  language: {
    type: 'string', default: 'auto', category: 'localization', scope: 'window',
    enumSource: 'languages', markdownDescription: '%manifest.languageDescription%',
  },
  dataHome: {
    type: 'string', default: '~', category: 'data', order: 1, scope: 'machine',
    markdownDescription: '%manifest.dataHome%',
  },
  display: {
    percentage: {
      type: 'string', default: 'used', enum: ['used', 'remaining'], category: 'statusBar', order: 2,
      enumItemLabels: ['%manifest.percentageUsed%', '%manifest.percentageRemaining%'],
      description: '%manifest.percentage%',
    },
    detail: {
      type: 'string', default: 'detailed', enum: ['compact', 'detailed'], category: 'statusBar', order: 3,
      enumItemLabels: ['%manifest.detailCompact%', '%manifest.detailDetailed%'],
      description: '%manifest.detail%',
    },
    colorMode: {
      type: 'string', default: 'automatic', enum: ['automatic', 'white', 'black', 'custom'],
      category: 'statusBar', order: 4, scope: 'window',
      enumItemLabels: ['%common.automatic%', '%color.white%', '%color.black%', '%color.custom%'],
      enumDescriptions: ['%manifest.automaticColor%', '%manifest.whiteColor%', '%manifest.blackColor%', '%manifest.customColor%'],
      markdownDescription: '%manifest.colorMode%',
    },
    customColor: {
      type: 'string', default: '#ffffff', category: 'statusBar', order: 5, scope: 'window',
      format: 'color-hex', pattern: '^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$',
      patternErrorMessage: '%manifest.invalidHex%', markdownDescription: '%manifest.hexColor%',
    },
  },
  quota: {
    refreshPolicy: {
      type: 'string', default: 'automatic', enum: ['automatic', 'manual'], category: 'tracking', order: 3,
      enumItemLabels: ['%manifest.automaticRefresh%', '%manifest.manualRefresh%'],
      enumDescriptions: ['%manifest.automaticRefreshHelp%', '%manifest.manualRefreshHelp%'],
      markdownDescription: '%manifest.refreshPolicy%',
    },
    pollingIntervalSeconds: {
      type: 'number', default: 900, minimum: 30, category: 'tracking', order: 4,
      markdownDescription: '%manifest.pollingInterval%',
    },
  },
  usage: {
    enabled: {
      type: 'boolean', default: true, category: 'statistics', order: 1,
      markdownDescription: '%manifest.usageEnabled%',
    },
    skillsEnabled: {
      type: 'boolean', default: true, category: 'statistics', order: 2,
      markdownDescription: '%manifest.skillsEnabled%',
    },
    showApiCosts: {
      type: 'boolean', default: false, category: 'statistics', order: 3,
      description: '%manifest.showApiCosts%',
    },
    excludeEmptyUsage: {
      type: 'boolean', default: true, category: 'statistics', order: 4,
      description: '%manifest.excludeEmpty%',
    },
    timezone: {
      type: 'string', default: '', category: 'statistics', order: 5,
      description: '%manifest.timezone%',
    },
    retainDeletedSourceUsage: {
      type: 'boolean', default: true, category: 'data', order: 3,
      markdownDescription: '%manifest.retainDeletedSourceUsage%',
    },
  },
  claude: {
    enabled: {
      type: 'boolean', default: true, category: 'tracking', order: 1,
      description: '%manifest.claudeEnabled%',
    },
    cleanupPeriodDays: {
      type: ['integer', 'null'], default: null, minimum: 1, category: 'data', order: 2, scope: 'machine',
      markdownDescription: '%manifest.cleanupDays%',
    },
  },
  codex: {
    enabled: {
      type: 'boolean', default: true, category: 'tracking', order: 2,
      description: '%manifest.codexEnabled%',
    },
    executable: {
      type: 'string', default: 'codex', category: 'data', order: 4, scope: 'machine',
      description: '%manifest.codexExecutable%',
    },
    showStatusBar: {
      type: 'boolean', default: true, category: 'statusBar', order: 1,
      description: '%manifest.codexStatusBar%',
    },
    showReserve: {
      type: 'boolean', default: false, category: 'quotaDetails', order: 1,
      description: '%manifest.showReserve%',
    },
    showResetCredits: {
      type: 'boolean', default: true, category: 'quotaDetails', order: 2,
      description: '%manifest.showResetCredits%',
    },
  },
} as const satisfies SettingTree;

type SettingValue<T> = T extends { enum: readonly (infer Choice)[] } ? Choice
  : T extends { type: 'boolean' } ? boolean
  : T extends { type: 'number' } ? number
  : T extends { type: 'string' } ? string : number | null;

export type SettingValues<T> = { -readonly [K in keyof T]: T[K] extends SettingDefinition
  ? SettingValue<T[K]> : SettingValues<T[K]> };
export type ConfigurationValues = SettingValues<typeof settingDefinitions>;
export type DisplayPercentage = ConfigurationValues['display']['percentage'];
export type DisplayDetail = ConfigurationValues['display']['detail'];
export type StatusColorMode = ConfigurationValues['display']['colorMode'];
export type RefreshPolicy = ConfigurationValues['quota']['refreshPolicy'];

export function isSettingDefinition(node: SettingDefinition | SettingTree): node is SettingDefinition {
  return 'default' in node;
}

/**
 * 책임: 설정 읽기와 키 생성에 같은 트리 순회 규칙을 제공한다.
 * 알고리즘: 객체를 재귀 순회하며 경로를 점으로 연결하고, 기본값이 있는 말단 정의에만 변환 함수를 적용한다.
 */
export function mapSettings<T extends SettingTree, Value>(tree: T,
  map: (definition: SettingDefinition, key: string) => Value, prefix = ''): object {
  return Object.fromEntries(Object.entries(tree).map(([name, node]) => {
    const key = prefix ? `${prefix}.${name}` : name;
    return [name, isSettingDefinition(node) ? map(node, key) : mapSettings(node, map, key)];
  }));
}

type SettingKeys<T, Prefix extends string = ''> = { readonly [K in keyof T]: T[K] extends SettingDefinition
  ? `${Prefix}${K & string}` : SettingKeys<T[K], `${Prefix}${K & string}.`> };

export const settingKeys = mapSettings(settingDefinitions, (_definition, key) => key) as SettingKeys<typeof settingDefinitions>;
