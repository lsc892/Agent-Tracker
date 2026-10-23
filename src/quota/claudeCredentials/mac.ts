import { execFile } from 'node:child_process';
import { defaultClaudeDataHome, parseClaudeAccessToken, readClaudeCredentialFile, resolveClaudeDataHome,
  type ClaudeCredentialSource } from './common';

/** macOS에서 파일을 우선 읽고 기본 경로의 읽기 실패에만 Keychain을 시도한다. */
export class MacClaudeCredentials implements ClaudeCredentialSource {
  private readonly dataHome: string;

  constructor(dataHome?: string) {
    this.dataHome = resolveClaudeDataHome(dataHome);
  }

  async getAccessToken(_refresh: boolean, signal: AbortSignal): Promise<string> {
    let serialized: string | undefined;
    try {
      serialized = await this.readCredentialText(signal);
      return parseClaudeAccessToken(serialized);
    } finally { serialized = undefined; }
  }

  /** 파일을 읽었으면 검증 단계로 넘기고 기본 경로의 읽기 실패에만 Keychain을 사용한다. */
  private async readCredentialText(signal: AbortSignal): Promise<string | undefined> {
    const serialized = await readClaudeCredentialFile(this.dataHome, signal);
    if (serialized !== undefined) return serialized;
    if (this.dataHome !== defaultClaudeDataHome()) return undefined;
    return tryReadKeychainCredentials(signal);
  }
}

/** Keychain 실행 실패는 원문 오류를 노출하지 않고 공통 로그인 안내로 이어지게 한다. */
async function tryReadKeychainCredentials(signal: AbortSignal): Promise<string | undefined> {
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { signal, timeout: 5_000, maxBuffer: 1_048_576, windowsHide: true },
        (error, stdout) => error ? reject(new Error('Credential unavailable')) : resolve(stdout));
    });
  } catch {
    return undefined;
  }
}
