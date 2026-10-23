'use strict';
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { withLocalizedManifest } = require('./localization-manifest.cjs');

/**
 * 책임: 현재 소스와 번역으로 설치 가능한 VSIX를 구성한다.
 * 알고리즘: 번역 생성 후 임시 manifest 배치 범위 안에서 vsce를 실행하고 전달받은 패키징 옵션과 종료 상태를 유지한다.
 */
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
