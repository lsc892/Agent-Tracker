import { mapSettings, settingDefinitions, type ConfigurationValues } from './schema';

export interface SettingsReader { get<T>(key: string, fallback: T): T }

/** Read one snapshot; changes must not mutate the previous configuration used for comparisons. */
export function readSettingValues(settings: SettingsReader): ConfigurationValues {
  return mapSettings(settingDefinitions, (definition, key) =>
    settings.get(key, definition.default)) as ConfigurationValues;
}
