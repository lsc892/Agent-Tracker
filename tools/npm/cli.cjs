#!/usr/bin/env node
// 동봉 VSIX의 무결성을 확인해 VS Code에 설치하고 설치 버전을 검증한다.
'use strict';
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, statSync } = require('node:fs');
const { delimiter, dirname, extname, isAbsolute, join, resolve } = require('node:path');

/**
 * 책임: 설치 CLI의 지원 옵션과 값을 명확히 구분한다.
 * 알고리즘: 인자를 한 번 순회하며 허용된 flag·값 쌍만 저장하고 누락·NUL·알 수 없는 옵션은 즉시 거부한다.
 */
function parseArguments(args) {
  const options = { code: 'code' };
  const values = new Map([
    ['--code', 'code'], ['--profile', 'profile'],
    ['--extensions-dir', 'extensionsDir'], ['--user-data-dir', 'userDataDir'],
  ]);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    switch (argument) {
      case '--help': case '-h': options.help = true; continue;
      case '--version': case '-v': options.version = true; continue;
    }
    if (!values.has(argument)) throw new Error(`Unknown argument: ${argument}. Use --help for usage.`);
    const value = args[++index];
    if (!value || value.startsWith('--') || value.includes('\0')) throw new Error(`Expected a value after ${argument}.`);
    options[values.get(argument)] = value;
  }
  return options;
}

/**
 * 책임: 사용자가 선택한 VS Code CLI 실행 경로를 찾는다.
 * 알고리즘: 명시 경로를 먼저 확인하고 그 외에는 플랫폼별 PATH·확장자 후보를 순서대로 검사해 실제 파일을 반환한다.
 */
function resolveCli(command, platform = process.platform, env = process.env) {
  if (isAbsolute(command) || /[\\/]/.test(command)) {
    const target = resolve(command);
    if (existsSync(target) && statSync(target).isFile()) return target;
  } else {
    const pathValue = Object.entries(env).find(([key]) => platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH')?.[1] ?? '';
    const extensions = platform === 'win32' && !extname(command) ? ['.cmd', '.exe', '.bat', ''] : [''];
    for (const directory of pathValue.split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
      for (const extension of extensions) {
        const target = resolve(directory.replace(/^"|"$/g, ''), command + extension);
        if (existsSync(target) && statSync(target).isFile()) return target;
      }
    }
  }
  throw new Error(`VS Code CLI "${command}" was not found. Install VS Code and add "code" to PATH, or pass --code <path>.`);
}

/**
 * 책임: Windows launcher도 셸을 거치지 않는 실행 인자로 변환한다.
 * 알고리즘: 공식 cmd/bat launcher에서 Electron·cli.js 경로를 추출·검증하고 ELECTRON_RUN_AS_NODE 환경과 prefix 인자를 구성한다.
 */
function cliInvocation(cli, platform = process.platform, env = process.env) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(cli)) return { file: cli, prefix: [], env };
  // Run the bundled Electron CLI directly. Profile names and paths never enter cmd.exe.
  // Read both paths from the launcher to support VS Code's versioned installation directories.
  const launcher = readFileSync(cli, 'utf8');
  const match = launcher.match(/"%~dp0([^"\r\n]+\.exe)"\s+"%~dp0([^"\r\n]+[\\/]out[\\/]cli\.js)"/i);
  if (!match) throw new Error('Unsupported VS Code launcher. Pass --code with the official VS Code CLI path.');
  const executable = resolve(dirname(cli), match[1].replaceAll('\\', '/'));
  const script = resolve(dirname(cli), match[2].replaceAll('\\', '/'));
  if (!existsSync(executable) || !existsSync(script)) throw new Error('The VS Code launcher points to missing runtime files. Reinstall VS Code.');
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  delete childEnv.VSCODE_DEV;
  return { file: executable, prefix: [script], env: childEnv };
}

function minimumVersion(range) {
  const match = /^(?:>=|\^)?(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!match) throw new Error(`Unsupported VS Code version range: ${range}.`);
  return match.slice(1).map(Number);
}

