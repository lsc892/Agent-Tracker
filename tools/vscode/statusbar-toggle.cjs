// VS Code 상태바의 quota 카드 토글 패치를 검사·적용·복원한다.
const { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, realpathSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { configureQuotaCardToggle } = require('./statusbar-toggle-behavior.cjs');
const { configureQuotaDividers } = require('./statusbar-toggle-view.cjs');
const { getHistoricalInjections } = require('./statusbar-toggle-history.cjs');

const command = 'agentTracker.toggleQuotaTooltip';
const extensionId = 'AgentTracker.agent-tracker';
const checksumKey = 'vs/workbench/workbench.desktop.main.js';
const begin = '/*agent-tracker:statusbar-toggle:v7*/';
const end = '/*agent-tracker:statusbar-toggle:end*/';
const hash = value => createHash('sha256').update(value).digest('hex');
const checksum = value => createHash('sha256').update(value).digest('base64').replace(/=+$/, '');

/**
 * 책임: 지원하는 workbench 코드에 quota 클릭 토글 패치만 생성한다.
 * 알고리즘: 유일한 심볼·연결 지점을 검증하고 정확히 알려진 기존 payload만 해제·승격해 새 주입 코드를 만들며 알 수 없는 수정은 거부한다.
 */
function patchSource(source) {
  const symbols = [...source.matchAll(/\b([\w$]+)\s*=\s*\{\s*id:\s*["']statusBar\.entry\.toggleTooltip["'],\s*title:\s*["']["']\s*\}/g)];
  if (symbols.length !== 1) throw new Error('내장 ToggleTooltipCommand를 유일하게 찾을 수 없습니다. 지원하지 않는 VS Code 빌드입니다.');
  let original = source;
  let existingPatch;
  const markers = [...source.matchAll(/\/\*agent-tracker:statusbar-toggle:v\d+\*\//g)];
  if (markers.length || source.includes(end)) {
    if (markers.length !== 1 || source.split(end).length !== 2 || !/v[1-7]\*\/$/.test(markers[0][0])) throw new Error('토글 패치 표식이 손상되었습니다.');
    const start = markers[0].index, finish = source.indexOf(end);
    if (finish < start) throw new Error('토글 패치 표식 순서가 잘못되었습니다.');
    const afterPatch = finish + end.length;
    existingPatch = { start, injection: source.slice(start, afterPatch) };
    original = source.slice(0, start) + source.slice(afterPatch);
  }
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
  const patched = original.slice(0, position) + injection + original.slice(position);
  const alreadyPatched = source === patched;
  const upgradeRequired = !!existingPatch && !alreadyPatched;
  if (upgradeRequired) {
    const historical = getHistoricalInjections({ argument, symbol, condition, mapping, extensionId, end });
    const previousPublisher = historical.map(value =>
      value.replaceAll(JSON.stringify(extensionId), JSON.stringify('agent-tracker.agent-tracker')));
    if (existingPatch.start !== position || ![...historical, ...previousPublisher].includes(existingPatch.injection)) {
      throw new Error('기존 토글 패치가 예상 코드와 다릅니다. 자동으로 덮어쓰지 않습니다.');
    }
  }
  return { original, patched, alreadyPatched, upgradeRequired };
}

function appRootFromInstallation(root, launcher = join(root, 'bin', 'code.cmd')) {
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
  const temporary = `${path}.agent-tracker-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode: statSync(path).mode });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function backup(path, contents) {
  if (!existsSync(path)) { writeFileSync(path, contents, { flag: 'wx' }); return; }
  if (hash(readFileSync(path)) !== hash(contents)) throw new Error(`기존 백업과 원본이 다릅니다: ${path}`);
}

function restoreWorkbench(target, productPath, source, productSource, state) {
  if (!state) throw new Error('복원할 토글 패치 백업이 없습니다.');
  const original = readFileSync(`${target}.agent-tracker-toggle.bak`);
  const originalProduct = readFileSync(`${productPath}.agent-tracker-toggle.bak`);
  if (hash(original) !== state.originalHash || hash(originalProduct) !== state.originalProductHash) throw new Error('백업 무결성 검증 실패.');
  const restored = hash(source) === state.originalHash && hash(productSource) === state.originalProductHash;
  if (restored) return 'already-restored';
  if (![state.originalHash, state.patchedHash, state.previousHash].includes(hash(source)) || ![state.originalProductHash, state.patchedProductHash, state.previousProductHash].includes(hash(productSource))) throw new Error('패치 이후 파일이 변경되어 자동 복원을 중단합니다.');
  try {
    atomicWrite(target, original);
    atomicWrite(productPath, originalProduct);
  } catch (error) {
    atomicWrite(target, source); atomicWrite(productPath, productSource); throw error;
  }
  return 'restored';
}

/**
 * 책임: workbench 패치·복원의 무결성과 복구 가능한 상태를 관리한다.
 * 알고리즘: 대상·해시·백업·구문을 검증하고 변경 전 양쪽 기대 상태를 기록한 뒤 파일과 checksum을 교체하며 실패하면 이전 상태로 되돌린다.
 */
function operate(options = {}) {
  const appRoot = resolveAppRoot(options);
  const target = join(appRoot, 'out', ...checksumKey.split('/'));
  const productPath = join(appRoot, 'product.json');
  const manifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
  if (!/code/i.test(manifest.name) || typeof manifest.version !== 'string') throw new Error('VS Code 앱 디렉터리가 아닙니다.');
  const source = readFileSync(target, 'utf8');
  const productSource = readFileSync(productPath, 'utf8');
  const product = JSON.parse(productSource);
  const statePath = `${target}.agent-tracker-toggle.json`;
  const sourceBackup = `${target}.agent-tracker-toggle.bak`;
  const productBackup = `${productPath}.agent-tracker-toggle.bak`;
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : undefined;
  if (options.restore) {
    return { status: restoreWorkbench(target, productPath, source, productSource, state), appRoot, version: manifest.version };
  }
  const result = patchSource(source);
  if (result.alreadyPatched) {
    if (!state || hash(source) !== state.patchedHash || hash(productSource) !== state.patchedProductHash) throw new Error('패치 파일과 백업 기록이 일치하지 않습니다.');
    return { status: 'already-patched', appRoot, version: manifest.version };
  }
  if (options.check) throw new Error('클릭 토글 패치가 적용되어 있지 않습니다. npm run patch:vscode를 실행하세요.');
  let originalProductSource = productSource;
  if (result.upgradeRequired) {
    if (!state || hash(source) !== state.patchedHash || hash(productSource) !== state.patchedProductHash) throw new Error('기존 패치 파일과 백업 기록이 일치하지 않습니다.');
    originalProductSource = readFileSync(productBackup, 'utf8');
    if (hash(readFileSync(sourceBackup)) !== state.originalHash || hash(originalProductSource) !== state.originalProductHash || hash(result.original) !== state.originalHash) throw new Error('백업 무결성 검증 실패.');
  }
  if (product.checksums?.[checksumKey] !== checksum(source)) throw new Error('현재 workbench 파일이 등록된 무결성 값과 다릅니다. 기존 수정에 덮어쓰지 않습니다.');
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: result.patched, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024, timeout: 30_000 });
  if (syntax.error || syntax.status !== 0) throw new Error(`패치 JavaScript 구문 검사 실패: ${(syntax.error?.message || syntax.stderr || '').slice(0, 300)}`);
  const patchedProduct = { ...product, checksums: { ...product.checksums, [checksumKey]: checksum(result.patched) } };
  const patchedProductSource = JSON.stringify(patchedProduct, null, '\t') + '\n';
  backup(sourceBackup, result.original);
  backup(productBackup, originalProductSource);
  const record = { version: manifest.version, command, originalHash: hash(result.original), patchedHash: hash(result.patched), originalProductHash: hash(originalProductSource), patchedProductHash: hash(patchedProductSource),
    ...(result.upgradeRequired ? { previousHash: hash(source), previousProductHash: hash(productSource) } : {}) };
  // Record both expected file states before mutation, so an interrupted apply is restorable.
  writeFileSync(statePath, JSON.stringify(record, null, 2) + '\n');
  try {
    atomicWrite(target, result.patched);
    atomicWrite(productPath, patchedProductSource);
  } catch (error) {
    atomicWrite(target, source); atomicWrite(productPath, productSource); throw error;
  }
  return { status: result.upgradeRequired ? 'upgraded' : 'patched', appRoot, version: manifest.version, backup: sourceBackup };
}

function main(args) {
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

module.exports = { command, patchSource, resolveAppRoot, operate, checksum, hash };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
