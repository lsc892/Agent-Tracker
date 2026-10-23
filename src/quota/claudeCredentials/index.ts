import { type ClaudeCredentialSource } from './common';
import { MacClaudeCredentials } from './mac';
import { WindowsClaudeCredentials } from './windows';

export type { ClaudeCredentialSource } from './common';
export { MacClaudeCredentials } from './mac';
export { WindowsClaudeCredentials } from './windows';

/** OS 선택은 생성 시 한 번만 수행하고 Linux도 기존 파일 인증을 사용한다. */
export function createClaudeCredentials(dataHome?: string, platform: NodeJS.Platform = process.platform): ClaudeCredentialSource {
  return platform === 'darwin' ? new MacClaudeCredentials(dataHome) : new WindowsClaudeCredentials(dataHome);
}