function checkVersion(output, range) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?\s*$/m.exec(output);
  if (!match) throw new Error('Could not read the VS Code version.');
  const actual = match.slice(1).map(Number);
  const minimum = minimumVersion(range);
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index] > minimum[index]) return;
    if (actual[index] < minimum[index]) throw new Error(`VS Code ${minimum.join('.')} or newer is required; found ${actual.join('.')}.`);
  }
}

function readVerifiedBundle(packageRoot, version) {
  const metadata = JSON.parse(readFileSync(join(packageRoot, 'extension.json'), 'utf8'));
  if (metadata.id !== 'AgentTracker.agent-tracker' || metadata.version !== version) throw new Error('The bundled extension identity or version does not match the installer.');
  const vsix = join(packageRoot, 'extension.vsix');
  if (!existsSync(vsix)) throw new Error('The bundled extension.vsix is missing. Reinstall the npm package.');
  if (createHash('sha256').update(readFileSync(vsix)).digest('hex') !== metadata.sha256) throw new Error('The bundled VSIX checksum does not match. Reinstall the npm package.');
  return { metadata, vsix };
}

function invokeCli(invocation, commandArgs, inherit, spawn) {
  const result = spawn(invocation.file, [...invocation.prefix, ...commandArgs], {
    env: invocation.env, windowsHide: true,
    encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status === 0) return result.stdout ?? '';
  const error = new Error(`VS Code CLI failed${result.status === null ? ` (${result.signal ?? 'interrupted'})` : ` (exit ${result.status})`}.${result.stderr?.trim() ? `\n${result.stderr.trim()}` : ''}`);
  error.exitCode = result.status || 1;
  throw error;
}

/**
 * 책임: 동봉한 확장을 선택한 VS Code 환경에 설치하고 결과를 확인한다.
 * 알고리즘: 확장 ID·버전·VSIX 해시와 최소 VS Code 버전을 검증한 뒤 설치하고 같은 profile·경로의 목록에서 기대 버전을 대조한다.
 */
function run(packageRoot, args, dependencies = {}) {
  const spawn = dependencies.spawnSync ?? spawnSync;
  const log = dependencies.log ?? console.log;
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const options = parseArguments(args);
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (options.help) {
    log(`Usage: npx ${manifest.name} [options]

Install the bundled Agent Tracker VSIX into VS Code.

  --code <command-or-path>  VS Code CLI (default: code)
  --profile <name>          Install into a named VS Code profile
  --extensions-dir <path>  Use a separate extensions directory
  --user-data-dir <path>   Use a separate VS Code data directory
  -h, --help               Show this help
  -v, --version            Show the package version`);
    return;
  }
  if (options.version) { log(manifest.version); return; }

  const { metadata, vsix } = readVerifiedBundle(packageRoot, manifest.version);
  const invocation = cliInvocation(resolveCli(options.code, platform, env), platform, env);
  const selection = [];
  for (const [key, flag] of [['profile', '--profile'], ['extensionsDir', '--extensions-dir'], ['userDataDir', '--user-data-dir']]) {
    if (options[key]) selection.push(flag, options[key]);
  }
  const invoke = (commandArgs, inherit = false) => invokeCli(invocation, commandArgs, inherit, spawn);
  checkVersion(invoke(['--version']), metadata.vscode);
  log(`Installing ${metadata.id}@${metadata.version}...`);
  invoke(['--install-extension', vsix, '--force', ...selection], true);
  const expected = `${metadata.id}@${metadata.version}`;
  const installed = invoke(['--list-extensions', '--show-versions', ...selection]);
  if (!installed.split(/\r?\n/).some(line => line.trim().toLowerCase() === expected.toLowerCase())) throw new Error(`VS Code did not report the expected installed extension: ${expected}.`);
  log(`Installed and verified: ${expected}`);
  log('In VS Code, run Developer: Reload Window, then Agent Tracker: Open Dashboard.');
}

module.exports = { run, resolveCli, cliInvocation };
if (require.main === module) {
  try { run(join(__dirname, '..'), process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = error.exitCode || 1; }
}
