import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setClaudeCleanupPeriod } from '../../src/claudeSettings';

test('Claude retention preserves other settings, leaves unset policies alone and rejects invalid files and periods', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tracker-retention-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'settings.json');
  await setClaudeCleanupPeriod(home, null);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  await setClaudeCleanupPeriod(home, 90);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { cleanupPeriodDays: 90 });
  await writeFile(path, JSON.stringify({ cleanupPeriodDays: 30, permissions: { allow: ['Read'] }, env: { TEST: 'preserved' } }));
  await setClaudeCleanupPeriod(home, 365);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { cleanupPeriodDays: 365, permissions: { allow: ['Read'] }, env: { TEST: 'preserved' } });
  const previous = await stat(path);
  await setClaudeCleanupPeriod(home, 365);
  assert.equal((await stat(path)).mtimeMs, previous.mtimeMs);
  await setClaudeCleanupPeriod(home, null);
  assert.equal((await stat(path)).mtimeMs, previous.mtimeMs);
  for (const days of [0, -1, 1.5, NaN]) await assert.rejects(setClaudeCleanupPeriod(home, days));
  for (const invalid of ['{broken', '[]', 'null']) {
    await writeFile(path, invalid);
    await assert.rejects(setClaudeCleanupPeriod(home, 90));
    assert.equal(await readFile(path, 'utf8'), invalid);
  }
});
