'use strict';
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { withLocalizedManifest } = require('./localization-manifest.cjs');

async function main() {
  const root = join(__dirname, '..');
  const options = { cwd: root, stdio: 'inherit', windowsHide: true };
  execFileSync(process.execPath, [join(__dirname, 'localization.cjs')], options);
  await withLocalizedManifest(root, () => execFileSync(process.execPath, [
    require.resolve('@vscode/vsce/vsce'), 'package', '--no-dependencies', '--allow-missing-repository', '--skip-license',
    ...process.argv.slice(2),
  ], options));
}

main().catch(error => { console.error(error); process.exitCode = error.status || 1; });
