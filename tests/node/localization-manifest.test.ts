import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { withLocalizedManifest, prepareDebugManifest, restoreDebugManifest } = require('../../../tools/localization-manifest.cjs') as {
  withLocalizedManifest<T>(root: string, task: () => T | Promise<T>): Promise<T>;
  prepareDebugManifest(root: string): void;
  restoreDebugManifest(root: string): void;
};

test('manifest copies are available during the task and restored after success or failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tracker-localization-'));
  try {
    mkdirSync(join(root, 'localization'));
    writeFileSync(join(root, 'localization/package.nls.json'), '{"title":"source"}\n');
    writeFileSync(join(root, 'localization/package.nls.zh-cn.json'), '{"title":"translation"}\n');
    writeFileSync(join(root, 'package.nls.json'), 'original root file\r\n');
    writeFileSync(join(root, 'package.nls.en.json'), 'unrelated root file');
    const checkCopies = () => {
      assert.equal(readFileSync(join(root, 'package.nls.json'), 'utf8'), '{"title":"source"}\n');
      assert.equal(readFileSync(join(root, 'package.nls.zh-cn.json'), 'utf8'), '{"title":"translation"}\n');
    };
    const checkRestored = () => {
      assert.equal(readFileSync(join(root, 'package.nls.json'), 'utf8'), 'original root file\r\n');
      assert.equal(readFileSync(join(root, 'package.nls.en.json'), 'utf8'), 'unrelated root file');
      assert.equal(existsSync(join(root, 'package.nls.zh-cn.json')), false);
      assert.equal(readFileSync(join(root, 'localization/package.nls.json'), 'utf8'), '{"title":"source"}\n');
    };
    assert.equal(await withLocalizedManifest(root, async () => { checkCopies(); await Promise.resolve(); return 42; }), 42);
    checkRestored();
    await assert.rejects(withLocalizedManifest(root, async () => {
      checkCopies();
      throw new Error('packaging failed');
    }), /packaging failed/);
    checkRestored();
    prepareDebugManifest(root);
    checkCopies();
    // Restarting debugging must retain the original backup rather than the temporary copies.
    prepareDebugManifest(root);
    checkCopies();
    restoreDebugManifest(root);
    checkRestored();
    assert.equal(existsSync(join(root, 'dist/.localization-manifest.json')), false);
    restoreDebugManifest(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
