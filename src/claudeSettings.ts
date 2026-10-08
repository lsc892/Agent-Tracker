import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Configure Claude's own retention policy; Agent Tracker never deletes conversation logs. */
export async function setClaudeCleanupPeriod(dataHome: string, days: number | null): Promise<void> {
  if (days === null) return;
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError('Invalid Claude cleanup period');
  const path = join(dataHome, 'settings.json');
  const read = async (): Promise<string | null> => {
    try { return await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const original = await read();
  const settings: unknown = original === null ? {} : JSON.parse(original.replace(/^\uFEFF/, ''));
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid Claude settings');
  const values = settings as Record<string, unknown>;
  if (values.cleanupPeriodDays === days) return;
  values.cleanupPeriodDays = days;
  await mkdir(dataHome, { recursive: true });
  const temporary = join(dataHome, `.settings-agent-tracker-${randomUUID()}.tmp`);
  try {
    const mode = original === null ? 0o600 : (await stat(path)).mode;
    await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { flag: 'wx', mode });
    if (await read() !== original) throw new Error('Claude settings changed concurrently');
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}
