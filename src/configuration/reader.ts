// 공통 설정 정의의 키와 기본값으로 현재 설정을 새 객체에 읽는다.
import { mapSettings, settingDefinitions, type ConfigurationValues } from './schema';

export interface SettingsReader { get<T>(key: string, fallback: T): T }

/**
 * 책임: 이전 비교용 설정을 변경하지 않고 새 값을 읽는다.
 * 알고리즘: 공통 설정 트리를 순회하며 각 키를 등록된 기본값으로 한 번씩 조회해 새 객체로 반환한다.
 */
export function readSettingValues(settings: SettingsReader): ConfigurationValues {
  // [설정 정책] 정의된 기본값으로 각 말단 키를 조회해 새 설정 스냅샷을 만든다.
  return mapSettings(settingDefinitions, (definition, key) =>
    settings.get(key, definition.default)) as ConfigurationValues;
}
