import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('extension activation does not scan; status clicks, usage, and provider refresh remain independent', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'tracker-extension-test-'));
  const Module = require('node:module') as { _load(request: string, parent: unknown, isMain: boolean): unknown };
  const original = Module._load;
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const items: { id: string; alignment: number; priority: number; text?: string; command?: { command: string; arguments: unknown[] }; show(): void; hide(): void; dispose(): void }[] = [];
  const messages: Record<string, unknown>[] = [];
  const refreshes: string[] = [];
  let scans = 0;
  let initializations = 0;
  let receive: (value: unknown) => void = () => {};
  const uri = (fsPath: string): { fsPath: string; toString(): string } => ({ fsPath, toString: () => fsPath });
  const disposable = { dispose() {} };
  const vscode = {
    Uri: { joinPath: (base: { fsPath: string }, ...segments: string[]) => uri(join(base.fsPath, ...segments)) },
    StatusBarAlignment: { Right: 2 }, ViewColumn: { Active: -1 }, ThemeColor: class { constructor(readonly id: string) {} },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), onDidChangeConfiguration: () => disposable },
    commands: { registerCommand: (name: string, fn: (...args: unknown[]) => unknown) => { commands.set(name, fn); return disposable; }, executeCommand: async (name: string, ...args: unknown[]) => { refreshes.push(name + ':' + args.join()); } },
    window: { state: { focused: true }, onDidChangeWindowState: () => disposable, showErrorMessage: () => undefined,
      createStatusBarItem: (id: string, alignment: number, priority: number) => { const item = { id, alignment, priority, ...disposable, show() {}, hide() {} }; items.push(item); return item; },
      createWebviewPanel: () => ({ webview: { html: '', cspSource: 'local:', asWebviewUri: (value: unknown) => value,
        postMessage: async (message: Record<string, unknown>) => { messages.push(message); return true; }, onDidReceiveMessage: (fn: typeof receive) => { receive = fn; return disposable; } }, onDidDispose: () => disposable, reveal() {}, ...disposable }),
    },
  };
  class FakeQuota {
    start() {} setFocused() {} setPollingInterval() {} subscribe() { return disposable; } async dispose() {}
    getState(provider: string) { return { provider, snapshot: null, refreshing: false, status: 'unavailable', error: null, lastSuccessAt: null }; }
    getStates() { return ['claude', 'codex'].map(provider => this.getState(provider)); }
    async refresh(provider: string) { refreshes.push(provider); }
  }
  class FakeSummary {
    async initialize() { initializations++; }
    async refresh() { scans++; return { discovered: 0, parsed: 0, reused: 0, failed: 0, bodyBytes: 0 }; }
    async query() { return { rows: [], total: 0, coverage: {} }; }
    async diagnostics() { return { files: [], summaries: [], counts: {} }; }
    subscribe() { return () => {}; } cancel() {} async dispose() {}
  }
  Module._load = function(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === './quota') return { QuotaService: FakeQuota, ClaudeQuotaProvider: class {}, CodexQuotaProvider: class {} };
    if (request === './summary/client') return { SummaryClient: FakeSummary };
    return original.call(this, request, parent, isMain);
  };
  let extension: typeof import('../src/extension') | undefined;
  const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  try {
    extension = require('../src/extension') as typeof import('../src/extension');
    await extension.activate({ globalStorageUri: uri(storage), extensionUri: uri(process.cwd()), subscriptions: [] } as unknown as import('vscode').ExtensionContext);
    assert.equal(initializations, 1);
    assert.equal(scans, 0);
    assert.deepEqual(items.map(item => [item.id, item.priority]), [['agentTracker.claudeQuota', 100], ['agentTracker.codexQuota', 99]]);
    commands.get(items[1].command!.command)!(...items[1].command!.arguments);
    receive({ type: 'ready' }); await tick();
    assert.ok(messages.some(message => message.type === 'navigate' && message.provider === 'codex' && message.tab === 'quota'));
    assert.equal(scans, 0);
    receive({ type: 'refreshQuota', provider: 'claude' }); await tick();
    assert.deepEqual(refreshes, ['claude']);
    assert.equal(scans, 0);
    receive({ type: 'tab', tab: 'usage' }); await tick();
    assert.equal(scans, 1);
    receive({ type: 'settings', provider: 'codex' }); await tick();
    assert.match(refreshes.at(-1)!, /workbench.action.openSettings.*agentTracker.codex/);
    receive({ type: 'executeCommand', command: 'unsafe' }); await tick();
    assert.equal(refreshes.length, 2);
  } finally {
    await extension?.deactivate();
    Module._load = original;
    await rm(storage, { recursive: true, force: true });
  }
});
