import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

type Result = { status: number | null; stdout?: string; stderr?: string; signal?: string; error?: Error };
type SpawnOptions = { env: NodeJS.ProcessEnv; encoding: string; stdio: string; windowsHide: boolean; shell?: boolean };
type Dependencies = {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  spawnSync?: (file: string, args: string[], options: SpawnOptions) => Result;
};
const { run, resolveCli, cliInvocation } = require('../../../tools/npm/cli.cjs') as {
  run(root: string, args: string[], dependencies?: Dependencies): void;
  resolveCli(command: string, platform?: string, env?: NodeJS.ProcessEnv): string;
  cliInvocation(cli: string, platform?: string, env?: NodeJS.ProcessEnv): { file: string; prefix: string[]; env: NodeJS.ProcessEnv };
};
const { prepareInstaller } = require('../../../tools/npm/package.cjs') as {
  prepareInstaller(root: string, destination: string, vsix: string): { name: string; version: string };
};

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agent-tracker-npm-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const vsix = Buffer.from('fixture VSIX');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'agent-tracker-vscode', version: '0.1.0' }));
  writeFileSync(join(root, 'extension.vsix'), vsix);
  writeFileSync(join(root, 'extension.json'), JSON.stringify({
    id: 'agent-tracker.agent-tracker', version: '0.1.0', vscode: '^1.101.0',
    sha256: createHash('sha256').update(vsix).digest('hex'),
  }));
  return root;
}

test('npm installer installs the bundled VSIX and verifies the same extension version and selection', t => {
  const root = fixture(t);
  const calls: { file: string; args: string[]; options: SpawnOptions }[] = [];
  const messages: string[] = [];
  // Shell syntax in a profile name must remain one literal argument.
  const profile = 'Work & tools %TEMP% $(command)';
  const selection = ['--profile', profile, '--extensions-dir', join(root, 'extensions'), '--user-data-dir', join(root, 'user data')];
  run(root, ['--code', process.execPath, ...selection], {
    platform: 'linux', log: message => messages.push(message),
    spawnSync(file, args, options) {
      calls.push({ file, args, options });
      return { status: 0, stdout: calls.length === 1 ? '1.141.0\ncommit\nx64\n' : 'other.extension@1.0.0\nagent-tracker.agent-tracker@0.1.0\n' };
    },
  });
  assert.deepEqual(calls.map(call => call.args), [
    ['--version'], ['--install-extension', join(root, 'extension.vsix'), '--force', ...selection],
    ['--list-extensions', '--show-versions', ...selection],
  ]);
  assert.ok(calls.every(call => call.file === process.execPath && !call.options.shell));
  assert.equal(calls[1].options.stdio, 'inherit');
  assert.ok(messages.includes('Installed and verified: agent-tracker.agent-tracker@0.1.0'));
});

test('npm installer help and version work without VS Code or a bundled VSIX', t => {
  const root = fixture(t);
  rmSync(join(root, 'extension.vsix'));
  rmSync(join(root, 'extension.json'));
  const messages: string[] = [];
  const dependencies = { env: {}, log: (message: string) => messages.push(message), spawnSync() { throw new Error('Must not launch VS Code'); } };
  run(root, ['--help'], dependencies);
  run(root, ['--version'], dependencies);
  assert.match(messages[0], /npx agent-tracker-vscode/);
  assert.equal(messages[1], '0.1.0');
  assert.throws(() => run(root, ['--profile'], dependencies), /Expected a value/);
  assert.throws(() => run(root, ['--unknown'], dependencies), /Unknown argument/);
});

