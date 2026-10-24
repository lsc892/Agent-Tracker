import { settingDefinitions, type StatusColorMode } from '../configuration/schema';
export type { StatusColorMode } from '../configuration/schema';
export type ColorTarget = 'user' | 'workspace';

/**
 * 책임: 색상 화면의 저장 메시지를 허용된 설정 값으로 제한한다.
 * 알고리즘: 메시지 종류·공통 모드 목록·user/workspace 범위·HEX 값을 검증한 뒤 정규화한 필드만 반환한다.
 */
export function parseColorSettingsMessage(raw: unknown): {type:'ready'} | {type:'save';mode:StatusColorMode;color:string;target:ColorTarget} | null {
  if (!raw || typeof raw !== 'object') return null;
  const value=raw as Record<string,unknown>;
  if (value.type === 'ready') return {type:'ready'};
  const color=normalizeHexColor(value.color);
  if (value.type !== 'save' || !settingDefinitions.display.colorMode.enum.some(mode => mode === value.mode)
    || typeof value.target !== 'string' || !['user','workspace'].includes(value.target) || !color) return null;
  return {type:'save',mode:value.mode as StatusColorMode,color,target:value.target as ColorTarget};
}

export function colorMode(value: unknown): StatusColorMode {
  return settingDefinitions.display.colorMode.enum.some(mode => mode === value)
    ? value as StatusColorMode : settingDefinitions.display.colorMode.default;
}

/**
 * 책임: 렌더러에 전달할 HEX 색상을 검증하고 표기를 통일한다.
 * 알고리즘: 공백·대소문자를 정리하고 3·4·6·8자리 HEX만 허용하며 짧은 표기는 각 자리를 두 번 반복해 확장한다.
 */
export function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const color=value.trim().toLowerCase();
  if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/.test(color)) return undefined;
  return color.length <= 5 ? '#'+[...color.slice(1)].map(character=>character+character).join('') : color;
}

export function statusForeground(mode: StatusColorMode, custom: string | undefined): string {
  // VS Code writes this value to the label's inline CSS. Explicit inheritance
  // follows the status bar's normal, no-folder and debugging foreground, even
  // when a label rule (such as hover) would otherwise supply a different color.
  switch (mode) {
    case 'white': return '#ffffff';
    case 'black': return '#000000';
    case 'custom': return normalizeHexColor(custom) ?? 'inherit';
    default: return 'inherit';
  }
}
