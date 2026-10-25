// 패키징·테스트·디버깅 중 manifest 번역을 임시 배치하고 원본을 복원한다.
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

/**
 * 책임: VS Code가 읽는 위치에 manifest 번역을 임시 배치한다.
 * 알고리즘: 허용된 번역 파일마다 루트 원본을 먼저 저장한 뒤 복사하고 준비 중 실패해도 이미 변경한 파일을 복원한다.
 */
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

/**
 * 책임: 패키징·테스트 동안의 임시 manifest 파일 수명을 제한한다.
 * 알고리즘: 번역 배치 후 작업을 실행하고 성공·실패와 관계없이 finally에서 이전 파일 또는 부재 상태를 복원한다.
 */
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

/**
 * 책임: 여러 디버깅 프로세스에 걸쳐 임시 manifest의 원본을 보존한다.
 * 알고리즘: 이전 snapshot을 먼저 복원하고 새 원본을 Base64 snapshot으로 저장하며 기록 실패 시 현재 변경을 되돌린다.
 */
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
