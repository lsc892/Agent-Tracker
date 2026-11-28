// 기존 설정과 권한을 보존하며 Claude 로그 보존 기간 설정을 원자적으로 갱신한다.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * 책임: Claude의 로그 보존 설정만 갱신하고 실제 로그 삭제는 Claude에 맡긴다.
 * 알고리즘: 입력과 JSON 객체를 검증하고 값이 달라질 때만 해당 키를 바꿔 원자적으로 저장한다.
 */
export async function setClaudeCleanupPeriod(dataHome: string, days: number | null): Promise<void> {
  // [설정 정책] 미지정이면 건너뛰고 설정할 보존 기간은 안전한 양의 정수로 제한한다.
  if (days === null) return;
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new RangeError('Invalid Claude cleanup period');
  }

  // [저장 정책] 다른 설정 키를 유지하며 보존 기간이 달라질 때만 파일을 교체한다.
  const path = join(dataHome, 'settings.json');
  const original = await readFile(path, 'utf8').catch(ignoreMissingFile);
  const settings = parseSettings(original);
  if (settings.cleanupPeriodDays === days) return;

  settings.cleanupPeriodDays = days;
  await writeSettingsAtomically(path, settings, original);
}

/**
 * 책임: 기존 설정을 다른 키가 보존되는 JSON 객체로 해석한다.
 * 알고리즘: 파일이 없으면 빈 객체를 만들고 BOM을 제거해 파싱하며, null·배열·원시 값은 거부한다.
 */
function parseSettings(content: string | null): Record<string, unknown> {
  // [파싱 정책] 파일이 없으면 빈 객체를 만들고 기존 내용은 BOM을 제거한 뒤 객체인지 확인한다.
  const settings: unknown = content === null ? {} : JSON.parse(content.replace(/^\uFEFF/, ''));
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Invalid Claude settings');
  }
  return settings as Record<string, unknown>;
}

/**
 * 책임: 기존 권한과 동시 변경 검사를 유지하며 설정 파일을 교체한다.
 * 알고리즘: 고유 임시 파일을 배타 생성하고 원본을 다시 읽어 비교한 뒤 rename하며, 성공·실패 모두 임시 파일을 정리한다.
 */
async function writeSettingsAtomically(
  path: string,
  settings: Record<string, unknown>,
  original: string | null,
): Promise<void> {
  // [저장 정책] 같은 디렉터리에 임시 파일을 배타적으로 만들고 원본 권한을 이어받는다.
  const dataHome = dirname(path);
  await mkdir(dataHome, { recursive: true });
  const temporary = join(dataHome, `.settings-agent-tracker-${randomUUID()}.tmp`);
  try {
    const mode = original === null ? 0o600 : (await stat(path)).mode;
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx', mode });
    // [저장 정책] 저장 직전 원본을 다시 비교하고 다른 변경이 없을 때만 이름을 바꿔 교체한다.
    if (await readFile(path, 'utf8').catch(ignoreMissingFile) !== original) {
      throw new Error('Claude settings changed concurrently');
    }
    await rename(temporary, path);
  } finally {
    // [저장 정책] 성공·실패와 관계없이 임시 파일을 정리하고 파일 부재는 정상 처리한다.
    await unlink(temporary).catch(ignoreMissingFile);
  }
}

/**
 * 책임: 파일 부재와 실제 파일 처리 오류를 구분한다.
 * 알고리즘: ENOENT만 null로 바꾸고 권한 등 다른 오류는 그대로 호출자에게 전달한다.
 */
function ignoreMissingFile(error: NodeJS.ErrnoException): null {
  // [오류 정책] 파일 부재만 빈 값으로 처리하고 권한 등 다른 오류는 전달한다.
  if (error.code === 'ENOENT') return null;
  throw error;
}
