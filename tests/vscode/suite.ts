import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';

interface SmokeReport { type: 'smoke-report'; ok: boolean; detail: string; stage: 'usage'; theme: string }

/** Runs in a real Extension Development Host; the ordinary node:test suite skips this file. */
export async function run(): Promise<void> {
  const extensionRoot = resolve(__dirname, '../../..');
  const extension = vscode.extensions.getExtension('agent-tracker.agent-tracker');
  assert.ok(extension, 'Extension is discoverable by VS Code');
  const htmlModule = require(join(extensionRoot, 'dist/src/ui/html')) as typeof import('../../src/ui/html');
  const protocol = require(join(extensionRoot, 'dist/src/ui/presentation')) as typeof import('../../src/ui/presentation');
  const tooltipModule = require(join(extensionRoot, 'dist/src/ui/quotaTooltip')) as typeof import('../../src/ui/quotaTooltip');
  const summaryModule = require(join(extensionRoot, 'dist/src/summary/client')) as typeof import('../../src/summary/client');
  const originalHtml = htmlModule.dashboardHtml;
  const originalDiagnosticsHtml = htmlModule.diagnosticsHtml;
  const originalColorHtml = htmlModule.colorSettingsHtml;
  const colorModule = require(join(extensionRoot,'dist/src/ui/colors')) as typeof import('../../src/ui/colors');
  const originalColorParser = colorModule.parseColorSettingsMessage;
  const statusModule = require(join(extensionRoot,'dist/src/ui/statusBar')) as typeof import('../../src/ui/statusBar');
  const originalStatusUpdate = statusModule.QuotaStatusBar.prototype.update;
  let statusColors: (string | vscode.ThemeColor | undefined)[] = [];
  const observedColors = new Set<string>();
  statusModule.QuotaStatusBar.prototype.update = function(...args) {
    originalStatusUpdate.apply(this,args);
    const items=this as unknown as {quota:vscode.StatusBarItem;refresh:vscode.StatusBarItem};
    statusColors=[items.quota.color,items.refresh.color];
    for (const color of statusColors) observedColors.add(typeof color==='string' ? color : '<automatic>');
  };
  const originalParser = protocol.parseDashboardMessage;
  const originalTooltip = tooltipModule.createQuotaTooltip;
  let currentTooltip: vscode.MarkdownString | undefined;
  const originalRefresh = summaryModule.SummaryClient.prototype.refresh;
  let onReport: ((message: SmokeReport) => void) | undefined;
  let expectedTheme = 'vscode-dark';
  let expectTimezoneWarning = false;
  let scanCount = 0;
  const isReport = (raw: unknown): raw is SmokeReport => Boolean(raw && typeof raw === 'object' && (raw as { type?: string }).type === 'smoke-report');
  protocol.parseDashboardMessage = (raw: unknown) => {
    if (isReport(raw)) { onReport?.(raw); return null; }
    return originalParser(raw);
  };
  colorModule.parseColorSettingsMessage = (raw: unknown) => {
    if (isReport(raw)) {onReport?.(raw);return null;}
    return originalColorParser(raw);
  };
  tooltipModule.createQuotaTooltip = (...args) => {
    currentTooltip = originalTooltip(...args);
    return currentTooltip;
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
  htmlModule.colorSettingsHtml = (...args: Parameters<typeof originalColorHtml>) => {
    const driver = `(() => {
      let phase='initial';
      const $=id=>document.getElementById(id);
      const check=(condition,message)=>{if(!condition)throw new Error(message);};
      const report=(ok,detail)=>window.dispatchEvent(new CustomEvent('tracker-smoke-report',{detail:{type:'smoke-report',stage:'usage',theme:${JSON.stringify(expectedTheme)},ok,detail}}));
      const apply=()=> $('color-settings').requestSubmit();
      const select=mode=>{$('color-mode').value=mode;$('color-mode').dispatchEvent(new Event('change'));};
      window.addEventListener('error',event=>report(false,event.message));
      window.addEventListener('message',event=>{
        try {
          const message=event.data;
          if (phase==='initial' && message.type==='state') {
            check(document.body.classList.contains(${JSON.stringify(expectedTheme)}),'color picker follows active theme');
            check($('color-picker').type==='color','clickable native color swatch is available');
            const themeColor=getComputedStyle(document.documentElement).getPropertyValue('--vscode-statusBar-noFolderForeground').trim();
            const probe=document.createElement('span');probe.style.color=themeColor;document.body.append(probe);
            check(getComputedStyle($('color-preview')).color===getComputedStyle(probe).color,'automatic preview matches native status bar theme color');probe.remove();
            $('color-hex').value='#abcd';$('color-hex').dispatchEvent(new Event('input'));
            check($('color-picker').value==='#aabbcc' && $('color-opacity').value==='221','short HEX and alpha update the swatch');
            check($('color-preview').style.getPropertyValue('--tracker-status-color')==='#aabbccdd','custom preview retains opacity');
            phase='hex';apply();
          } else if (message.type==='saved' && phase==='hex') {
            check($('color-hex').value==='#aabbccdd','HEX persists through extension settings');
            $('color-picker').value='#123456';$('color-picker').dispatchEvent(new Event('input'));
            $('color-opacity').value='128';$('color-opacity').dispatchEvent(new Event('input'));
            check($('color-hex').value==='#12345680','native swatch and opacity generate HEX');phase='swatch';apply();
          } else if (message.type==='saved' && phase==='swatch') {
            phase='white';select('white');check(getComputedStyle($('color-preview')).color==='rgb(255, 255, 255)','white is visible in preview');apply();
          } else if (message.type==='saved' && phase==='white') {
            phase='black';select('black');check(getComputedStyle($('color-preview')).color==='rgb(0, 0, 0)','black is visible in preview');apply();
          } else if (message.type==='saved' && phase==='black') {
            phase='automatic';select('automatic');check(!$('color-preview').style.getPropertyValue('--tracker-status-color'),'automatic releases custom foreground');apply();
          } else if (message.type==='saved' && phase==='automatic') {
            phase='complete';report(true,'theme automatic, white, black, HEX, clickable swatch and alpha settings in '+${JSON.stringify(expectedTheme)});
          } else if (message.type==='error') {phase='failed';report(false,message.message);}
        } catch(error) {phase='failed';report(false,error.message);}
      });
    })();`;
    return inlineScript(originalColorHtml(...args),'color-settings.js',args[3],driver);
  };
  htmlModule.dashboardHtml = (...args: Parameters<typeof originalHtml>) => {
    const driver = `
      (() => {
        let phase = 'usage';
        let receivedDiagnostics = false;
        const chartGroups = ['project', 'session', 'all', 'month'];
        const submitGroup = group => { document.getElementById('group').value = group; document.getElementById('usage-filters').requestSubmit(); };
        const report = (ok, detail) => window.dispatchEvent(new CustomEvent('tracker-smoke-report', {detail:{type:'smoke-report',stage:'usage',theme:${JSON.stringify(expectedTheme)},ok,detail}}));
        const check = (condition, detail) => { if (!condition) throw new Error(detail); };
        const checkSegmentHover = () => {
          const segments = [...document.querySelectorAll('#usage-chart .chart-segment')];
          for (const [index, label] of ['Input: 50 토큰', 'Output: 50 토큰', 'Cache Write: 20 토큰', 'Cache Read: 30 토큰'].entries()) {
            const segment = segments[index];
            segment.scrollIntoView({block:'center',inline:'nearest'});
            const bounds = segment.getBoundingClientRect();
            check(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === segment,'colored component remains the pointer target');
            check(segment.querySelector('title').textContent.endsWith(label),'native tooltip displays the component count '+label);
            segment.dispatchEvent(new MouseEvent('mouseenter'));
            check(document.getElementById('chart-detail').textContent.endsWith(label),'hover detail displays the component count '+label);
            segment.dispatchEvent(new MouseEvent('mouseleave'));
            check(document.getElementById('chart-detail').textContent.includes('Input 50 / Output 50 / Cache Write 20 / Cache Read 30'),'leaving a component restores the bar breakdown');
          }
        };
        window.addEventListener('error', event => report(false,event.message));
        window.addEventListener('message', event => {
          try {
            const message = event.data;
            if (message.type === 'diagnostics') receivedDiagnostics = true;
            if (message.type === 'state') {
              check(document.body.classList.contains(${JSON.stringify(expectedTheme)}),'VS Code theme class is applied to statistics');
              check(!document.querySelector('[data-tab]'),'statistics has no tab controls');
              const diagnosticLink = document.getElementById('open-diagnostics');
              check(diagnosticLink.tagName === 'A' && diagnosticLink.textContent === '데이터 확인' && document.querySelector('main').lastElementChild.contains(diagnosticLink),'statistics ends with a data check hyperlink');
              check(!document.getElementById('diagnostics') && !document.getElementById('diagnostic-files'),'diagnostic logs are absent from the statistics page');
              check(!document.getElementById('quota') && !document.querySelector('[data-tab="quota"]') && !document.getElementById('refresh-usage'),'quota and summary refresh controls are absent from statistics');
              check(document.getElementById('configuration-warning').hidden === ${JSON.stringify(!expectTimezoneWarning)},'invalid timezone warning is visible and clears after correction');
            } else if (phase === 'usage' && message.type === 'usage' && message.result.rows.length) {
              check(message.result.rows[0].total_tokens === 150,'worker usage reached Webview');
              check(document.getElementById('usage-table').textContent.includes('150'),'usage table renders total');
              check(document.getElementById('usage').hidden === false,'usage stays visible in the statistics page');
              check(message.result.chart.mode === 'calendar','calendar chart arrives from the worker');
              const marks = [...document.querySelectorAll('#usage-chart .chart-segment')];
              check(marks.length === 4,'total tokens render as four stacked segments');
              const fills = marks.map(mark => getComputedStyle(mark).fill);
              check(new Set(fills).size === 4 && fills.every(fill => fill !== 'none'),'four token colors resolve in the active theme');
              checkSegmentHover();
              document.querySelector('#usage-chart .chart-bar').focus();
              check(document.getElementById('chart-detail').textContent.includes('Input 50 / Output 50 / Cache Write 20 / Cache Read 30'),'keyboard focus exposes token breakdown');
              phase = 'chart-requests'; document.getElementById('chart-metric').value = 'requests';
              document.getElementById('chart-metric').dispatchEvent(new Event('change'));
            } else if (phase === 'chart-requests' && message.type === 'usage' && message.result.chart.metric === 'requests') {
              check(document.querySelectorAll('#usage-chart .chart-segment').length === 1,'request metric displays one measure');
              check(document.getElementById('chart-legend').children.length === 0,'non-token metric clears token legend');
              phase = 'chart-duration'; document.getElementById('chart-metric').value = 'averageDuration';
              document.getElementById('chart-metric').dispatchEvent(new Event('change'));
            } else if (phase === 'chart-duration' && message.type === 'usage' && message.result.chart.metric === 'averageDuration') {
              check(document.getElementById('chart-detail').textContent.includes('시간 표본 1개'),'duration averages display their sample count');
              phase = 'chart-groups'; document.getElementById('chart-metric').value = 'tokens';
              submitGroup(chartGroups[0]);
            } else if (phase === 'chart-groups' && message.type === 'usage' && message.result.groupBy === chartGroups[0]) {
              check(document.querySelectorAll('#usage-chart .chart-segment').length === 4,'stacked chart survives grouping '+chartGroups[0]);
              check(document.getElementById('chart-title').textContent === '총 토큰','grouped chart keeps its token metric');
              checkSegmentHover();
              chartGroups.shift();
              if (chartGroups.length) { submitGroup(chartGroups[0]); return; }
              phase = 'project-names'; document.getElementById('project-name').click();
            } else if (phase === 'project-names' && message.type === 'names' && message.kind === 'project') {
              check(!message.error && message.result.total === 1,'full project names arrive from the worker');
              const list = document.getElementById('project-options');
              check(!list.hidden && getComputedStyle(list).overflowY === 'auto' && getComputedStyle(list).maxHeight === '300px','name popup has a bounded scroll area');
              check(document.querySelectorAll('#project-list .name-option').length === 2,'project list includes all and each stored project');
              phase = 'project-selected'; document.querySelectorAll('#project-list .name-option')[1].click();
            } else if (phase === 'project-selected' && message.type === 'usage') {
              check(document.getElementById('project-name').textContent === 'project','project choice updates the filter');
              check(document.getElementById('project-options').hidden,'project choice closes the popup');
              phase = 'session-names'; document.getElementById('session-name').click();
            } else if (phase === 'session-names' && message.type === 'names' && message.kind === 'session') {
              check(!message.error && message.result.total === 1,'project session names arrive from the worker');
              const option = document.querySelectorAll('#session-list .name-option')[1];
              check(option.textContent.includes('통계 화면 검증') && option.textContent.includes('Claude') && option.textContent.includes('project'),'session choice shows title and disambiguating context');
              check(option.title.includes('ui-session'),'session tooltip keeps exact identity');
              phase = 'turn'; document.getElementById('group').value = 'turn'; option.click();
            } else if (phase === 'turn' && message.type === 'usage' && message.result.groupBy === 'turn') {
              check(message.result.rows.length === 1 && message.result.rows[0].root_turn_id === 'ui-turn','request group and session filter are applied');
              check(document.getElementById('usage-table').textContent.includes('ui-turn'),'request identity is rendered');
              check(document.getElementById('usage-table').textContent.includes('통계 화면 검증'),'session title is rendered');
              check(message.result.chart.mode === 'turn' && document.querySelectorAll('#usage-chart .chart-segment').length === 4,'request chart uses token composition');
              checkSegmentHover();
              check(document.getElementById('chart-metric').querySelector('[value="requests"]').disabled,'request chart disables aggregate metrics');
              check(document.getElementById('session-name').textContent === '통계 화면 검증' && document.getElementById('session-options').hidden,'session selection applies immediately and closes the popup');
              phase = 'costs-on'; document.getElementById('show-costs').click();
            } else if (phase === 'costs-on' && message.type === 'usage') {
              check(document.getElementById('usage-table').textContent.includes('API 추정 비용 (USD)'),'cost switch adds the cost column');
              check(!document.getElementById('billing-control').hidden && !document.getElementById('cost-note').hidden,'selected session exposes billing and estimate guidance');
              phase = 'models'; document.getElementById('cumulative-model').click();
            } else if (phase === 'models' && message.type === 'usage' && message.result.cumulative.by === 'model') {
              check(message.result.cumulative.rows[0].model === 'claude-sonnet-4-6' && message.result.cumulative.rows[0].total_tokens === 150,'model cumulative retains all tokens');
              check(document.getElementById('cumulative-table').textContent.includes('claude-sonnet-4-6'),'model name renders in the cumulative table');
              check(document.getElementById('cumulative-model').getAttribute('aria-pressed') === 'true','model selection exposes pressed state');
              phase = 'billing-api'; document.getElementById('billing-mode').value = 'api';
              document.getElementById('billing-mode').dispatchEvent(new Event('change'));
            } else if (phase === 'billing-api' && message.type === 'usage') {
              check(message.result.billing === 'api' && Math.abs(message.result.rows[0].cost_usd - 0.000984) < 1e-12,'API classification saves estimated costs');
              check(document.getElementById('cumulative-table').textContent.includes('$0.000984'),'model cumulative shows saved API cost');
              phase = 'billing-subscription'; document.getElementById('billing-mode').value = 'subscription';
              document.getElementById('billing-mode').dispatchEvent(new Event('change'));
            } else if (phase === 'billing-subscription' && message.type === 'usage') {
              check(message.result.rows[0].cost_usd === 0 && document.getElementById('usage-table').textContent.includes('0원 (구독)'),'subscription usage displays zero cost');
              phase = 'costs-off'; document.getElementById('show-costs').click();
            } else if (phase === 'costs-off' && message.type === 'usage') {
              check(!document.getElementById('usage-table').textContent.includes('API 추정 비용'),'cost switch removes cost columns');
              check(document.getElementById('billing-control').hidden,'cost switch hides billing controls');
              phase = 'empty'; document.getElementById('from-day').value = '2026-10-04';
              document.getElementById('usage-filters').requestSubmit();
            } else if (phase === 'empty' && message.type === 'usage') {
              check(message.result.total === 0,'date filter excludes earlier requests');
              check(document.querySelector('#usage-table .empty'),'empty state renders');
              check(document.querySelector('#usage-chart .empty') && !document.querySelector('#usage-chart .chart-segment'),'empty query clears the chart');
              check(document.getElementById('previous').disabled && document.getElementById('next').disabled,'empty pagination is disabled');
              phase = 'empty-names'; document.getElementById('session-name').click();
            } else if (phase === 'empty-names' && message.type === 'names' && message.kind === 'session') {
              check(message.result.total === 1 && document.querySelectorAll('#session-list .name-option').length === 2,'names remain available outside the date filter');
              window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
              check(document.getElementById('session-options').hidden && document.activeElement === document.getElementById('session-name'),'Escape closes the list and returns keyboard focus');
              phase = 'reset'; document.getElementById('reset-filters').click();
            } else if (phase === 'reset' && message.type === 'usage') {
              check(message.result.groupBy === 'day' && message.result.total === 1,'reset restores daily query results');
              for (const id of ['provider','from-day','to-day']) check(document.getElementById(id).value === '','reset clears '+id);
              check(document.getElementById('project-name').textContent === '전체 프로젝트' && document.getElementById('session-name').textContent === '전체 세션','reset clears selected identities');
              check(document.getElementById('chart-metric').value === 'tokens' && message.result.cumulative.by === 'provider','reset restores metric and provider cumulative');
              check(!receivedDiagnostics,'statistics does not receive diagnostic logs');
              const link = document.getElementById('open-diagnostics');
              link.focus(); check(document.activeElement === link,'diagnostic hyperlink accepts keyboard focus');
              phase = 'complete'; link.click();
            } else if (message.type === 'error') { phase='failed'; report(false,message.message); }
          } catch(error) { phase='failed'; report(false,error.message); }
        });
      })();`;
    return inlineScript(originalHtml(...args), 'dashboard.js', args[3], driver);
  };
  htmlModule.diagnosticsHtml = (...args: Parameters<typeof originalDiagnosticsHtml>) => {
    const driver = `
      (() => {
        let phase = 'initial';
        const report = (ok, detail) => window.dispatchEvent(new CustomEvent('tracker-smoke-report', {detail:{type:'smoke-report',stage:'usage',theme:${JSON.stringify(expectedTheme)},ok,detail}}));
        const check = (condition, detail) => { if (!condition) throw new Error(detail); };
        window.addEventListener('error', event => report(false,event.message));
        window.addEventListener('message', event => {
          try {
            const message = event.data;
            if (message.type === 'state') {
              check(document.body.classList.contains(${JSON.stringify(expectedTheme)}),'VS Code theme is applied to the separate diagnostic webview');
              check(document.title === 'Agent Tracker 데이터 확인' && document.querySelector('h1').textContent === '데이터 확인' && !document.getElementById('usage'),'data check is a dedicated page');
              check(document.getElementById('refresh-diagnostics').title.includes('원본을 재검증하지 않고'),'diagnostics explains that reload only reads stored results');
              check(document.getElementById('configuration-warning').hidden === ${JSON.stringify(!expectTimezoneWarning)},'diagnostic timezone warning follows settings');
            } else if (phase === 'initial' && message.type === 'diagnostics') {
              check(message.result.counts.files === 1,'diagnostics returns fixture manifest');
              check(document.getElementById('diagnostic-files').textContent.includes('session.jsonl'),'separate webview renders the source log');
              check(document.getElementById('diagnostic-summaries'),'separate webview retains the request warnings table');
              phase = 'reload'; document.getElementById('refresh-diagnostics').click();
            } else if (phase === 'reload' && message.type === 'diagnostics') {
              check(message.offset === 0,'diagnostic reload reads the current page');
              phase = 'next'; document.getElementById('diagnostic-next').disabled = false;
              document.getElementById('diagnostic-next').click();
            } else if (phase === 'next' && message.type === 'diagnostics') {
              check(message.offset === 100,'diagnostics next page requests the next offset');
              phase = 'reload-next'; document.getElementById('refresh-diagnostics').click();
            } else if (phase === 'reload-next' && message.type === 'diagnostics') {
              check(message.offset === 100,'diagnostics reload preserves the current page');
              phase = 'previous'; document.getElementById('diagnostic-previous').click();
            } else if (phase === 'previous' && message.type === 'diagnostics') {
              check(message.offset === 0 && document.getElementById('diagnostic-previous').disabled,'diagnostics previous page updates rows and controls together');
              check(document.getElementById('diagnostic-page').textContent.startsWith('1번째'),'diagnostics label matches returned rows');
              phase = 'complete'; report(true,'statistics charts, model/provider cumulative, cost on/off, API and zero subscription costs, reset and name filters → separate diagnostic webview in '+${JSON.stringify(expectedTheme)});
            } else if (message.type === 'error') { phase = 'failed'; report(false,message.message); }
          } catch(error) { phase = 'failed'; report(false,error.message); }
        });
      })();`;
    return inlineScript(originalDiagnosticsHtml(...args), 'diagnostics.js', args[3], driver);
  };
  const outcomes: string[] = [];
  let database: DatabaseSync | undefined;
  try {
    await extension.activate();
    assert.ok(extension.isActive);
    const commands = await vscode.commands.getCommands(true);
    for (const command of ['agentTracker.openUsage', 'agentTracker.toggleQuotaTooltip', 'agentTracker.setStatusBarDetail', 'agentTracker.openSettings', 'agentTracker.configureStatusColor', 'agentTracker.clearUsageData', 'agentTracker.refreshQuota']) assert.ok(commands.includes(command), `${command} is registered`);
    for (const command of ['agentTracker.manageProvider', 'agentTracker.refreshClaude', 'agentTracker.refreshCodex']) assert.ok(!commands.includes(command));
    assert.ok(!commands.includes('agentTracker.toggleQuota'), 'the old panel toggle is removed');
    assert.ok(!extension.packageJSON.contributes.viewsContainers, 'no quota panel is contributed');
    assert.ok(currentTooltip instanceof vscode.MarkdownString, 'real status bar receives a rich hover');
    const fixture: import('../../src/quota/types').QuotaState = {
      provider: 'codex', status: 'ready', refreshing: false, error: null, lastSuccessAt: 0, nextAllowedAt: 0,
      snapshot: { provider: 'codex', fetchedAt: 0, rateLimitResetCredits: { availableCount: 2, nextExpiresAt: (17 * 24 + 8) * 3_600_000 }, windows: [
        { id: 'primary', label: '5h', usedPercent: 42, current: 42, maximum: 100, resetsAt: 90_000, windowDurationMins: 300 },
        { id: 'weekly', label: '7d', usedPercent: 75, current: 75, maximum: 100, resetsAt: 3_600_000, windowDurationMins: 10080 },
        { id: 'extra', label: '| [run](command:evil)\n<img src=x>', usedPercent: NaN, current: 0, maximum: 100, resetsAt: null, windowDurationMins: null },
      ] },
    };
    const card = originalTooltip([fixture], { percentage: 'remaining', detail: 'compact' }, 0);
    assert.equal(card.supportThemeIcons, true);
    assert.equal(card.supportHtml, true, 'controlled color spans accompany SVG usage meters');
    assert.ok(typeof card.isTrusted === 'object' && !card.isTrusted.enabledCommands.includes('evil'));
    assert.match(card.value, /58%/);
    assert.match(card.value, /25%/);
    assert.match(card.value, /2분 후/);
    assert.match(card.value, /1시간 0분 후/);
    assert.match(card.value, /2m 후 초기화/);
    assert.match(card.value, /rate-limit 재설정 2회 사용 가능/);
    assert.match(card.value, /다음 항목이 17d 8h 후 만료됨/);
    assert.doesNotMatch(card.value, /\| 기간 \|/);
    assert.doesNotMatch(card.value, /\]\(command:evil\)/, 'provider labels cannot introduce command links');
    assert.doesNotMatch(card.value, /<img src=x>/, 'provider HTML remains text');
    const advanced = originalTooltip([{ ...fixture, status: 'stale', refreshing: true }], { percentage: 'used', detail: 'detailed' }, 61_000);
    assert.match(advanced.value, /42%/);
    assert.match(advanced.value, /1분 후/);
    assert.match(advanced.value, /마지막 조회 값/);
    assert.match(advanced.value, /조회 중/);
    assert.doesNotMatch(advanced.value, /\]\(command:agentTracker.refreshQuota\)/, 'busy refresh is not a clickable action');
    const unavailable = originalTooltip([{ ...fixture, snapshot: null, status: 'unavailable', error: { code: 'authentication', message: 'CLI에서 로그인하세요.' } }], { percentage: 'used', detail: 'detailed' }, 0);
    assert.match(unavailable.value, /조회불가/);
    assert.match(unavailable.value.replace(/&nbsp;/g, ' '), /CLI에서 로그인하세요/);
    outcomes.push('native Markdown hover: all windows, remaining percentages, reset countdown, stale/loading/error states, escaped labels');
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
      const scansBefore: number = scanCount;
      const filesBefore = countFiles();
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await vscode.workspace.getConfiguration('agentTracker').update('usage.timezone', expectTimezoneWarning ? 'Not/A_Timezone' : 'Asia/Seoul', vscode.ConfigurationTarget.Global);
      await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme.name, vscode.ConfigurationTarget.Global);
      await new Promise(resolve => setTimeout(resolve, 500));
      const completed = new Promise<void>((resolveReport, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Webview smoke timed out (${theme.css})`)), 30_000);
        onReport = message => {
          try {
            assert.ok(message.ok, message.detail);
            assert.equal(message.theme, theme.css, 'the active theme is tested');
            assert.equal(scanCount, scansBefore + 1, 'only opening statistics scans; filters and diagnostic controls reuse cached summaries');
            assert.equal(countFiles(), 1, 'statistics scans the fixture');
            clearTimeout(timeout); outcomes.push(message.detail); resolveReport();
          } catch (error) { clearTimeout(timeout); reject(error); }
        };
      });
      for (const detail of ['compact', 'detailed']) {
        await vscode.commands.executeCommand('agentTracker.setStatusBarDetail', detail);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.ok(currentTooltip!.value.includes(detail === 'compact' ? '**압축**' : '**상세**'));
      }
      await vscode.commands.executeCommand('agentTracker.refreshQuota');
      assert.equal(scanCount, scansBefore, 'quota refresh and display changes never scan summaries');
      assert.equal(countFiles(), filesBefore, 'quota controls leave the summary manifest unchanged');
      const usageLink = currentTooltip!.value.match(/\]\(command:(agentTracker\.openUsage)\)/);
      assert.ok(usageLink, 'hover exposes a statistics command link');
      assert.ok(typeof currentTooltip!.isTrusted === 'object' && currentTooltip!.isTrusted.enabledCommands.includes(usageLink[1]));
      await vscode.commands.executeCommand(usageLink[1]);
      await completed;
      onReport = undefined;
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
    for (const theme of [{name:'Dark 2026',css:'vscode-dark'}, {name:'Light 2026',css:'vscode-light'},
      {name:'Dark Modern',css:'vscode-dark'}, {name:'Default High Contrast',css:'vscode-high-contrast'}]) {
      expectedTheme=theme.css;
      const before:number=scanCount;
      await vscode.workspace.getConfiguration('workbench').update('colorTheme',theme.name,vscode.ConfigurationTarget.Global);
      await vscode.workspace.getConfiguration('agentTracker').update('display.colorMode','automatic',vscode.ConfigurationTarget.Global);
      await vscode.workspace.getConfiguration('agentTracker').update('display.customColor','#ffffff',vscode.ConfigurationTarget.Global);
      await new Promise(resolve=>setTimeout(resolve,500));
      const completed=new Promise<void>((resolveReport,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('Color settings timed out: '+theme.name)),30_000);
        onReport=message=>{
          clearTimeout(timeout);
          if (!message.ok) {reject(new Error(message.detail));return;}
          outcomes.push(theme.name+': '+message.detail);resolveReport();
        };
      });
      await vscode.commands.executeCommand('agentTracker.configureStatusColor');await completed;onReport=undefined;
      await until(()=>statusColors.length===2 && statusColors.every(color=>color===undefined),'automatic restores both status item colors');
      assert.equal(vscode.workspace.getConfiguration('agentTracker').get('display.customColor'),'#12345680','native picker and opacity persist');
      assert.equal(scanCount,before,'color settings never scan transcripts');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
    for (const color of ['#ffffff','#000000','#aabbccdd','#12345680','<automatic>']) assert.ok(observedColors.has(color),'live status items receive '+color);
    const scansBeforeSettings = scanCount;
    const config = vscode.workspace.getConfiguration('agentTracker');
    const sourcePath = join(process.env.AGENT_TRACKER_TEST_ROOT!, 'claude', 'projects', 'session.jsonl');
    const originalSource = readFileSync(sourcePath, 'utf8');
    await config.update('usage.enabled', false, vscode.ConfigurationTarget.Global);
    await until(() => Boolean(currentTooltip?.value.includes('사용량 통계 (꺼짐)')), 'disabled statistics card');
    await vscode.commands.executeCommand('agentTracker.openUsage');
    assert.equal(scanCount, scansBeforeSettings, 'disabled statistics cannot start a scan');
    assert.equal(countFiles(), 1, 'disabling statistics preserves cached data');
    const settingsLink = currentTooltip!.value.match(/\]\(command:(agentTracker\.openSettings)\)/);
    assert.ok(settingsLink, 'settings remains available with statistics off');
    await vscode.commands.executeCommand(settingsLink[1]);
    await vscode.commands.executeCommand('agentTracker.clearUsageData');
    assert.equal(countFiles(), 0, 'the command deletes manifest records');
    assert.equal((database.prepare('SELECT count(*) n FROM turn_summary').get() as {n: number}).n, 0);
    assert.equal(readFileSync(sourcePath, 'utf8'), originalSource, 'original transcript survives deletion');
    assert.equal(scanCount, scansBeforeSettings, 'deletion does not trigger a rebuild');
    await config.update('claude.enabled', false, vscode.ConfigurationTarget.Global);
    await until(() => Boolean(currentTooltip && !currentTooltip.value.includes('agent-tracker-claude')), 'disabled provider card');
    assert.match(currentTooltip!.value, /agent-tracker-codex/);
    const properties = extension.packageJSON.contributes.configuration.properties;
    assert.match(properties['agentTracker.usage.enabled'].markdownDescription, /command:agentTracker.clearUsageData/);
    assert.deepEqual(properties['agentTracker.quota.refreshPolicy'].enum, ['automatic', 'manual']);
    outcomes.push('settings navigation, statistics off, provider selection and derived-data deletion preserve original transcripts');
    const reportDirectory = join(extensionRoot, 'tests', 'results');
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(join(reportDirectory, 'vscode-smoke.json'), JSON.stringify({ version: vscode.version, node: process.versions.node, passed: true, outcomes }, null, 2));
    console.log('Agent Tracker real VS Code smoke passed:', outcomes.join('; '));
  } catch (error) {
    const reportDirectory = join(extensionRoot, 'tests', 'results');
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(join(reportDirectory, 'vscode-smoke.json'), JSON.stringify({ passed: false, error: error instanceof Error ? error.stack : String(error), outcomes }, null, 2));
    throw error;
  } finally {
    onReport = undefined;
    database?.close();
    htmlModule.dashboardHtml = originalHtml;
    htmlModule.diagnosticsHtml = originalDiagnosticsHtml;
    htmlModule.colorSettingsHtml = originalColorHtml;
    colorModule.parseColorSettingsMessage = originalColorParser;
    statusModule.QuotaStatusBar.prototype.update = originalStatusUpdate;
    protocol.parseDashboardMessage = originalParser;
    tooltipModule.createQuotaTooltip = originalTooltip;
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