test('npm installer rejects missing or changed VSIX and identity mismatches before launching VS Code', t => {
  const root = fixture(t);
  const dependencies = { spawnSync() { throw new Error('Must not launch VS Code'); } };
  writeFileSync(join(root, 'extension.vsix'), 'changed');
  assert.throws(() => run(root, [], dependencies), /checksum/);
  rmSync(join(root, 'extension.vsix'));
  assert.throws(() => run(root, [], dependencies), /extension.vsix is missing/);
  const metadataPath = join(root, 'extension.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  writeFileSync(metadataPath, JSON.stringify({ ...metadata, version: '0.2.0' }));
  assert.throws(() => run(root, [], dependencies), /identity or version/);
  writeFileSync(metadataPath, JSON.stringify({ ...metadata, id: 'other.extension' }));
  assert.throws(() => run(root, [], dependencies), /identity or version/);
});

test('npm installer stops on an old VS Code, command failure, interrupted command, or unverified install', t => {
  const root = fixture(t);
  for (const version of ['1.100.9\ncommit\nx64', 'unrecognized']) {
    let calls = 0;
    assert.throws(() => run(root, ['--code', process.execPath], {
      platform: 'linux', log() {}, spawnSync() { calls++; return { status: 0, stdout: version }; },
    }), /newer is required|Could not read/);
    assert.equal(calls, 1);
  }
  for (const failure of [{ status: 7, stderr: 'installation denied' }, { status: null, signal: 'SIGTERM' }, { status: null, error: new Error('spawn failed') }]) {
    let calls = 0;
    assert.throws(() => run(root, ['--code', process.execPath], {
      platform: 'linux', log() {}, spawnSync() { calls++; return calls === 1 ? { status: 0, stdout: '1.101.0' } : failure; },
    }), /exit 7|SIGTERM|spawn failed/);
    assert.equal(calls, 2);
  }
  let calls = 0;
  assert.throws(() => run(root, ['--code', process.execPath], {
    platform: 'linux', log() {}, spawnSync() { calls++; return { status: 0, stdout: calls === 1 ? '1.101.0' : 'agent-tracker.agent-tracker@0.0.9' }; },
  }), /did not report the expected/);
  assert.equal(calls, 3);
});

test('Windows VS Code launchers run without a shell for classic and versioned installations', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'Code.exe'), 'fixture executable');
  const cli = join(root, 'bin', 'code.cmd');
  for (const runtime of ['', 'version-123/']) {
    const script = join(root, runtime, 'resources/app/out/cli.js');
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, 'fixture script');
    writeFileSync(cli, `@echo off\n"%~dp0..\\Code.exe" "%~dp0..\\${runtime.replaceAll('/', '\\')}resources\\app\\out\\cli.js" %*\n`);
    const env = { Path: join(root, 'bin'), VSCODE_DEV: '1' };
    assert.equal(resolveCli('code', 'win32', env), cli);
    const invocation = cliInvocation(cli, 'win32', env);
    assert.equal(invocation.file, join(root, 'Code.exe'));
    assert.deepEqual(invocation.prefix, [script]);
    assert.equal(invocation.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(invocation.env.VSCODE_DEV, undefined);
    assert.equal(env.VSCODE_DEV, '1');
  }
  assert.throws(() => resolveCli('missing', 'win32', { PATH: join(root, 'bin') }), /was not found/);
  writeFileSync(cli, 'unrecognized launcher');
  assert.throws(() => cliInvocation(cli, 'win32'), /Unsupported VS Code launcher/);
});

test('npm package uses a separate public manifest with the extension version and only installer runtime files', t => {
  const root = fixture(t);
  const destination = join(root, 'package');
  const workspace = join(__dirname, '../../..');
  const manifest = prepareInstaller(workspace, destination, join(root, 'extension.vsix'));
  const source = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'));
  const packaged = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
  const metadata = JSON.parse(readFileSync(join(destination, 'extension.json'), 'utf8'));
  assert.equal(manifest.name, 'agent-tracker-vscode');
  assert.equal(manifest.version, source.version);
  assert.equal(source.private, true);
  assert.equal(packaged.private, undefined);
  assert.equal(packaged.dependencies, undefined);
  assert.equal(packaged.scripts, undefined);
  assert.equal(packaged.license, source.license);
  assert.equal(packaged.publishConfig.access, 'public');
  assert.equal(metadata.version, source.version);
  assert.equal(metadata.id, `${source.publisher}.${source.name}`);
  assert.ok(existsSync(join(destination, 'extension.vsix')));
  assert.match(readFileSync(join(destination, packaged.bin['agent-tracker-vscode']), 'utf8'), /^#!\/usr\/bin\/env node\r?\n/);
});
