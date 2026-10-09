'use strict';
const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const manifestPattern = /^package\.nls(?:\.[a-z0-9-]+)?\.json$/;

function restoreManifest(root, originals) {
  for (const [file, original] of originals) {
    const target = join(root, file);
    if (original === undefined) rmSync(target, { force: true });
    else writeFileSync(target, original);
  }
}

// VS Code reads manifest translations only beside package.json.
// Keep these copies temporary, preserving any files already at the root.
function prepareManifest(root) {
  const directory = join(root, 'localization');
  const files = readdirSync(directory).filter(file => manifestPattern.test(file));
  if (!files.includes('package.nls.json')) throw new Error('Missing localization/package.nls.json. Run npm run localization:sync.');
  const originals = new Map();
  try {
    for (const file of files) {
      const target = join(root, file);
      let original;
      try { original = readFileSync(target); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      originals.set(file, original);
      writeFileSync(target, readFileSync(join(directory, file)));
    }
    return originals;
  } catch (error) {
    restoreManifest(root, originals);
    throw error;
  }
}

async function withLocalizedManifest(root, task) {
  const originals = prepareManifest(root);
  try { return await task(); }
  finally { restoreManifest(root, originals); }
}

function restoreDebugManifest(root) {
  const snapshot = join(root, 'dist/.localization-manifest.json');
  if (!existsSync(snapshot)) return;
  const originals = JSON.parse(readFileSync(snapshot, 'utf8')).map(([file, original]) => {
    if (!manifestPattern.test(file) || (original !== null && typeof original !== 'string')) throw new Error('Invalid manifest backup');
    return [file, original === null ? undefined : Buffer.from(original, 'base64')];
  });
  restoreManifest(root, originals);
  rmSync(snapshot);
}

function prepareDebugManifest(root) {
  restoreDebugManifest(root);
  const originals = prepareManifest(root);
  try {
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist/.localization-manifest.json'), JSON.stringify(
      [...originals].map(([file, original]) => [file, original?.toString('base64') ?? null]),
    ));
  } catch (error) {
    restoreManifest(root, originals);
    throw error;
  }
}

module.exports = { withLocalizedManifest, prepareDebugManifest, restoreDebugManifest };

if (require.main === module) {
  const root = join(__dirname, '..');
  if (process.argv.includes('--prepare')) prepareDebugManifest(root);
  else if (process.argv.includes('--restore')) restoreDebugManifest(root);
  else throw new Error('Expected --prepare or --restore');
}
