// Claude 인증 소스 계약·데이터 경로·인증 파일 읽기·토큰 검증을 제공한다.
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { asRecord, QuotaError } from '../types';

export interface ClaudeCredentialSource {
  /** refresh=true re-reads the CLI-owned credential source after a 401. */
  getAccessToken(refresh: boolean, signal: AbortSignal): Promise<string>;
}

export function defaultClaudeDataHome(): string {
  return join(homedir(), '.claude');
}

export function resolveClaudeDataHome(dataHome?: string): string {
  // [설정 정책] 명시 경로, 환경 설정, 사용자 기본 경로 순으로 읽을 위치를 고른다.
  return dataHome || process.env.CLAUDE_CONFIG_DIR || defaultClaudeDataHome();
}

/** 파일 읽기 실패와 내용 검증 실패를 구분해 OS별 fallback 정책을 유지한다. */
export async function readClaudeCredentialFile(dataHome: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    // [인증 정책] 일반 파일인지와 크기 상한을 확인한 뒤 취소 가능한 읽기를 시작한다.
    const path = join(dataHome, '.credentials.json');
    const metadata = await stat(path);
    if (metadata.size > 1_048_576 || !metadata.isFile()) throw new Error('Invalid credential file');
    return await readFile(path, { encoding: 'utf8', signal });
  } catch {
    // [오류 정책] 취소는 즉시 전달하고 나머지 읽기 실패는 대체 소스를 선택할 수 있게 빈 값으로 돌려준다.
    if (signal.aborted) throw new QuotaError('cancelled', { key: 'quota.claudeCancelled' });
    return undefined;
  }
}

export function parseClaudeAccessToken(serialized: string | undefined): string {
  // [인증 정책] 필드 형식이 유효할 때만 사용하며 읽기·파싱 실패는 공통 로그인 안내로 처리한다.
  try {
    const credential = asRecord(asRecord(JSON.parse(serialized ?? 'null'))?.claudeAiOauth);
    const token = credential?.accessToken;
    if (typeof token === 'string' && token.length > 0 && token.length <= 16_384 && !/[\r\n]/.test(token)) return token;
  } catch { /* Never expose JSON parse errors from credentials. */ }
  throw new QuotaError('authentication', { key: 'quota.claudeLoginRequired' });
}
