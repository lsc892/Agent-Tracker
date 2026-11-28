// 패키징·테스트·디버깅 중 manifest 번역을 임시 배치하고 원본을 복원한다.
'use strict';
const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const manifestPattern = /^package\.nls(?:\.[a-z0-9-]+)?\.json$/;

function restoreManifest(root, originals) {
  // [복원 정책] 기존 파일은 원래 바이트로 돌리고 원래 없던 파일은 제거한다.
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
  // [번역 정책] 정해진 이름 패턴으로 기본 사전이 있는 번역 파일 모음을 찾는다.
  const directory = join(root, 'localization');
  const files = readdirSync(directory).filter(file => manifestPattern.test(file));
  if (!files.includes('package.nls.json')) throw new Error('Missing localization/package.nls.json. Run npm run localization:sync.');
  const originals = new Map();
  try {
    // [복원 정책] 루트 파일을 덮기 전에 기존 내용이나 부재 상태를 저장한다.
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
  // [복원 정책] 배포 작업 동안에만 번역 manifest를 배치하고 finally에서 원본을 복구한다.
  const originals = prepareManifest(root);
  try { return await task(); }
  finally { restoreManifest(root, originals); }
}

function restoreDebugManifest(root) {
  // [복원 정책] 디버깅 백업의 파일 이름과 값 형식을 검증한 뒤 원본을 복원한다.
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
  // [복원 정책] 이전 디버깅 백업부터 복원하고 이번 원본의 바이트를 Base64로 저장한다.
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
