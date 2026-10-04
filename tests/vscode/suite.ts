import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';

interface SmokeReport { type: 'smoke-report'; ok: boolean; detail: string; stage: 'quota' | 'usage'; theme: string }

/** Runs in a real Extension Development Host; the ordinary node:test suite skips this file. */
export async function run(): Promise<void> {
  const extensionRoot = resolve(__dirname, '../../..');
  const extension = vscode.extensions.getExtension('agent-tracker.agent-tracker');
  assert.ok(extension, 'Extension is discoverable by VS Code');
  const htmlModule = require(join(extensionRoot, 'dist/src/ui/html')) as typeof import('../../src/ui/html');
  const protocol = require(join(extensionRoot, 'dist/src/ui/presentation')) as typeof import('../../src/ui/presentation');
  const quotaModule = require(join(extensionRoot, 'dist/src/ui/quotaViewPresentation')) as typeof import('../../src/ui/quotaViewPresentation');
  const summaryModule = require(join(extensionRoot, 'dist/src/summary/client')) as typeof import('../../src/summary/client');
  const originalHtml = htmlModule.dashboardHtml;
  const originalParser = protocol.parseDashboardMessage;
  const originalQuotaHtml = quotaModule.quotaHtml;
  const originalQuotaParser = quotaModule.parseQuotaMessage;
  const originalRefresh = summaryModule.SummaryClient.prototype.refresh;
  let onReport: ((message: SmokeReport) => void) | undefined;
  let expectedTheme = 'vscode-dark';
  let expectTimezoneWarning = false;
  let scanCount = 0;
  let refreshClicks = 0;
  let usageClicks = 0;
  const managedProviders = new Set<string>();
  const detailModes = new Set<string>();
  const isReport = (raw: unknown): raw is SmokeReport => Boolean(raw && typeof raw === 'object' && (raw as { type?: string }).type === 'smoke-report');
  protocol.parseDashboardMessage = (raw: unknown) => {
    if (isReport(raw)) { onReport?.(raw); return null; }
    return originalParser(raw);
  };
  quotaModule.parseQuotaMessage = (raw: unknown) => {
    if (isReport(raw)) { onReport?.(raw); return null; }
    const message = originalQuotaParser(raw);
    if (message?.type === 'manage') {
      // Exercise the actual button and allowlist without leaving the quota view for the marketplace.
      managedProviders.add(message.provider);
      return null;
    }
    if (message?.type === 'detail') detailModes.add(message.detail);
    if (message?.type === 'refreshQuota') refreshClicks++;
    if (message?.type === 'openUsage') usageClicks++;
    return message;
  };
  summaryModule.SummaryClient.prototype.refresh = function (...args: Parameters<typeof originalRefresh>) {
    scanCount++;
    return originalRefresh.apply(this, args);
  };
  const bridge = `window.addEventListener('tracker-smoke-report', event => vscode.postMessage(event.detail));`;
  const inlineScript = (html: string, file: string, nonce: string, driver: string, extraBridge = ''): string => {
    const script = readFileSync(join(extensionRoot, 'media', file), 'utf8')
      .replace('const vscode = acquireVsCodeApi();', `const vscode = acquireVsCodeApi();${bridge}${extraBridge}`);
    return html.replace(/<script nonce="[^"]+" src="[^"]+"><\/script>/,
      () => `<script nonce="${nonce}">${script}</script><script nonce="${nonce}">${driver}</script>`);
  };
  quotaModule.quotaHtml = assets => {
    const driver = `
      (() => {
        let phase = 'idle';
        let testedTheme;
        let theme;
        let sawRefreshing = false;
        const report = (ok, detail) => window.dispatchEvent(new CustomEvent('tracker-smoke-report', {detail:{type:'smoke-report',stage:'quota',theme,ok,detail}}));
        const check = (condition, detail) => { if (!condition) throw new Error(detail); };
        window.addEventListener('error', event => report(false,event.message));
        window.addEventListener('message', event => {
          try {
            const message = event.data;
            if (message.type !== 'quota') return;
            const visibleTheme = document.body.classList.contains('vscode-light') ? 'vscode-light' : 'vscode-dark';
            if ((phase === 'idle' || phase === 'complete') && visibleTheme !== testedTheme && !message.states.some(state => state.refreshing)) {
              phase = 'checking'; theme = visibleTheme; testedTheme = theme;
              check(document.body.classList.contains(theme),'VS Code theme class is applied to quota');
              check(document.querySelectorAll('.provider').length === 2,'two provider cards rendered');
              check(document.querySelector('#provider-claude .availability').textContent === '조회 불가','Claude unavailable label is correct');
              check(document.querySelector('#provider-codex .availability').textContent === '조회 불가','Codex unavailable label is correct');
              check(!document.querySelector('main').textContent.includes('모든 에이전트') && !document.querySelector('main').textContent.includes('계정 관리'),'removed quota controls are absent');
              check(getComputedStyle(document.querySelector('.quota-panel')).borderRadius === '14px','quota stylesheet is loaded');
              const filter = getComputedStyle(document.querySelector('.codex-icon')).filter;
              check(filter.includes('brightness(0)') && (theme === 'vscode-dark' ? filter.includes('invert(1)') : !filter.includes('invert(1)')),'Codex icon switches white/black with the theme');
              const originalNow = Date.now;
              const now = originalNow();
              const emit = data => window.dispatchEvent(new MessageEvent('message', {data}));
              try {
                const windows = [
                  {id:'five-hour',label:'5h',usedPercent:42,current:42,maximum:100,resetsAt:now+90000,windowDurationMins:300},
                  {id:'weekly',label:'wk',usedPercent:75,current:75,maximum:100,resetsAt:now+3600000,windowDurationMins:10080}
                ];
                const state = {...message,percentage:'used',detail:'detailed',states:[
                  {provider:'codex',status:'ready',snapshot:{provider:'codex',fetchedAt:now,windows},refreshing:false,error:null,lastSuccessAt:now},
                  {provider:'claude',status:'unavailable',snapshot:null,refreshing:false,error:null,lastSuccessAt:null}
                ]};
                emit(state);
                const manage = document.querySelector('#provider-codex .manage');
                manage.focus(); emit(state);
                check(document.activeElement === manage,'quota updates preserve focused management action');
                check(document.querySelectorAll('#provider-codex progress').length === 2,'detailed quota shows both windows');
                check(document.querySelector('#provider-codex progress').value === 58,'quota slider displays remaining percentage');
                const countdown = document.querySelector('#provider-codex .availability');
                const before = countdown.textContent;
                Date.now = () => now + 61000; window.trackerCountdownTick();
                check(countdown.textContent !== before,'countdown advances while management action has focus');
                check(document.activeElement === manage,'countdown does not rebuild or blur controls');
                Date.now = () => now + 120000; window.trackerCountdownTick();
                check(countdown.textContent.includes('시각 지남'),'expired countdown waits for the next quota read');
                check(document.querySelector('#provider-codex progress').value === 58,'countdown never invents a reset quota');
                document.querySelector('[data-detail="compact"]').click();
                check(document.querySelectorAll('#provider-codex progress').length === 1 && document.querySelector('#provider-codex progress').value === 25,'compact mode shows the most-used window');
                check(document.querySelector('[data-detail="compact"]').getAttribute('aria-pressed') === 'true','compact selection is accessible');
                document.querySelector('[data-detail="detailed"]').click();
                check(document.querySelectorAll('#provider-codex progress').length === 2,'detailed mode restores both windows');
                emit({...state,percentage:'remaining'});
                check(document.querySelector('#provider-codex .quota-window').textContent.includes('58% 남음'),'remaining text agrees with slider');
                emit({...state,states:state.states.map(value => value.provider === 'codex' ? {...value,status:'stale'} : value)});
                check(!document.querySelector('#provider-codex .stale').hidden,'stale quota keeps its last value visible');
                document.querySelector('#provider-codex .manage').click();
                document.querySelector('#provider-claude .manage').click();
              } finally { Date.now = originalNow; emit(message); }
              phase = 'refresh'; sawRefreshing = false; document.getElementById('refresh').click();
            } else if (phase === 'refresh') {
              if (message.states.some(state => state.refreshing)) sawRefreshing = true;
              else if (sawRefreshing) {
                check(!document.getElementById('refresh').disabled,'refresh becomes available after quota completion');
                phase = 'complete'; report(true,'quota cards, remaining sliders, countdown, actions, and refresh in '+theme);
                document.getElementById('open-usage').click();
              }
            }
          } catch(error) { phase='failed'; report(false,error.message); }
        });
      })();`;
    const countdownBridge = `const originalSetInterval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => { if (delay === 30000) window.trackerCountdownTick = callback; return originalSetInterval(callback, delay, ...args); };`;
    return inlineScript(originalQuotaHtml(assets), 'quota.js', assets.nonce, driver, countdownBridge);
  };
  htmlModule.dashboardHtml = (...args: Parameters<typeof originalHtml>) => {
    const driver = `
      (() => {
        let phase = 'usage';
        const report = (ok, detail) => window.dispatchEvent(new CustomEvent('tracker-smoke-report', {detail:{type:'smoke-report',stage:'usage',theme:${JSON.stringify(expectedTheme)},ok,detail}}));
        const check = (condition, detail) => { if (!condition) throw new Error(detail); };
        window.addEventListener('error', event => report(false,event.message));
        window.addEventListener('message', event => {
          try {
            const message = event.data;
            if (message.type === 'navigate') {
              check(message.tab === 'usage','quota footer opens usage directly');
              check(document.body.classList.contains(${JSON.stringify(expectedTheme)}),'VS Code theme class is applied to statistics');
              check(!document.getElementById('quota') && !document.querySelector('[data-tab="quota"]') && !document.getElementById('refresh-usage'),'quota and summary refresh controls are absent from statistics');
              check(document.getElementById('configuration-warning').hidden === ${JSON.stringify(!expectTimezoneWarning)},'invalid timezone warning is visible and clears after correction');
            } else if (phase === 'usage' && message.type === 'usage' && message.result.rows.length) {
              check(message.result.rows[0].total_tokens === 150,'worker usage reached Webview');
              check(document.getElementById('usage-table').textContent.includes('150'),'usage table renders total');
              check(document.getElementById('usage').hidden === false,'usage is the visible default tab');
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
              phase='diagnostics-return'; document.querySelector('[data-tab="usage"]').click();
              document.querySelector('[data-tab="diagnostics"]').click();
            } else if (phase === 'diagnostics-return' && message.type === 'diagnostics') {
              check(message.offset === 0 && document.getElementById('diagnostic-previous').disabled,'returning to diagnostics resets page and controls together');
              check(document.getElementById('diagnostic-page').textContent.startsWith('1번째'),'diagnostics label matches returned rows');
              phase='complete'; report(true,'quota footer → usage filters → diagnostics in '+${JSON.stringify(expectedTheme)});
            } else if (message.type === 'error') { phase='failed'; report(false,message.message); }
          } catch(error) { phase='failed'; report(false,error.message); }
        });
      })();`;
    return inlineScript(originalHtml(...args), 'dashboard.js', args[3], driver);
  };
  const outcomes: string[] = [];
  let database: DatabaseSync | undefined;
  try {
    assert.equal(originalQuotaParser({ type: 'manage', provider: 'arbitrary-command' }), null, 'management action rejects unknown providers');
    await extension.activate();
    assert.ok(extension.isActive);
    const commands = await vscode.commands.getCommands(true);
    for (const command of ['agentTracker.openUsage', 'agentTracker.toggleQuota', 'agentTracker.refreshQuota']) assert.ok(commands.includes(command), `${command} is registered`);
    const userData = process.env.AGENT_TRACKER_TEST_USER_DATA!;
    const databasePath = join(userData, 'User', 'globalStorage', 'agent-tracker.agent-tracker', 'agent-tracker.sqlite');
    await until(() => existsSync(databasePath), 'schema initialization');
    database = new DatabaseSync(databasePath, { readOnly: true });
    const countFiles = (): number => (database!.prepare('SELECT count(*) n FROM manifest').get() as { n: number }).n;
    await until(() => Boolean(database!.prepare("SELECT 1 FROM sqlite_master WHERE name='manifest'").get()), 'schema creation');
    assert.equal(countFiles(), 0, 'activation does not scan');
    assert.equal(scanCount, 0);
    await vscode.commands.executeCommand('agentTracker.refreshQuota');
    assert.equal(countFiles(), 0, 'combined quota refresh does not scan');
    assert.equal(scanCount, 0, 'combined quota refresh never invokes summary.refresh');
    for (const theme of [{ name: 'Default Dark Modern', css: 'vscode-dark' }, { name: 'Default Light Modern', css: 'vscode-light' }]) {
      expectedTheme = theme.css;
      expectTimezoneWarning = theme.css === 'vscode-dark';
      managedProviders.clear(); detailModes.clear();
      const scansBefore = scanCount;
      const filesBefore = countFiles();
      const refreshBefore = refreshClicks;
      const usageBefore = usageClicks;
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await vscode.workspace.getConfiguration('agentTracker').update('usage.timezone', expectTimezoneWarning ? 'Not/A_Timezone' : 'Asia/Seoul', vscode.ConfigurationTarget.Global);
      await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme.name, vscode.ConfigurationTarget.Global);
      await new Promise(resolve => setTimeout(resolve, 500));
      const completed = new Promise<void>((resolveReport, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Webview smoke timed out (${theme.css})`)), 30_000);
        let quotaPassed = false;
        onReport = message => {
          try {
            assert.ok(message.ok, message.detail);
            assert.equal(message.theme, theme.css, 'the active theme is tested');
            if (message.stage === 'quota') {
              assert.equal(scanCount, scansBefore, 'quota view and refresh do not invoke summary.refresh');
              assert.equal(countFiles(), filesBefore, 'quota refresh leaves the summary manifest unchanged');
              assert.equal(refreshClicks, refreshBefore + 1, 'quota header refresh is delivered once');
              assert.deepEqual([...managedProviders].sort(), ['claude', 'codex'], 'both management arrows use allowlisted providers');
              assert.deepEqual([...detailModes].sort(), ['compact', 'detailed'], 'both detail actions reach the host');
              quotaPassed = true; outcomes.push(message.detail);
            } else {
              assert.ok(quotaPassed, 'quota checks run before the statistics footer');
              assert.equal(usageClicks, usageBefore + 1, 'statistics footer is delivered once');
              assert.equal(scanCount, scansBefore + 1, 'only opening statistics scans; filters and tabs reuse cached summaries');
              assert.equal(countFiles(), 1, 'statistics scans the fixture');
              clearTimeout(timeout); outcomes.push(message.detail); resolveReport();
            }
          } catch (error) { clearTimeout(timeout); reject(error); }
        };
      });
      await vscode.commands.executeCommand('agentTracker.toggleQuota');
      await completed;
      onReport = undefined;
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
    const reportDirectory = join(extensionRoot, 'test-results');
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(join(reportDirectory, 'vscode-smoke.json'), JSON.stringify({ version: vscode.version, node: process.versions.node, passed: true, outcomes }, null, 2));
    console.log('Agent Tracker real VS Code smoke passed:', outcomes.join('; '));
  } finally {
    onReport = undefined;
    database?.close();
    htmlModule.dashboardHtml = originalHtml;
    protocol.parseDashboardMessage = originalParser;
    quotaModule.quotaHtml = originalQuotaHtml;
    quotaModule.parseQuotaMessage = originalQuotaParser;
    summaryModule.SummaryClient.prototype.refresh = originalRefresh;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.action.closePanel');
  }
}

async function until(test: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timed out waiting for ${label}`);
}
