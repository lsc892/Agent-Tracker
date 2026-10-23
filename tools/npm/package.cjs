'use strict';
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

/**
 * 책임: VSIX와 설치 CLI를 별도 공개 npm 패키지로 구성한다.
 * 알고리즘: 루트 확장 identity·버전을 검증하고 설치 파일을 복사한 뒤 같은 버전 manifest와 VSIX SHA-256 metadata를 기록한다.
 */
function prepareInstaller(root, destination, vsix) {
  const extension = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const template = JSON.parse(readFileSync(join(root, 'tools/npm/manifest.json'), 'utf8'));
  if (extension.name !== 'agent-tracker' || extension.publisher !== 'AgentTracker') throw new Error('Unexpected Agent Tracker extension identity.');
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

/**
 * 책임: 현재 VSIX를 포함하는 npm 배포 파일을 재현 가능한 파일 목록으로 만든다.
 * 알고리즘: VSIX를 새로 패키징하고 고유 staging에서 npm pack을 실행해 이름·버전·파일 목록을 검증하며 staging 경계를 확인한 뒤 정리한다.
 */
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
