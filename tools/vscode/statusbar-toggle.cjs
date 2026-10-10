const { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, realpathSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const command = 'agentTracker.toggleQuotaTooltip';
const extensionId = 'AgentTracker.agent-tracker';
const checksumKey = 'vs/workbench/workbench.desktop.main.js';
const begin = '/*agent-tracker:statusbar-toggle:v4*/';
const previewBegin = '/*agent-tracker:statusbar-toggle:v3*/';
const clickOnlyBegin = '/*agent-tracker:statusbar-toggle:v2*/';
const legacyBegin = '/*agent-tracker:statusbar-toggle:v1*/';
const end = '/*agent-tracker:statusbar-toggle:end*/';
const hash = value => createHash('sha256').update(value).digest('hex');
const checksum = value => createHash('sha256').update(value).digest('base64').replace(/=+$/, '');

// Serialized into the renderer. Keep this function self-contained and scoped to
// one status item: the original delegate is shared by the rest of the status bar.
function configureQuotaHover(item, summary) {
  item._agentTrackerSummary = summary;
  if (item._agentTrackerHoverConfigured) return;
  item._agentTrackerHoverConfigured = true;
  const delegate = item.hoverDelegate;
  item.hoverDelegate = {
    get delay() { return delegate.delay; },
    get placement() { return delegate.placement; },
    get showNativeHover() { return delegate.showNativeHover; },
    showHover(options, focus) {
      if (item._agentTrackerSummary !== undefined && !focus) {
        if (item.hoverService.getStickyHover(item.container)) return undefined;
        options = { ...options, content: item._agentTrackerSummary };
      }
      return delegate.showHover(options, focus);
    },
    onDidHideHover() { delegate.onDidHideHover?.(); },
  };
  const stop = event => {
    if (item._agentTrackerSummary !== undefined && item.hoverService.getStickyHover(item.container)) event.stopImmediatePropagation();
  };
  for (const type of ['mouseover', 'focus']) item.container.addEventListener(type, stop, { capture: true });
  item._register({ dispose() {
    for (const type of ['mouseover', 'focus']) item.container.removeEventListener(type, stop, { capture: true });
  } });
}

// Keep the v3 hover function unchanged so upgrades can verify its exact payload.
function configureQuotaDividers(item) {
  const document = item.container.ownerDocument;
  const id = 'agent-tracker-quota-divider-style';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = '.monaco-hover:has(a[data-href="command:agentTracker.openSettings"]) hr{border-top:2px solid #888888;border-bottom:0;height:2px;margin:8px -8px;}';
  document.head.appendChild(style);
}

function patchSource(source) {
  const symbols = [...source.matchAll(/\b([\w$]+)\s*=\s*\{\s*id:\s*["']statusBar\.entry\.toggleTooltip["'],\s*title:\s*["']["']\s*\}/g)];
  if (symbols.length !== 1) throw new Error('내장 ToggleTooltipCommand를 유일하게 찾을 수 없습니다. 지원하지 않는 VS Code 빌드입니다.');
  let original = source;
  const markers = [...source.matchAll(/\/\*agent-tracker:statusbar-toggle:v\d+\*\//g)];
  if (markers.length || source.includes(end)) {
    if (markers.length !== 1 || source.split(end).length !== 2 || ![begin, previewBegin, clickOnlyBegin, legacyBegin].includes(markers[0][0])) throw new Error('토글 패치 표식이 손상되었습니다.');
    const start = markers[0].index, finish = source.indexOf(end);
    if (finish < start) throw new Error('토글 패치 표식 순서가 잘못되었습니다.');
    original = source.slice(0, start) + source.slice(finish + end.length);
  }
  const targets = [...original.matchAll(/update\(([\w$]+)\)\{(?=if\(this\.label\.showProgress=\1\.showProgress)/g)];
  if (targets.length !== 1) throw new Error('StatusbarEntryItem.update 연결 지점을 유일하게 찾을 수 없습니다.');
  const target = targets[0], argument = target[1];
  const context = original.slice(target.index, target.index + 6000);
  if (!context.includes('getStickyHover(this.container)') || !context.includes('commandPointerListener')) throw new Error('내장 클릭 토글 구현이 예상과 다릅니다.');
  const configureSource = configureQuotaHover.toString().replace(/\r\n/g, '\n');
  const dividerSource = configureQuotaDividers.toString().replace(/\r\n/g, '\n');
  const position = target.index + target[0].length;
  const variants = id => {
    const condition = `${argument}.extensionId===${JSON.stringify(id)}&&${argument}.command?.id===${JSON.stringify(command)}`;
    const mapping = `${argument}={...${argument},command:${symbols[0][1]}};`;
    // Preserve exact historical payloads, including the previous publisher ID.
    const clickOnly = `if(!this._agentTrackerClickOnly){this._agentTrackerClickOnly=true;const stop=event=>{if(this.entry?.extensionId===${JSON.stringify(id)}&&this.entry?.command===${symbols[0][1]})event.stopImmediatePropagation();};for(const type of ["mouseover","focus"])this.container.addEventListener(type,stop,{capture:true});this._register({dispose:()=>{for(const type of ["mouseover","focus"])this.container.removeEventListener(type,stop,{capture:true});}});}`;
    const previewInjection = `if(${condition}){(${configureSource})(this,${argument}.ariaLabel??${argument}.name??"");${mapping}}else{this._agentTrackerSummary=undefined;}`;
    return [
      `${begin}if(${condition}){(${configureSource})(this,${argument}.ariaLabel??${argument}.name??"");${mapping}(${dividerSource})(this);}else{this._agentTrackerSummary=undefined;}${end}`,
      `${legacyBegin}if(${condition}){${mapping}}${end}`,
      `${clickOnlyBegin}if(${condition}){${mapping}${clickOnly}}${end}`,
      `${previewBegin}${previewInjection}${end}`,
    ].map(injection => original.slice(0, position) + injection + original.slice(position));
  };
  const [patched, ...older] = variants(extensionId);
  const previousPublisher = variants('agent-tracker.agent-tracker');
  if (![original, patched, ...older, ...previousPublisher].includes(source)) throw new Error('기존 토글 패치가 예상 코드와 다릅니다. 자동으로 덮어쓰지 않습니다.');
  return { original, patched, alreadyPatched: source === patched, upgradeRequired: source !== original && source !== patched };
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
  if (existsSync(path)) {
    if (hash(readFileSync(path)) !== hash(contents)) throw new Error(`기존 백업과 원본이 다릅니다: ${path}`);
  } else writeFileSync(path, contents, { flag: 'wx' });
}

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
    if (!state) throw new Error('복원할 토글 패치 백업이 없습니다.');
    const original = readFileSync(sourceBackup), originalProduct = readFileSync(productBackup);
    if (hash(original) !== state.originalHash || hash(originalProduct) !== state.originalProductHash) throw new Error('백업 무결성 검증 실패.');
    const restored = hash(source) === state.originalHash && hash(productSource) === state.originalProductHash;
    if (restored) return { status: 'already-restored', appRoot, version: manifest.version };
    if (![state.originalHash, state.patchedHash, state.previousHash].includes(hash(source)) || ![state.originalProductHash, state.patchedProductHash, state.previousProductHash].includes(hash(productSource))) throw new Error('패치 이후 파일이 변경되어 자동 복원을 중단합니다.');
    try {
      atomicWrite(target, original);
      atomicWrite(productPath, originalProduct);
    } catch (error) {
      atomicWrite(target, source); atomicWrite(productPath, productSource); throw error;
    }
    return { status: 'restored', appRoot, version: manifest.version };
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
    if (arg === '--restore') options.restore = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--app-root' || arg === '--executable' || arg === '--cli') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 값이 필요합니다.`);
      options[arg === '--app-root' ? 'appRoot' : arg === '--cli' ? 'cli' : 'executable'] = value;
    } else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  if (options.restore && options.check) throw new Error('--restore와 --check는 함께 사용할 수 없습니다.');
  console.log(JSON.stringify(operate(options), null, 2));
}

module.exports = { command, patchSource, resolveAppRoot, operate, checksum, hash };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
