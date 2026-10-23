import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ClaudeQuotaProvider, createClaudeCredentials, MacClaudeCredentials, QuotaError, WindowsClaudeCredentials } from '../../src/quota';

const defaultHome = join(homedir(), '.claude');
const credentialPath = join(defaultHome, '.credentials.json');
const serialize = (token: unknown) => JSON.stringify({ claudeAiOauth: { accessToken: token } });
const signal = () => new AbortController().signal;

// Always replace filesystem access before testing the default home; never read real credentials.
function mockMissingFile(t: TestContext): void {
  t.mock.method(fs, 'stat', async (path: string) => {
    assert.equal(path, credentialPath);
    throw new Error('private-file-error');
  });
  t.mock.method(fs, 'readFile', async () => { throw new Error('Unexpected credential read'); });
}

test('Claude credential factory selects macOS separately and shares file authentication on Windows and Linux', () => {
  assert.ok(createClaudeCredentials('fixture-home', 'darwin') instanceof MacClaudeCredentials);
  assert.ok(createClaudeCredentials('fixture-home', 'win32') instanceof WindowsClaudeCredentials);
  assert.ok(createClaudeCredentials('fixture-home', 'linux') instanceof WindowsClaudeCredentials);
  const expected = process.platform === 'darwin' ? MacClaudeCredentials : WindowsClaudeCredentials;
  assert.ok(createClaudeCredentials('fixture-home') instanceof expected);
});

