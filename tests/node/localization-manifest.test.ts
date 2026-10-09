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

test('native settings have complete manifest translations in all editor languages and an English base catalog', () => {
  const root = join(__dirname, '../../..');
  const read = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8'));
  const manifest = read('package.json');
  const languages = read('localization/languages.json') as {locale:string;vscodeLocales:string[]}[];
  const tokens = [...new Set(JSON.stringify(manifest.contributes.configuration).match(/%[\w.]+%/g))];
  assert.deepEqual(read('localization/package.nls.json'), read('localization/package.nls.en.json'));
  for (const language of languages) {
    const catalog = read(`localization/locales/${language.locale}.json`);
    for (const alias of new Set([language.locale, ...language.vscodeLocales])) {
      const translated = read(`localization/package.nls.${alias}.json`);
      for (const token of tokens) {
        const key = token.slice(1, -1);
        assert.equal(translated[key], catalog[key], `${alias}: ${key}`);
        if (language.locale !== 'ko') assert.doesNotMatch(translated[key], /[가-힣]/);
      }
    }
  }
  const properties = Object.assign({}, ...manifest.contributes.configuration.map((section: {properties:Record<string,unknown>}) => section.properties));
  assert.equal(Object.keys(properties).length, 20);
  assert.deepEqual(properties['agentTracker.display.percentage'].enumItemLabels, ['%manifest.percentageUsed%', '%manifest.percentageRemaining%']);
  assert.deepEqual(properties['agentTracker.display.detail'].enumItemLabels, ['%manifest.detailCompact%', '%manifest.detailDetailed%']);
});

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
