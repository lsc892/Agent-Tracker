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
    let serialized = await readClaudeCredentialFile(this.dataHome, signal);
    try {
      if (serialized === undefined && this.dataHome === defaultClaudeDataHome()) {
        try { serialized = await readKeychainCredentials(signal); }
        catch { /* Return only the fixed login guidance below. */ }
      }
      return parseClaudeAccessToken(serialized);
    } finally { serialized = undefined; }
  }
}

function readKeychainCredentials(signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { signal, timeout: 5_000, maxBuffer: 1_048_576, windowsHide: true },
      (error, stdout) => error ? reject(new Error('Credential unavailable')) : resolve(stdout));
  });
}
