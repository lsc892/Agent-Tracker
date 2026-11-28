// VS Code 상태바의 quota 카드 토글 패치를 검사·적용·복원한다.
const { existsSync, readFileSync, writeFileSync, openSync, closeSync, renameSync, unlinkSync, statSync, realpathSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { configureQuotaCardToggle } = require('./statusbar-toggle-behavior.cjs');
const { configureQuotaDividers } = require('./statusbar-toggle-view.cjs');
const { getHistoricalInjections } = require('./statusbar-toggle-history.cjs');

const command = 'agentTracker.toggleQuotaTooltip';
const extensionId = 'AgentTracker.agent-tracker';
const checksumKey = 'vs/workbench/workbench.desktop.main.js';
const begin = '/*agent-tracker:statusbar-toggle:v7*/';
const end = '/*agent-tracker:statusbar-toggle:end*/';
const sha256 = value => createHash('sha256').update(value).digest();
const hash = value => sha256(value).toString('hex');
const encodeChecksum = digest => digest.toString('base64').replace(/=+$/, '');
const checksum = value => encodeChecksum(sha256(value));

function replaceInjection(source, { start, end }, injection) {
  return source.slice(0, start) + injection + source.slice(end);
}

/**
 * 책임: 지원하는 workbench 코드에 quota 클릭 토글 패치만 생성한다.
 * 알고리즘: 유일한 심볼·연결 지점을 검증하고 정확히 알려진 기존 payload만 해제·승격해 새 주입 코드를 만들며 알 수 없는 수정은 거부한다.
 */
function patchSource(source) {
  const symbols = [...source.matchAll(/\b([\w$]+)\s*=\s*\{\s*id:\s*["']statusBar\.entry\.toggleTooltip["'],\s*title:\s*["']["']\s*\}/g)];
  if (symbols.length !== 1) throw new Error('내장 ToggleTooltipCommand를 유일하게 찾을 수 없습니다. 지원하지 않는 VS Code 빌드입니다.');
  let original = source;
  let existingPatch;
  // [패치 식별 정책] 기존 표식의 개수와 순서를 확인하고 주입 부분을 분리해 원래 코드를 재구성한다.
  const markers = [...source.matchAll(/\/\*agent-tracker:statusbar-toggle:v\d+\*\//g)];
  const finish = source.indexOf(end);
  if (markers.length || finish !== -1) {
    if (markers.length !== 1 || finish === -1 || source.indexOf(end, finish + end.length) !== -1
      || !/v[1-7]\*\/$/.test(markers[0][0])) throw new Error('토글 패치 표식이 손상되었습니다.');
    const start = markers[0].index;
    if (finish < start) throw new Error('토글 패치 표식 순서가 잘못되었습니다.');
    const afterPatch = finish + end.length;
    existingPatch = { start, injection: source.slice(start, afterPatch) };
    original = source.slice(0, start) + source.slice(afterPatch);
  }
  // [호환성 정책] 지원하는 툴팁 동작에 연결되는 갱신 지점이 유일한지 확인한다.
  const targets = [...original.matchAll(/update\(([\w$]+)\)\{(?=if\(this\.label\.showProgress=\1\.showProgress)/g)];
  if (targets.length !== 1) throw new Error('StatusbarEntryItem.update 연결 지점을 유일하게 찾을 수 없습니다.');
  const target = targets[0], argument = target[1];
  const context = original.slice(target.index, target.index + 6000);
  if (!context.includes('getStickyHover(this.container)') || !context.includes('commandPointerListener') ||
      !/getStickyHover\([\w$]+\)\s*\{\s*return this\._hoverStack\.find\(/.test(original)) throw new Error('내장 클릭 토글 구현이 예상과 다릅니다.');
  const symbol = symbols[0][1];
  const condition = `${argument}.extensionId===${JSON.stringify(extensionId)}&&${argument}.command?.id===${JSON.stringify(command)}`;
  const mapping = `${argument}={...${argument},command:${symbol}};`;
  const toggleSource = configureQuotaCardToggle.toString().replace(/\r\n/g, '\n');
  const dividerSource = configureQuotaDividers.toString().replace(/\r\n/g, '\n');
  const injection = `${begin}if(${condition}){(${toggleSource})(this,${symbol});${mapping}(${dividerSource})(this);}${end}`;
  const position = target.index + target[0].length;
  const alreadyPatched = existingPatch?.start === position && existingPatch.injection === injection;
  const upgradeRequired = !!existingPatch && !alreadyPatched;
  // [호환성 정책] 기존 주입 위치와 내용이 알려진 버전과 정확히 일치하는 경우에만 업그레이드한다.
  if (upgradeRequired) {
    const historical = getHistoricalInjections({ argument, symbol, condition, mapping, extensionId, end });
    const previousPublisher = historical.map(value =>
      value.replaceAll(JSON.stringify(extensionId), JSON.stringify('agent-tracker.agent-tracker')));
    if (existingPatch.start !== position || ![...historical, ...previousPublisher].includes(existingPatch.injection)) {
      throw new Error('기존 토글 패치가 예상 코드와 다릅니다. 자동으로 덮어쓰지 않습니다.');
    }
  }
  const edit = { start: position, end: position + (existingPatch?.injection.length ?? 0), injection };
  const patched = alreadyPatched ? source : replaceInjection(source, edit, injection);
  return { original, patched, alreadyPatched, upgradeRequired, edit };
}

function appRootFromInstallation(root, launcher = join(root, 'bin', 'code.cmd')) {
  // [설치 경로 정책] 런처가 가리키는 버전별 앱을 우선 확인하고 일반 리소스 경로도 확인한다.
  if (existsSync(launcher)) {
    const match = readFileSync(launcher, 'utf8').match(/%~dp0\.\.\\([^\\"\r\n]+)\\resources\\app\\out\\cli\.js/);
    if (match && existsSync(join(root, match[1], 'resources', 'app', 'product.json'))) return realpathSync(join(root, match[1], 'resources', 'app'));
  }
  for (const candidate of [join(root, 'resources', 'app'), join(root, '..', 'Resources', 'app')]) {
    if (existsSync(join(candidate, 'product.json'))) return realpathSync(candidate);
  }
}

/**
 * 책임: 패치할 VS Code의 실제 앱 디렉터리를 찾는다.
 * 알고리즘: 명시 app root·CLI·실행 파일을 우선하고 기본 설치 후보를 검사하며 버전별 설치 경로는 launcher와 product.json으로 확인한다.
 */
function resolveAppRoot(options = {}) {
  // [설치 경로 정책] 명시한 앱 경로와 CLI를 우선하고 실행 파일 후보에서 실제 리소스 경로를 찾는다.
  if (options.appRoot) return realpathSync(resolve(options.appRoot));
  if (options.cli) {
    const launcher = realpathSync(resolve(options.cli));
    const selected = appRootFromInstallation(dirname(dirname(launcher)), launcher);
    if (selected) return selected;
    throw new Error('지정한 VS Code CLI의 설치 경로를 찾지 못했습니다. --app-root를 지정하세요.');
  }
  const explicitExecutable = options.executable || process.env.VSCODE_EXECUTABLE;
  const executables = explicitExecutable ? [explicitExecutable] : [];
  if (!explicitExecutable && process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) executables.push(join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'));
    if (process.env.ProgramFiles) executables.push(join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'));
  }
  for (const executable of executables.filter(Boolean)) {
    if (!existsSync(executable)) continue;
    const root = dirname(realpathSync(executable));
    const selected = appRootFromInstallation(root);
    if (selected) return selected;
  }
  throw new Error('VS Code 설치를 찾지 못했습니다. --app-root <resources/app 경로> 또는 --executable <실행 파일>을 지정하세요.');
}

function atomicWrite(path, contents) {
  // [쓰기 정책] 원본과 같은 모드의 임시 파일을 배타적으로 만든 뒤 이름을 바꿔 교체한다.
  const temporary = `${path}.agent-tracker-${randomUUID()}.tmp`;
  const file = openSync(temporary, 'wx', existsSync(path) ? statSync(path).mode : undefined);
  try {
    try { writeFileSync(file, contents); }
    finally { closeSync(file); }
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function workbenchPath(appRoot) {
  return join(appRoot, 'out', ...checksumKey.split('/'));
}

function installationStamp(target, productPath) {
  return [target, productPath].map(path => {
    const { size, mtimeMs, ctimeMs } = statSync(path);
    return `${size}:${mtimeMs}:${ctimeMs}`;
  }).join('|');
}

function isInstallationVerified(appRoot, version) {
  const target = workbenchPath(appRoot);
  try {
    const state = JSON.parse(readFileSync(`${target}.agent-tracker-toggle.json`, 'utf8'));
    return state.version === version && state.verifiedPatch === begin
      && state.verifiedFiles === installationStamp(target, join(appRoot, 'product.json'));
  } catch {
    // A missing or unreadable record still needs the full installer check.
    return false;
  }
}

function rememberVerification(statePath, state, stamp) {
  if (state.verifiedPatch === begin && state.verifiedFiles === stamp) return;
  atomicWrite(statePath, JSON.stringify({ ...state, verifiedPatch: begin, verifiedFiles: stamp }, null, 2) + '\n');
}

function rememberAppliedPatch(statePath, state, target, productPath) {
  try {
    rememberVerification(statePath, state, installationStamp(target, productPath));
  } catch {
    // The patch is committed. The next launch can reverify it and cache the result.
  }
}

function createLock(path) {
  let file;
  try {
    file = openSync(path, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  }
  try {
    try { writeFileSync(file, String(process.pid)); }
    finally { closeSync(file); }
  } catch (error) {
    removeLock(path);
    throw error;
  }
  return true;
}

function removeLock(path) {
  try { unlinkSync(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function readLockOwner(path) {
  try { return Number(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function lockWorkbench(appRoot) {
  const path = `${workbenchPath(appRoot)}.agent-tracker-toggle.lock`;
  const release = () => removeLock(path);
  if (createLock(path)) return release;
  const owner = readLockOwner(path);
  if (!Number.isInteger(owner) || owner <= 0 || owner > 0x7fffffff || isRunning(owner)) return undefined;

  // Serialize reclamation for the dead owner so a concurrent caller cannot remove a new lock.
  const recovery = `${path}.${owner}.recovery`;
  if (!createLock(recovery)) return undefined;
  try {
    if (readLockOwner(path) === owner) removeLock(path);
    return createLock(path) ? release : undefined;
  } finally {
    removeLock(recovery);
  }
}

function backup(path, contents, expectedHash, previousVersionHash) {
  if (!existsSync(path)) { atomicWrite(path, contents); return; }
  const backupHash = hash(readFileSync(path));
  if (backupHash === expectedHash) return;
  // An in-place VS Code update can leave a verified backup from the previous version.
  if (previousVersionHash === backupHash) { atomicWrite(path, contents); return; }
  throw new Error(`기존 백업과 원본이 다릅니다: ${path}`);
}

function productWithWorkbenchChecksum(product, workbenchDigest) {
  const checksums = { ...product.checksums, [checksumKey]: encodeChecksum(workbenchDigest) };
  return JSON.stringify({ ...product, checksums }, null, '\t') + '\n';
}

function readUnchangedFile(path, expectedHash) {
  const bytes = readFileSync(path);
  if (hash(bytes) !== expectedHash) {
    throw new Error('패치를 준비한 뒤 VS Code 설치 파일이 변경되었습니다.');
  }
  return bytes;
}

function restoreWorkbench(target, productPath, source, productSource, state) {
  if (!state) throw new Error('복원할 토글 패치 백업이 없습니다.');
  const original = readFileSync(`${target}.agent-tracker-toggle.bak`);
  const originalProduct = readFileSync(`${productPath}.agent-tracker-toggle.bak`);
  if (hash(original) !== state.originalHash || hash(originalProduct) !== state.originalProductHash) throw new Error('백업 무결성 검증 실패.');
  // [복원 정책] 현재 파일이 기록한 상태 중 하나일 때만 검증된 원본 두 파일을 복원한다.
  const sourceHash = hash(source), productHash = hash(productSource);
  if (sourceHash === state.originalHash && productHash === state.originalProductHash) return 'already-restored';
  if (![state.originalHash, state.patchedHash, state.previousHash].includes(sourceHash)
    || ![state.originalProductHash, state.patchedProductHash, state.previousProductHash].includes(productHash)) throw new Error('패치 이후 파일이 변경되어 자동 복원을 중단합니다.');
  try {
    atomicWrite(target, original);
    atomicWrite(productPath, originalProduct);
  } catch (error) {
    atomicWrite(target, source); atomicWrite(productPath, productSource); throw error;
  }
  return 'restored';
}

function applyPreparedPatch(appRoot, edit, record, { originalProduct, patchedProduct, previousVersion }) {
  const target = workbenchPath(appRoot);
  const productPath = join(appRoot, 'product.json');
  const statePath = `${target}.agent-tracker-toggle.json`;
  const sourceBackup = `${target}.agent-tracker-toggle.bak`;
  const productBackup = `${productPath}.agent-tracker-toggle.bak`;
  // The same verified input and edit reproduce the workbench checked during preparation.
  const source = readUnchangedFile(target, record.previousHash ?? record.originalHash);
  readUnchangedFile(productPath, record.previousProductHash ?? record.originalProductHash);
  const sourceText = source.toString('utf8');
  const original = record.previousHash ? replaceInjection(sourceText, edit, '') : source;
  backup(sourceBackup, original, record.originalHash, previousVersion?.originalHash);
  backup(productBackup, originalProduct, record.originalProductHash, previousVersion?.originalProductHash);
  // Record both expected file states before mutation, so an interrupted apply is restorable.
  atomicWrite(statePath, JSON.stringify(record, null, 2) + '\n');
  atomicWrite(target, replaceInjection(sourceText, edit, edit.injection));
  try {
    atomicWrite(productPath, patchedProduct);
  } catch (error) {
    atomicWrite(target, source);
    throw error;
  }
  rememberAppliedPatch(statePath, record, target, productPath);
  return { status: record.previousHash ? 'upgraded' : 'patched', appRoot, version: record.version, backup: sourceBackup };
}

/**
 * 책임: workbench 패치·복원의 무결성과 복구 가능한 상태를 관리한다.
 * 알고리즘: 대상·해시·백업·구문을 검증하고 변경 전 양쪽 기대 상태를 기록한 뒤 파일과 checksum을 교체하며 실패하면 이전 상태로 되돌린다.
 */
function prepareOperation(appRoot, options) {
  const target = workbenchPath(appRoot);
  const productPath = join(appRoot, 'product.json');
  const manifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
  if (!/code/i.test(manifest.name) || typeof manifest.version !== 'string') throw new Error('VS Code 앱 디렉터리가 아닙니다.');
  if (options.expectedVersion && manifest.version !== options.expectedVersion) {
    throw new Error('실행 중인 VS Code와 설치 디렉터리의 버전이 다릅니다.');
  }
  const verificationStamp = options.expectedVersion ? installationStamp(target, productPath) : undefined;
  const source = readFileSync(target, 'utf8');
  const productSource = readFileSync(productPath, 'utf8');
  const product = JSON.parse(productSource);
  const statePath = `${target}.agent-tracker-toggle.json`;
  const sourceBackup = `${target}.agent-tracker-toggle.bak`;
  const productBackup = `${productPath}.agent-tracker-toggle.bak`;
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : undefined;
  if (options.restore) {
    const status = restoreWorkbench(target, productPath, source, productSource, state);
    if (!state.manuallyRestored) atomicWrite(statePath, JSON.stringify({ ...state, manuallyRestored: true }, null, 2) + '\n');
    return { status, appRoot, version: manifest.version };
  }
  const sourceDigest = sha256(source);
  const sourceHash = sourceDigest.toString('hex');
  const productHash = hash(productSource);
  if (options.expectedVersion && state?.manuallyRestored
    && sourceHash === state.originalHash && productHash === state.originalProductHash) {
    rememberVerification(statePath, state, verificationStamp);
    return { status: 'already-restored', appRoot, version: manifest.version };
  }
  const result = patchSource(source);
  if (result.alreadyPatched) {
    if (!state || sourceHash !== state.patchedHash) throw new Error('패치 파일과 백업 기록이 일치하지 않습니다.');
    if (productHash === state.patchedProductHash) {
      if (verificationStamp) rememberVerification(statePath, state, verificationStamp);
      return { status: 'already-patched', appRoot, version: manifest.version };
    }
    if (options.check || state.version !== manifest.version
      || productHash !== (state.previousProductHash ?? state.originalProductHash)) {
      throw new Error('패치 파일과 백업 기록이 일치하지 않습니다.');
    }
    // The workbench was replaced before an interruption. Finish the recorded product replacement.
    const recoveredProduct = productWithWorkbenchChecksum(product, sourceDigest);
    if (hash(recoveredProduct) !== state.patchedProductHash) throw new Error('기록된 체크섬 변경을 재구성할 수 없습니다.');
    if (hash(readFileSync(sourceBackup)) !== state.originalHash || hash(readFileSync(productBackup)) !== state.originalProductHash) {
      throw new Error('백업 무결성 검증 실패.');
    }
    return () => {
      readUnchangedFile(target, state.patchedHash);
      readUnchangedFile(productPath, productHash);
      atomicWrite(productPath, recoveredProduct);
      rememberAppliedPatch(statePath, state, target, productPath);
      return { status: 'recovered', appRoot, version: manifest.version, backup: sourceBackup };
    };
  }
  if (options.check) throw new Error('클릭 토글 패치가 적용되어 있지 않습니다. npm run patch:vscode를 실행하세요.');
  let originalProductSource = productSource;
  if (result.upgradeRequired) {
    const matchesInstalledPatch = sourceHash === state?.patchedHash && productHash === state.patchedProductHash;
    // A failed upgrade can leave both old files in place after saving the new patch record.
    const matchesPreviousPatch = state?.version === manifest.version
      && sourceHash === state.previousHash && productHash === state.previousProductHash;
    if (!matchesInstalledPatch && !matchesPreviousPatch) throw new Error('기존 패치 파일과 백업 기록이 일치하지 않습니다.');
    originalProductSource = readFileSync(productBackup, 'utf8');
    if (hash(readFileSync(sourceBackup)) !== state.originalHash || hash(originalProductSource) !== state.originalProductHash || hash(result.original) !== state.originalHash) throw new Error('백업 무결성 검증 실패.');
  }
  if (product.checksums?.[checksumKey] !== encodeChecksum(sourceDigest)) throw new Error('현재 workbench 파일이 등록된 무결성 값과 다릅니다. 기존 수정에 덮어쓰지 않습니다.');
  // [검증 정책] 교체 전에 주입 결과의 JavaScript 구문을 검사하고 product의 체크섬을 다시 계산한다.
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: result.patched, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024, timeout: 30_000 });
  if (syntax.error || syntax.status !== 0) throw new Error(`패치 JavaScript 구문 검사 실패: ${(syntax.error?.message || syntax.stderr || '').slice(0, 300)}`);
  const patchedDigest = sha256(result.patched);
  const patchedProductSource = productWithWorkbenchChecksum(product, patchedDigest);
  const record = {
    version: manifest.version, command,
    originalHash: result.upgradeRequired ? state.originalHash : sourceHash,
    patchedHash: patchedDigest.toString('hex'),
    originalProductHash: result.upgradeRequired ? state.originalProductHash : productHash,
    patchedProductHash: hash(patchedProductSource),
    ...(result.upgradeRequired ? { previousHash: sourceHash, previousProductHash: productHash } : {}),
  };
  const previousVersion = !result.upgradeRequired && state?.version && state.version !== manifest.version ? state : undefined;
  const { edit } = result;
  const products = { originalProduct: originalProductSource, patchedProduct: patchedProductSource, previousVersion };
  // Keep only the edit and hashes while the desktop process is still running.
  return () => applyPreparedPatch(appRoot, edit, record, products);
}

function operate(options = {}) {
  const appRoot = resolveAppRoot(options);
  if (options.check) return prepareOperation(appRoot, options);
  const unlock = lockWorkbench(appRoot);
  if (!unlock) throw new Error('다른 프로세스에서 클릭 토글 패치를 처리 중입니다.');
  try {
    const prepared = prepareOperation(appRoot, options);
    return typeof prepared === 'function' ? prepared() : prepared;
  } finally {
    unlock();
  }
}

function main(args) {
  // [실행 옵션 정책] 허용된 옵션만 받고 복원과 확인 모드를 동시에 지정하면 거부한다.
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case '--restore': options.restore = true; continue;
      case '--check': options.check = true; continue;
      case '--app-root': case '--executable': case '--cli': break;
      default: throw new Error(`알 수 없는 옵션: ${arg}`);
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} 값이 필요합니다.`);
    options[arg === '--app-root' ? 'appRoot' : arg.slice(2)] = value;
  }
  if (options.restore && options.check) throw new Error('--restore와 --check는 함께 사용할 수 없습니다.');
  console.log(JSON.stringify(operate(options), null, 2));
}

module.exports = { command, patchSource, resolveAppRoot, operate, checksum, hash, isRunning, lockWorkbench, prepareOperation, isInstallationVerified };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
