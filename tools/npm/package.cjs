'use strict';
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

function prepareInstaller(root, destination, vsix) {
  const extension = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const template = JSON.parse(readFileSync(join(root, 'tools/npm/manifest.json'), 'utf8'));
  if (extension.name !== 'agent-tracker' || extension.publisher !== 'agent-tracker') throw new Error('Unexpected Agent Tracker extension identity.');
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(extension.version)) throw new Error('Invalid extension version.');
  const manifest = {
    ...template, version: extension.version, license: extension.license,
    repository: extension.repository, engines: { node: extension.engines.node },
  };
  const metadata = {
    id: `${extension.publisher}.${extension.name}`, version: extension.version,
    vscode: extension.engines.vscode,
    sha256: createHash('sha256').update(readFileSync(vsix)).digest('hex'),
  };
  mkdirSync(join(destination, 'bin'), { recursive: true });
  copyFileSync(join(root, 'tools/npm/cli.cjs'), join(destination, 'bin/cli.cjs'));
  copyFileSync(join(root, 'tools/npm/README.md'), join(destination, 'README.md'));
  copyFileSync(vsix, join(destination, 'extension.vsix'));
  writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(destination, 'extension.json'), JSON.stringify(metadata, null, 2) + '\n');
  return manifest;
}

function main() {
  const root = resolve(__dirname, '../..');
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this tool with npm run package:npm.');
  const extension = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const vsix = join(root, `${extension.name}-${extension.version}.vsix`);
  // Always package current sources. A failed build must never reuse an old VSIX.
  execFileSync(process.execPath, [join(root, 'tools/package.cjs'), '--out', vsix], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  const output = join(root, 'artifacts/npm');
  mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(join(output, '.staging-'));
  try {
    const manifest = prepareInstaller(root, staging, vsix);
    const packed = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', staging, '--pack-destination', output, '--json', '--ignore-scripts'], {
      cwd: root, encoding: 'utf8', windowsHide: true,
    }))[0];
    const expected = ['README.md', 'bin/cli.cjs', 'extension.json', 'extension.vsix', 'package.json'];
    if (packed.name !== manifest.name || packed.version !== manifest.version
      || JSON.stringify(packed.files.map(file => file.path).sort()) !== JSON.stringify(expected.sort())) {
      throw new Error('The npm tarball identity or file list differs from the installer package.');
    }
    console.log(`npm package ready: ${join(output, packed.filename)}`);
    console.log(`Publish with: npm publish "${join(output, packed.filename)}" --access public`);
  } finally {
    // Only remove the unique staging directory created under this workspace's output folder.
    if (dirname(resolve(staging)) !== resolve(output)) throw new Error('Refusing to remove a staging directory outside the output folder.');
    rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { prepareInstaller };
if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = error.status || 1; }
}
