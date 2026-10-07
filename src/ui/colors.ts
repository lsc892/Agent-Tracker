export type StatusColorMode = 'automatic' | 'white' | 'black' | 'custom';
export type ColorTarget = 'user' | 'workspace';

export function parseColorSettingsMessage(raw: unknown): {type:'ready'} | {type:'save';mode:StatusColorMode;color:string;target:ColorTarget} | null {
  if (!raw || typeof raw !== 'object') return null;
  const value=raw as Record<string,unknown>;
  if (value.type === 'ready') return {type:'ready'};
  const color=normalizeHexColor(value.color);
  if (value.type !== 'save' || typeof value.mode !== 'string' || !['automatic','white','black','custom'].includes(value.mode)
    || typeof value.target !== 'string' || !['user','workspace'].includes(value.target) || !color) return null;
  return {type:'save',mode:value.mode as StatusColorMode,color,target:value.target as ColorTarget};
}

export function colorMode(value: unknown): StatusColorMode {
  return typeof value === 'string' && ['automatic','white','black','custom'].includes(value) ? value as StatusColorMode : 'automatic';
}

/** Expand short HEX codes; only validated color literals may reach the renderer. */
export function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const color=value.trim().toLowerCase();
  if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/.test(color)) return undefined;
  return color.length <= 5 ? '#'+[...color.slice(1)].map(character=>character+character).join('') : color;
}

export function statusForeground(mode: StatusColorMode, custom: string | undefined): string | undefined {
  // Undefined lets VS Code resolve its normal, no-folder, debugging and theme overrides.
  return mode === 'white' ? '#ffffff' : mode === 'black' ? '#000000' : mode === 'custom' ? normalizeHexColor(custom) : undefined;
}
