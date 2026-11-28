// Windows의 경로·npm shim에서 셸 없이 실행할 Codex 실행 파일을 찾는다.
import { access, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, delimiter } from 'node:path';
import { QuotaError } from '../types';

/**
 * 책임: Windows에서도 셸 실행 없이 Codex의 실제 실행 파일을 찾는다.
 * 알고리즘: 지정 경로 또는 PATH를 순회하고 공식 npm shim이면 아키텍처별 패키지의 codex.exe 후보로 해석한다.
 */
export async function resolveCodexExecutable(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (process.platform !== 'win32') return command;
  // [실행 정책] Windows에서는 지정 경로를 우선하고 이름만 주어지면 PATH 순서로 실행 파일 후보를 방문한다.
  const hasDirectory = isAbsolute(command) || command.includes('/') || command.includes('\\');
  const paths = hasDirectory ? [command] : (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
    .flatMap(dir => /\.(exe|cmd|ps1)$/i.test(command) ? [join(dir, command)] : [join(dir, `${command}.exe`), join(dir, `${command}.cmd`), join(dir, command)]);
  for (const candidate of paths) {
    if (!(await exists(candidate))) continue;
    if (!/\.(cmd|ps1)$/i.test(candidate)) return candidate;
    // [실행 정책] Codex shim만 실제 실행 파일로 해석하고 다른 스크립트는 거부한다.
    if (!/^codex\.(cmd|ps1)$/i.test(basename(candidate))) {
      throw new QuotaError('process', { key: 'quota.codexExeRequired' });
    }
    const bin = dirname(await realpath(candidate));
    for (const native of npmNativeCandidates(bin)) if (await exists(native)) return native;
  }
  throw new QuotaError('process', { key: 'quota.codexExeMissing' });
}

function npmNativeCandidates(bin: string): string[] {
  // [실행 정책] 현재 아키텍처에 맞춰 중첩 설치, 상위 설치, 내장 배포 순으로 후보 경로를 구성한다.
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const packageRoot = join(bin, 'node_modules', '@openai', 'codex');
  return [
    join(packageRoot, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', triple, 'bin', 'codex.exe'),
    join(bin, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', triple, 'bin', 'codex.exe'),
    join(packageRoot, 'vendor', triple, 'bin', 'codex.exe'),
  ];
}

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