test('both Claude implementations re-read files and enforce credential bounds without invoking Keychain', async t => {
  const keychain = t.mock.method(childProcess, 'execFile', () => { throw new Error('Unexpected Keychain access'); });
  for (const Credentials of [WindowsClaudeCredentials, MacClaudeCredentials]) {
    await t.test(Credentials.name, async () => {
      const directory = await fs.mkdtemp(join(tmpdir(), 'agent-tracker-credentials-'));
      try {
        const credentials = new Credentials(directory);
        const path = join(directory, '.credentials.json');
        await assert.rejects(credentials.getAccessToken(false, signal()), { code: 'authentication' });
        await fs.writeFile(path, serialize('synthetic-first'));
        assert.equal(await credentials.getAccessToken(false, signal()), 'synthetic-first');
        await fs.writeFile(path, serialize('synthetic-second'));
        assert.equal(await credentials.getAccessToken(true, signal()), 'synthetic-second');
        await fs.writeFile(path, serialize('x'.repeat(16_384)));
        assert.equal((await credentials.getAccessToken(false, signal())).length, 16_384);
        for (const token of ['', 42, null, 'private\rvalue', 'private\nvalue', 'x'.repeat(16_385)]) {
          await fs.writeFile(path, serialize(token));
          await assert.rejects(credentials.getAccessToken(false, signal()), { code: 'authentication' });
        }
        await fs.writeFile(path, serialize('synthetic-token') + ' '.repeat(1_048_576));
        await assert.rejects(credentials.getAccessToken(false, signal()), { code: 'authentication' });
        await fs.rm(path);
        await fs.mkdir(path);
        await assert.rejects(credentials.getAccessToken(false, signal()), { code: 'authentication' });
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    });
  }
  assert.equal(keychain.mock.callCount(), 0);
});

test('macOS prefers the default credential file and does not fall back for malformed file contents', async t => {
  let serialized = serialize('synthetic-file-token');
  t.mock.method(fs, 'stat', async (path: string) => {
    assert.equal(path, credentialPath);
    return { size: 128, isFile: () => true };
  });
  t.mock.method(fs, 'readFile', async (path: string, options: { encoding: string; signal: AbortSignal }) => {
    assert.equal(path, credentialPath);
    assert.equal(options.encoding, 'utf8');
    assert.ok(options.signal instanceof AbortSignal);
    return serialized;
  });
  const keychain = t.mock.method(childProcess, 'execFile', () => { throw new Error('Unexpected Keychain access'); });
  const credentials = new MacClaudeCredentials(defaultHome);
  assert.equal(await credentials.getAccessToken(false, signal()), 'synthetic-file-token');
  for (serialized of ['private-malformed-json', '', serialize('private\ntoken'), '{}']) {
    await assert.rejects(credentials.getAccessToken(true, signal()), error =>
      error instanceof QuotaError && error.code === 'authentication' && !error.message.includes('private'));
  }
  assert.equal(keychain.mock.callCount(), 0);
});

test('macOS falls back to bounded Keychain reads only after default-home file read failures', async t => {
  for (const failure of ['missing', 'oversized', 'directory', 'unreadable']) {
    await t.test(failure, async t => {
      mockMissingFile(t);
      if (failure !== 'missing') {
        t.mock.method(fs, 'stat', async () => ({ size: failure === 'oversized' ? 1_048_577 : 128,
          isFile: () => failure !== 'directory' }));
      }
      const requestSignal = signal();
      let calls = 0;
      t.mock.method(childProcess, 'execFile', (file: string, args: string[], options: childProcess.ExecFileOptions,
        callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        assert.equal(file, '/usr/bin/security');
        assert.deepEqual(args, ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
        assert.equal(options.signal, requestSignal);
        assert.equal(options.timeout, 5_000);
        assert.equal(options.maxBuffer, 1_048_576);
        calls++;
        queueMicrotask(() => callback(null, serialize(`synthetic-keychain-${calls}`), ''));
        return new childProcess.ChildProcess();
      });
      const credentials = new MacClaudeCredentials(defaultHome);
      assert.equal(await credentials.getAccessToken(false, requestSignal), 'synthetic-keychain-1');
      assert.equal(await credentials.getAccessToken(true, requestSignal), 'synthetic-keychain-2');
      assert.equal(calls, 2);
    });
  }
});

test('Windows never invokes Keychain, including when its default credential file is unavailable', async t => {
  mockMissingFile(t);
  const keychain = t.mock.method(childProcess, 'execFile', () => { throw new Error('Unexpected Keychain access'); });
  await assert.rejects(new WindowsClaudeCredentials(defaultHome).getAccessToken(false, signal()), { code: 'authentication' });
  assert.equal(keychain.mock.callCount(), 0);
});

test('macOS Keychain command failures and invalid payloads expose only fixed login guidance', async t => {
  mockMissingFile(t);
  let commandError: Error | null = new Error('private-command-error');
  let output = 'private-stdout';
  let synchronousFailure = false;
  t.mock.method(childProcess, 'execFile', (_file: string, _args: string[], _options: childProcess.ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    if (synchronousFailure) throw new Error('private-synchronous-command-error');
    queueMicrotask(() => callback(commandError, output, 'private-stderr'));
    return new childProcess.ChildProcess();
  });
  const credentials = new MacClaudeCredentials(defaultHome);
  const assertSafeError = async () => assert.rejects(credentials.getAccessToken(false, signal()), error =>
    error instanceof QuotaError && error.code === 'authentication' && !error.message.includes('private'));
  await assertSafeError();
  commandError = null;
  for (output of ['private-invalid-json', serialize('private\ntoken'), serialize('')]) await assertSafeError();
  synchronousFailure = true;
  await assertSafeError();
});

test('cancelled Claude file reads do not start Keychain', async t => {
  mockMissingFile(t);
  const keychain = t.mock.method(childProcess, 'execFile', () => { throw new Error('Unexpected Keychain access'); });
  const controller = new AbortController();
  controller.abort();
  for (const Credentials of [WindowsClaudeCredentials, MacClaudeCredentials]) {
    await assert.rejects(new Credentials(defaultHome).getAccessToken(false, controller.signal), { code: 'cancelled' });
  }
  assert.equal(keychain.mock.callCount(), 0);
});

test('Claude quota cancellation reaches a pending macOS Keychain command without making an HTTP request', async t => {
  mockMissingFile(t);
  let started!: () => void;
  const commandStarted = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(childProcess, 'execFile', (_file: string, _args: string[], options: childProcess.ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    options.signal!.addEventListener('abort', () => callback(new Error('private-abort-error'), '', ''), { once: true });
    started();
    return new childProcess.ChildProcess();
  });
  let requests = 0;
  const provider = new ClaudeQuotaProvider({ credentials: new MacClaudeCredentials(defaultHome),
    fetch: async () => { requests++; throw new Error('Unexpected HTTP request'); } });
  const controller = new AbortController();
  const pending = provider.read({ signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'cancelled' });
  await commandStarted;
  controller.abort();
  await rejected;
  assert.equal(requests, 0);
  await provider.dispose();
});
