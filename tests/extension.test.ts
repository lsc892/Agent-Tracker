import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Disposable = { dispose(): void };
type Command = string | { command: string; arguments?: unknown[] };
type StatusItem = Disposable & {
  id: string; alignment: number; priority: number; text?: string; color?: string;
  command?: Command; visible: boolean; disposed: boolean; show(): void; hide(): void;
};

function event<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe: (listener: (value: T) => void): Disposable => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    fire: (value: T): void => { for (const listener of listeners) listener(value); },
    size: (): number => listeners.size,
  };
}

function mockWebview() {
  const incoming = event<unknown>();
  const messages: Record<string, unknown>[] = [];
  return {
    html: '', options: {}, cspSource: 'local:', messages,
    asWebviewUri: (value: unknown) => value,
    postMessage: async (message: Record<string, unknown>) => { messages.push(message); return true; },
    onDidReceiveMessage: incoming.subscribe, receive: incoming.fire, listenerCount: incoming.size,
  };
}

test('quota controls never scan summaries; usage entry alone refreshes usage and management commands stay bounded', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'tracker-extension-test-'));
  const Module = require('node:module') as { _load(request: string, parent: unknown, isMain: boolean): unknown };
  const original = Module._load;
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const externalCommands: { command: string; arguments: unknown[] }[] = [];
  const items: StatusItem[] = [];
  const refreshes: { provider: string; force: boolean }[] = [];
  const configValues = new Map<string, unknown>();
  const configUpdates: { key: string; value: unknown; target: number }[] = [];
  const configuration = event<{ affectsConfiguration(section: string): boolean }>();
  const themes = event<{ kind: number }>();
  const focus = event<{ focused: boolean }>();
  const visibility = event<void>();
  const quotaDisposed = event<void>();
  const errors: string[] = [];
  const subscriptions: Disposable[] = [];
  const quotaView = {
    visible: false, webview: mockWebview(),
    onDidChangeVisibility: visibility.subscribe, onDidDispose: quotaDisposed.subscribe,
    show() { this.visible = true; visibility.fire(); },
  };
  const panels: { webview: ReturnType<typeof mockWebview>; revealCount: number; disposed: boolean; dispose(): void }[] = [];
  let provider: import('vscode').WebviewViewProvider | undefined;
  let viewResolved = false;
  let scans = 0;
  let queries = 0;
  let diagnostics = 0;
  let initializations = 0;
  let quotaDisposals = 0;
  let summaryDisposals = 0;
  const uri = (fsPath: string): { fsPath: string; toString(): string } => ({ fsPath, toString: () => fsPath });
  const disposable: Disposable = { dispose() {} };
  const activeColorTheme = { kind: 2 };
  const vscode = {
    Uri: { joinPath: (base: { fsPath: string }, ...segments: string[]) => uri(join(base.fsPath, ...segments)) },
    StatusBarAlignment: { Right: 2 }, ViewColumn: { Active: -1 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 }, ConfigurationTarget: { Global: 1 },
    workspace: {
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => configValues.get(key) ?? fallback,
        update: async (key: string, value: unknown, target: number) => {
          configUpdates.push({ key, value, target });
          configValues.set(key, value);
          configuration.fire({ affectsConfiguration: section => section === 'agentTracker' });
        },
      }),
      onDidChangeConfiguration: configuration.subscribe,
    },
    commands: {
      registerCommand: (name: string, fn: (...args: unknown[]) => unknown) => {
        commands.set(name, fn);
        return { dispose: () => { commands.delete(name); } };
      },
      executeCommand: async (name: string, ...args: unknown[]) => {
        if (commands.has(name)) return commands.get(name)!(...args);
        externalCommands.push({ command: name, arguments: args });
        if (name === 'agentTracker.quotaView.focus') {
          assert.ok(provider, 'the quota view is registered before the status button is used');
          quotaView.visible = true;
          if (!viewResolved) {
            viewResolved = true;
            await provider.resolveWebviewView(quotaView as unknown as import('vscode').WebviewView,
              {} as import('vscode').WebviewViewResolveContext, {} as import('vscode').CancellationToken);
          }
          visibility.fire();
        } else if (name === 'workbench.action.closePanel') {
          quotaView.visible = false;
          visibility.fire();
        }
      },
    },
    window: {
      state: { focused: true }, activeColorTheme,
      onDidChangeWindowState: focus.subscribe, onDidChangeActiveColorTheme: themes.subscribe,
      showErrorMessage: (message: string) => { errors.push(message); },
      registerWebviewViewProvider: (id: string, value: import('vscode').WebviewViewProvider) => {
        assert.equal(id, 'agentTracker.quotaView');
        provider = value;
        return disposable;
      },
      createStatusBarItem: (id: string, alignment: number, priority: number) => {
        const item: StatusItem = { id, alignment, priority, visible: false, disposed: false,
          show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { this.disposed = true; } };
        items.push(item);
        return item;
      },
      createWebviewPanel: () => {
        const disposed = event<void>();
        const panel = {
          webview: mockWebview(), revealCount: 0, disposed: false, onDidDispose: disposed.subscribe,
          reveal() { this.revealCount++; },
          dispose() { if (!this.disposed) { this.disposed = true; disposed.fire(); } },
        };
        panels.push(panel);
        return panel;
      },
    },
  };
  class FakeQuota {
    start() {} setFocused() {} setPollingInterval() {} subscribe() { return disposable; }
    async dispose() { quotaDisposals++; }
    getState(provider: string) { return { provider, snapshot: null, refreshing: false, status: 'unavailable', error: null, lastSuccessAt: null, nextAllowedAt: 0 }; }
    getStates() { return ['claude', 'codex'].map(provider => this.getState(provider)); }
    async refresh(provider: string, force: boolean) { refreshes.push({ provider, force }); }
  }
  class FakeSummary {
    async initialize() { initializations++; }
    async refresh() { scans++; return { discovered: 0, parsed: 0, reused: 0, failed: 0, bodyBytes: 0 }; }
    async query() { queries++; return { rows: [], total: 0, coverage: {} }; }
    async diagnostics() { diagnostics++; return { files: [], summaries: [], counts: {} }; }
    subscribe() { return () => {}; } cancel() {} async dispose() { summaryDisposals++; }
  }
  Module._load = function(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === './quota') return { QuotaService: FakeQuota, ClaudeQuotaProvider: class {}, CodexQuotaProvider: class {} };
    if (request === './summary/client') return { SummaryClient: FakeSummary };
    return original.call(this, request, parent, isMain);
  };
  let extension: typeof import('../src/extension') | undefined;
  const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  const click = async (command: Command | undefined): Promise<void> => {
    assert.ok(command);
    await vscode.commands.executeCommand(typeof command === 'string' ? command : command.command,
      ...(typeof command === 'string' ? [] : command.arguments ?? []));
    await tick();
  };
  try {
    extension = require('../src/extension') as typeof import('../src/extension');
    await extension.activate({ globalStorageUri: uri(storage), extensionUri: uri(process.cwd()), subscriptions } as unknown as import('vscode').ExtensionContext);
    assert.equal(initializations, 1);
    assert.equal(scans, 0);
    assert.equal(panels.length, 0);
    assert.deepEqual(items.map(item => item.id), ['agentTracker.quota', 'agentTracker.refreshQuota']);
    assert.ok(items[0].priority > items[1].priority, 'the refresh button is right of the combined quota button');
    assert.match(items[0].text!, /\$\(agent-tracker-claude\).*\$\(agent-tracker-codex\)/);
    assert.equal(items[0].color, '#ffffff');
    activeColorTheme.kind = 1; themes.fire(activeColorTheme);
    assert.equal(items[0].color, '#000000');

    await click(items[0].command);
    quotaView.webview.receive({ type: 'ready' }); await tick();
    assert.equal(quotaView.visible, true);
    assert.equal(quotaView.webview.messages.at(-1)?.type, 'quota');
    assert.equal(scans, 0);
    assert.equal(panels.length, 0);
    await click(items[1].command);
    assert.deepEqual(refreshes, [{ provider: 'claude', force: true }, { provider: 'codex', force: true }]);
    quotaView.webview.receive({ type: 'refreshQuota' }); await tick();
    assert.equal(refreshes.length, 4);
    assert.equal(scans, 0);

    await click(items[0].command);
    assert.equal(quotaView.visible, false);
    await click(items[0].command);
    assert.equal(quotaView.visible, true);
    assert.equal(scans, 0);
    assert.equal(quotaView.webview.listenerCount(), 1, 'reopening reuses the quota view');

    quotaView.webview.receive({ type: 'manage', provider: 'claude' });
    quotaView.webview.receive({ type: 'manage', provider: 'codex' }); await tick();
    assert.deepEqual(externalCommands.filter(call => call.command === 'extension.open').map(call => call.arguments),
      [['anthropic.claude-code'], ['openai.chatgpt']]);
    quotaView.webview.receive({ type: 'detail', detail: 'compact' }); await tick();
    assert.deepEqual(configUpdates, [{ key: 'display.detail', value: 'compact', target: 1 }]);
    assert.equal(quotaView.webview.messages.at(-1)?.detail, 'compact');
    const commandCount = externalCommands.length;
    for (const message of [
      { type: 'executeCommand', command: 'unsafe' }, { type: 'manage', provider: '../../credential' },
      { type: 'detail', detail: 'unsafe' }, { type: 'refreshUsage' },
    ]) quotaView.webview.receive(message);
    await tick();
    assert.equal(externalCommands.length, commandCount);
    assert.equal(configUpdates.length, 1);
    assert.equal(refreshes.length, 4);
    assert.equal(scans, 0);

    quotaView.webview.receive({ type: 'openUsage' }); await tick();
    assert.equal(quotaView.visible, false);
    assert.equal(panels.length, 1);
    assert.equal(scans, 0, 'summary starts only when the usage webview is ready');
    const dashboard = panels[0].webview;
    dashboard.receive({ type: 'ready' }); await tick();
    assert.equal(scans, 1);
    assert.ok(dashboard.messages.some(message => message.type === 'navigate' && message.tab === 'usage'));
    dashboard.receive({ type: 'ready' }); await tick();
    assert.equal(scans, 1, 'duplicate ready messages do not start another summary');
    dashboard.receive({ type: 'tab', tab: 'diagnostics' }); await tick();
    assert.equal(diagnostics, 1);
    dashboard.receive({ type: 'tab', tab: 'usage' }); await tick();
    dashboard.receive({ type: 'queryUsage', query: { groupBy: 'month' } }); await tick();
    assert.ok(queries >= 3, 'usage tabs and filters read cached summary rows');
    assert.equal(scans, 1);
    for (const message of [{ type: 'refreshUsage' }, { type: 'refreshQuota', provider: 'claude' }, { type: 'tab', tab: 'quota' }]) dashboard.receive(message);
    await tick();
    assert.equal(scans, 1);
    assert.equal(refreshes.length, 4);
    await click('agentTracker.openUsage');
    assert.equal(scans, 2, 'explicit entry into usage refreshes its summary');
    assert.equal(panels.length, 1);
    assert.ok(panels[0].revealCount > 0);
    await click(items[1].command);
    assert.equal(refreshes.length, 6);
    assert.equal(scans, 2, 'quota refresh does not scan even while statistics are open');
    await click('agentTracker.refreshClaude');
    await click('agentTracker.refreshCodex');
    assert.deepEqual(refreshes.slice(-2), [{ provider: 'claude', force: true }, { provider: 'codex', force: true }]);
    assert.equal(scans, 2);
    await click({ command: 'agentTracker.openDashboard', arguments: [{ tab: 'quota', provider: 'codex' }] });
    assert.equal(quotaView.visible, true, 'legacy quota commands open the new quota view');
    assert.equal(scans, 2);
    assert.deepEqual(errors, []);

    await extension.deactivate();
    for (const subscription of subscriptions) subscription.dispose();
    assert.equal(quotaDisposals, 1);
    assert.equal(summaryDisposals, 1);
    assert.equal(panels[0].disposed, true);
    assert.ok(items.every(item => item.disposed));
    assert.equal(quotaView.webview.listenerCount(), 0);
    assert.equal(themes.size(), 0);
  } finally {
    await extension?.deactivate();
    for (const subscription of subscriptions) subscription.dispose();
    Module._load = original;
    await rm(storage, { recursive: true, force: true });
  }
});
