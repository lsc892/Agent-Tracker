import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Configure Claude's own retention policy; Agent Tracker never deletes conversation logs. */
export async function setClaudeCleanupPeriod(dataHome: string, days: number | null): Promise<void> {
  if (days === null) return;
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new RangeError('Invalid Claude cleanup period');
  }

  const path = join(dataHome, 'settings.json');
  const original = await readFile(path, 'utf8').catch(ignoreMissingFile);
  const settings = parseSettings(original);
  if (settings.cleanupPeriodDays === days) return;

  settings.cleanupPeriodDays = days;
  await writeSettingsAtomically(path, settings, original);
}

function parseSettings(content: string | null): Record<string, unknown> {
  const settings: unknown = content === null ? {} : JSON.parse(content.replace(/^\uFEFF/, ''));
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Invalid Claude settings');
  }
  return settings as Record<string, unknown>;
}

async function writeSettingsAtomically(
  path: string,
  settings: Record<string, unknown>,
  original: string | null,
): Promise<void> {
  const dataHome = dirname(path);
  await mkdir(dataHome, { recursive: true });
  const temporary = join(dataHome, `.settings-agent-tracker-${randomUUID()}.tmp`);
  try {
    const mode = original === null ? 0o600 : (await stat(path)).mode;
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx', mode });
    if (await readFile(path, 'utf8').catch(ignoreMissingFile) !== original) {
      throw new Error('Claude settings changed concurrently');
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(ignoreMissingFile);
  }
}

function ignoreMissingFile(error: NodeJS.ErrnoException): null {
  if (error.code === 'ENOENT') return null;
  throw error;
}
