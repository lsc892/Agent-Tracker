#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, statSync } = require('node:fs');
const { delimiter, dirname, extname, isAbsolute, join, resolve } = require('node:path');

function parseArguments(args) {
  const options = { code: 'code' };
  const values = new Map([
    ['--code', 'code'], ['--profile', 'profile'],
    ['--extensions-dir', 'extensionsDir'], ['--user-data-dir', 'userDataDir'],
  ]);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--version' || argument === '-v') options.version = true;
    else if (values.has(argument)) {
      const value = args[++index];
      if (!value || value.startsWith('--') || value.includes('\0')) throw new Error(`Expected a value after ${argument}.`);
      options[values.get(argument)] = value;
    } else throw new Error(`Unknown argument: ${argument}. Use --help for usage.`);
  }
  return options;
}

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

  const metadata = JSON.parse(readFileSync(join(packageRoot, 'extension.json'), 'utf8'));
  if (metadata.id !== 'AgentTracker.agent-tracker' || metadata.version !== manifest.version) throw new Error('The bundled extension identity or version does not match the installer.');
  const vsix = join(packageRoot, 'extension.vsix');
  if (!existsSync(vsix)) throw new Error('The bundled extension.vsix is missing. Reinstall the npm package.');
  if (createHash('sha256').update(readFileSync(vsix)).digest('hex') !== metadata.sha256) throw new Error('The bundled VSIX checksum does not match. Reinstall the npm package.');

  const invocation = cliInvocation(resolveCli(options.code, platform, env), platform, env);
  const selection = [];
  for (const [key, flag] of [['profile', '--profile'], ['extensionsDir', '--extensions-dir'], ['userDataDir', '--user-data-dir']]) {
    if (options[key]) selection.push(flag, options[key]);
  }
  const invoke = (commandArgs, inherit = false) => {
    const result = spawn(invocation.file, [...invocation.prefix, ...commandArgs], {
      env: invocation.env, windowsHide: true,
      encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const error = new Error(`VS Code CLI failed${result.status === null ? ` (${result.signal ?? 'interrupted'})` : ` (exit ${result.status})`}.${result.stderr?.trim() ? `\n${result.stderr.trim()}` : ''}`);
      error.exitCode = result.status || 1;
      throw error;
    }
    return result.stdout ?? '';
  };
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
