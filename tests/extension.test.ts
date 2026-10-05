import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Disposable = { dispose(): void };
type Command = string | { command: string; arguments?: unknown[] };
type StatusItem = Disposable & {
  id: string; alignment: number; priority: number; text?: string; color?: string;
  tooltip?: string | import('vscode').MarkdownString;
  accessibilityInformation?: { label: string; role?: string };
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
  const errors: string[] = [];
  const subscriptions: Disposable[] = [];
  const panels: { webview: ReturnType<typeof mockWebview>; revealCount: number; disposed: boolean; dispose(): void }[] = [];
  let scans = 0;
  let queries = 0;
  let diagnostics = 0;
  let initializations = 0;
  let quotaDisposals = 0;
  let summaryDisposals = 0;
  const uri = (fsPath: string): { fsPath: string; toString(): string } => ({ fsPath, toString: () => fsPath });
  const disposable: Disposable = { dispose() {} };
  const activeColorTheme = { kind: 2 };
  class MarkdownString {
    value = '';
    appendMarkdown(value: string) { this.value += value; return this; }
    appendText(value: string) { this.value += value.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&'); return this; }
  }
  const vscode = {
    MarkdownString,
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
      },
    },
    window: {
      state: { focused: true }, activeColorTheme,
      onDidChangeWindowState: focus.subscribe, onDidChangeActiveColorTheme: themes.subscribe,
      showErrorMessage: (message: string) => { errors.push(message); },
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
    getState(provider: string) { return { provider, snapshot: {provider,fetchedAt:0,windows:[
      {id:'five-hour',label:'5h',usedPercent:23,current:23,maximum:100,resetsAt:null,windowDurationMins:300},
      {id:'weekly',label:'7d',usedPercent:92,current:92,maximum:100,resetsAt:null,windowDurationMins:10080},
    ]}, refreshing: false, status: 'ready', error: null, lastSuccessAt: 0, nextAllowedAt: 0 }; }
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
  const tooltip = (): import('vscode').MarkdownString => {
    assert.ok(items[0].tooltip instanceof MarkdownString);
    return items[0].tooltip as import('vscode').MarkdownString;
  };
  const cardAction = async (id: string, argument?: string): Promise<void> => {
    const links = [...tooltip().value.matchAll(/\]\(command:([^)?]+)(?:\?([^)]*))?\)/g)];
    const link = links.find(value => value[1] === id && (!argument || JSON.parse(decodeURIComponent(value[2]))[0] === argument));
    assert.ok(link, `the card exposes ${id} with ${argument ?? 'no argument'}`);
    const trusted = tooltip().isTrusted;
    assert.ok(trusted && typeof trusted === 'object' && trusted.enabledCommands.includes(id));
    await click({ command: id, arguments: link[2] ? JSON.parse(decodeURIComponent(link[2])) : [] });
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
    assert.equal(items[0].text!.match(/7일/g)?.length,2);
    assert.equal(items[0].text!.match(/5시간/g)?.length,2);
    assert.equal(items[0].color, '#ffffff');
    activeColorTheme.kind = 1; themes.fire(activeColorTheme);
    assert.equal(items[0].color, '#000000');

    assert.equal(items[0].command, 'agentTracker.toggleQuotaTooltip', 'the renderer uses this command to toggle the native card');
    assert.equal(items[0].accessibilityInformation?.label, 'Claude: 5시간 - 77% 남음\nCodex: 5시간 - 77% 남음\n클릭하여 열기/닫기');
    await click(items[0].command);
    assert.deepEqual(externalCommands.at(-1), { command: 'workbench.action.showHover', arguments: [] }, 'an unpatched renderer can still open the focused hover');
    assert.equal(commands.has('agentTracker.toggleQuota'), false);
    assert.equal(tooltip().supportThemeIcons, true);
    assert.match(tooltip().value, /### 사용량/);
    assert.equal(tooltip().value.match(/\| 7d \|/g)?.length, 2);
    assert.equal(tooltip().value.match(/\| 5h \|/g)?.length, 2);
    assert.equal(scans, 0);
    assert.equal(panels.length, 0);
    await click(items[1].command);
    assert.deepEqual(refreshes, [{ provider: 'claude', force: true }, { provider: 'codex', force: true }]);
    await cardAction('agentTracker.refreshQuota');
    assert.equal(refreshes.length, 4);
    assert.equal(scans, 0);

    await cardAction('agentTracker.manageProvider', 'claude');
    await cardAction('agentTracker.manageProvider', 'codex');
    assert.deepEqual(externalCommands.filter(call => call.command === 'extension.open').map(call => call.arguments),
      [['anthropic.claude-code'], ['openai.chatgpt']]);
    await cardAction('agentTracker.setStatusBarDetail', 'compact');
    assert.deepEqual(configUpdates, [{ key: 'display.detail', value: 'compact', target: 1 }]);
    assert.doesNotMatch(items[0].text!,/7일|92%/);
    assert.equal(items[0].text!.match(/5시간/g)?.length,2);
    assert.equal(tooltip().value.match(/\| 7d \|/g)?.length, 2, 'compact status still shows every window in the hover');
    await cardAction('agentTracker.setStatusBarDetail', 'detailed');
    assert.equal(items[0].text!.match(/7일/g)?.length, 2);
    const commandCount = externalCommands.length;
    for (const provider of ['../../credential', 'arbitrary.extension', undefined, {}]) {
      await click({ command: 'agentTracker.manageProvider', arguments: [provider] });
    }
    for (const detail of ['unsafe', undefined, {}]) {
      await click({ command: 'agentTracker.setStatusBarDetail', arguments: [detail] });
    }
    assert.equal(externalCommands.length, commandCount);
    assert.equal(configUpdates.length, 2);
    assert.equal(refreshes.length, 4);
    assert.equal(scans, 0);

    await cardAction('agentTracker.openUsage');
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
    assert.equal(externalCommands.some(value => /quotaView\.focus|closePanel/.test(value.command)), false, 'quota actions never open or close the terminal panel');
    await click({ command: 'agentTracker.openDashboard', arguments: [{ tab: 'quota' }] });
    assert.equal(panels.length, 1, 'legacy quota navigation cannot create a statistics panel');
    assert.equal(scans, 2);
    assert.deepEqual(errors, []);

    await extension.deactivate();
    for (const subscription of subscriptions) subscription.dispose();
    assert.equal(quotaDisposals, 1);
    assert.equal(summaryDisposals, 1);
    assert.equal(panels[0].disposed, true);
    assert.ok(items.every(item => item.disposed));
    assert.equal(themes.size(), 0);
  } finally {
    await extension?.deactivate();
    for (const subscription of subscriptions) subscription.dispose();
    Module._load = original;
    await rm(storage, { recursive: true, force: true });
  }
});
