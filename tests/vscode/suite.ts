import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';

/** Runs in a real Extension Development Host; the ordinary node:test suite skips this file. */
export async function run(): Promise<void> {
  const extensionRoot = resolve(__dirname, '../../..');
  const extension = vscode.extensions.getExtension('agent-tracker.agent-tracker');
  assert.ok(extension, 'Extension is discoverable by VS Code');
  const htmlModule = require(join(extensionRoot, 'dist/src/ui/html')) as typeof import('../../src/ui/html');
  const protocol = require(join(extensionRoot, 'dist/src/ui/presentation')) as typeof import('../../src/ui/presentation');
  const originalHtml = htmlModule.dashboardHtml;
  const originalParser = protocol.parseDashboardMessage;
  let onReport: ((message: { ok: boolean; detail: string }) => void) | undefined;
  protocol.parseDashboardMessage = (raw: unknown) => {
    if (raw && typeof raw === 'object' && (raw as { type?: string }).type === 'smoke-report') {
      onReport?.(raw as { ok: boolean; detail: string });
      return null;
    }
    return originalParser(raw);
  };
  let expectedTheme = 'vscode-dark';
  let expectTimezoneWarning = false;
  htmlModule.dashboardHtml = (...args: Parameters<typeof originalHtml>) => {
    // Test-only DOM driver shares the existing Webview nonce. Production assets are unchanged.
    const driver = `
      (() => {
        let phase = 'quota';
        let latestState;
        const report = (ok, detail) => window.dispatchEvent(new CustomEvent('tracker-smoke-report', {detail:{type:'smoke-report',ok,detail}}));
        const check = (condition, detail) => { if (!condition) throw new Error(detail); };
        window.addEventListener('error', event => report(false,event.message));
        window.addEventListener('message', event => {
          try {
            const message = event.data;
            if (message.type === 'state') latestState = message;
            if (phase === 'quota' && message.type === 'navigate' && message.tab === 'quota') {
              // Wait for initial navigation so a queued host message cannot undo our click.
              check(document.body.classList.contains(${JSON.stringify(expectedTheme)}),'VS Code theme class is applied');
              check(document.querySelectorAll('.card').length === 2,'two provider cards rendered');
              check(document.getElementById('card-codex').textContent.includes('Codex'),'Codex card visible');
              check(document.activeElement.id === 'card-codex','requested provider card receives focus');
              check(getComputedStyle(document.getElementById('card-codex')).borderRadius === '8px','shipped stylesheet is loaded');
              check(document.getElementById('configuration-warning').hidden === ${JSON.stringify(!expectTimezoneWarning)},'invalid timezone warning is visible and clears after correction');
              phase = 'countdown';
              const originalState = latestState;
              const originalNow = Date.now;
              const now = originalNow();
              const emit = data => window.dispatchEvent(new MessageEvent('message', {data}));
              try {
                const snapshot = {provider:'codex',fetchedAt:now,windows:[{id:'synthetic',label:'5h',usedPercent:42,current:42,maximum:100,resetsAt:now+90000,windowDurationMins:300}]};
                const state = {...originalState,quota:[{provider:'codex',status:'ready',snapshot,refreshing:false,error:null,lastSuccessAt:now}]};
                emit(state);
                document.querySelector('#card-codex [data-action="refresh"]').focus();
                emit(state);
                const focused = document.activeElement;
                check(focused.dataset.action === 'refresh','quota updates preserve focused action');
                const countdown = document.querySelector('.countdown');
                const before = countdown.textContent;
                Date.now = () => now + 61000;
                window.trackerCountdownTick();
                check(countdown.textContent !== before,'countdown advances while a card action has focus');
                check(document.activeElement === focused,'countdown does not rebuild or blur controls');
                Date.now = () => now + 120000;
                window.trackerCountdownTick();
                check(countdown.textContent.includes('시각 지남'),'expired countdown waits for the next quota read');
                check(document.querySelector('progress').value === 42,'countdown never invents a reset quota');
              } finally { Date.now = originalNow; emit(originalState); }
              phase = 'usage'; document.getElementById('open-usage').click();
            } else if (phase === 'usage' && message.type === 'usage' && message.result.rows.length) {
              check(message.result.rows[0].total_tokens === 150,'worker usage reached Webview');
              check(document.getElementById('usage-table').textContent.includes('150'),'usage table renders total');
              check(document.getElementById('usage').hidden === false,'Usage click changes visible tab');
              phase = 'turn'; document.getElementById('group').value = 'turn';
              document.getElementById('session-id').value = 'ui-session';
              document.getElementById('usage-filters').requestSubmit();
            } else if (phase === 'turn' && message.type === 'usage' && message.result.groupBy === 'turn') {
              check(message.result.rows.length === 1 && message.result.rows[0].root_turn_id === 'ui-turn','request group and session filter are applied');
              check(document.getElementById('usage-table').textContent.includes('ui-turn'),'request identity is rendered');
              phase = 'empty'; document.getElementById('from-day').value = '2026-10-04';
              document.getElementById('usage-filters').requestSubmit();
            } else if (phase === 'empty' && message.type === 'usage') {
              check(message.result.total === 0,'date filter excludes earlier requests');
              check(document.querySelector('#usage-table .empty'),'empty state renders');
              check(document.getElementById('previous').disabled && document.getElementById('next').disabled,'empty pagination is disabled');
              phase = 'diagnostics'; document.querySelector('[data-tab="diagnostics"]').click();
            } else if (phase === 'diagnostics' && message.type === 'diagnostics') {
              check(message.result.counts.files === 1,'diagnostics returns fixture manifest');
              check(document.getElementById('diagnostic-files').textContent.includes('session.jsonl'),'diagnostics renders source filename');
              phase='diagnostics-page'; document.getElementById('diagnostic-next').disabled=false;
              document.getElementById('diagnostic-next').click();
            } else if (phase === 'diagnostics-page' && message.type === 'diagnostics') {
              check(message.offset === 100,'diagnostics next page requests the next offset');
              phase='diagnostics-return'; document.querySelector('[data-tab="quota"]').click();
              document.querySelector('[data-tab="diagnostics"]').click();
            } else if (phase === 'diagnostics-return' && message.type === 'diagnostics') {
              check(message.offset === 0 && document.getElementById('diagnostic-previous').disabled,'returning to diagnostics resets page and controls together');
              check(document.getElementById('diagnostic-page').textContent.startsWith('1번째'),'diagnostics label matches returned rows');
              phase='complete'; report(true,'quota → usage → diagnostics in '+${JSON.stringify(expectedTheme)});
            } else if (message.type === 'error') { phase='failed'; report(false,message.message); }
          } catch(error) { phase='failed'; report(false,error.message); }
        });
      })();`;
    // Reuse the single VS Code API object acquired by the shipped dashboard script.
    const bridge = `window.addEventListener('tracker-smoke-report', event => vscode.postMessage(event.detail));
      const originalSetInterval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => { if (delay === 30000) window.trackerCountdownTick = callback; return originalSetInterval(callback, delay, ...args); };`;
    const script = readFileSync(join(extensionRoot, 'media', 'dashboard.js'), 'utf8')
      .replace('const vscode = acquireVsCodeApi();', `const vscode = acquireVsCodeApi();${bridge}`);
    const html = originalHtml(...args);
    return html.replace(/<script nonce="[^"]+" src="[^"]+"><\/script>/,
      () => `<script nonce="${args[3]}">${script}</script><script nonce="${args[3]}">${driver}</script>`);
  };
  const outcomes: string[] = [];
  try {
    await extension.activate();
    assert.ok(extension.isActive);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('agentTracker.openUsage'));
    const userData = process.env.AGENT_TRACKER_TEST_USER_DATA!;
    const databasePath = join(userData, 'User', 'globalStorage', 'agent-tracker.agent-tracker', 'agent-tracker.sqlite');
    await until(() => existsSync(databasePath), 'schema initialization');
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      await until(() => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE name='manifest'").get()), 'schema creation');
      assert.equal((database.prepare('SELECT count(*) n FROM manifest').get() as { n: number }).n, 0, 'activation does not scan');
      await vscode.commands.executeCommand('agentTracker.refreshCodex');
      assert.equal((database.prepare('SELECT count(*) n FROM manifest').get() as { n: number }).n, 0, 'quota does not scan');
    } finally { database.close(); }
    for (const theme of [{ name: 'Default Dark Modern', css: 'vscode-dark' }, { name: 'Default Light Modern', css: 'vscode-light' }]) {
      expectedTheme = theme.css;
      expectTimezoneWarning = theme.css === 'vscode-dark';
      await vscode.workspace.getConfiguration('agentTracker').update('usage.timezone', expectTimezoneWarning ? 'Not/A_Timezone' : 'Asia/Seoul', vscode.ConfigurationTarget.Global);
      await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme.name, vscode.ConfigurationTarget.Global);
      await new Promise(resolve => setTimeout(resolve, 500));
      const completed = new Promise<void>((resolveReport, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Webview smoke timed out (${theme.css})`)), 20_000);
        onReport = message => { clearTimeout(timeout); if (message.ok) { outcomes.push(message.detail); resolveReport(); } else reject(new Error(message.detail)); };
      });
      await vscode.commands.executeCommand('agentTracker.openDashboard', { tab: 'quota', provider: 'codex' });
      await completed;
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
    const reportDirectory = join(extensionRoot, 'test-results');
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(join(reportDirectory, 'vscode-smoke.json'), JSON.stringify({ version: vscode.version, node: process.versions.node, passed: true, outcomes }, null, 2));
    console.log('Agent Tracker real VS Code smoke passed:', outcomes.join('; '));
  } finally {
    htmlModule.dashboardHtml = originalHtml;
    protocol.parseDashboardMessage = originalParser;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}

async function until(test: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timed out waiting for ${label}`);
}
