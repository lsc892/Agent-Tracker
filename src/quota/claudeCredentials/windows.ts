// Windows·Linux의 Claude CLI 인증 파일에서 조회용 토큰을 읽는다.
import { parseClaudeAccessToken, readClaudeCredentialFile, resolveClaudeDataHome, type ClaudeCredentialSource } from './common';

/** Windows·Linux에서 CLI 소유 파일을 읽어 조회용 토큰을 얻는다. */
export class WindowsClaudeCredentials implements ClaudeCredentialSource {
  private readonly dataHome: string;

  constructor(dataHome?: string) {
    this.dataHome = resolveClaudeDataHome(dataHome);
  }

  async getAccessToken(_refresh: boolean, signal: AbortSignal): Promise<string> {
    let serialized = await readClaudeCredentialFile(this.dataHome, signal);
    try { return parseClaudeAccessToken(serialized); }
    finally { serialized = undefined; }
  }
}
