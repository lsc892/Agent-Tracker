// 격리된 VS Code에서 통계 패널을 열고 첫 데이터 표시와 최종 표시 시간을 재는 A/B 실행기다.
'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { cpus, tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { makeSnapshot } = require('./incremental-refresh.cjs');

const repo = resolve(__dirname, '../..');
const timezone = 'Asia/Seoul';
const sha = value => createHash('sha256').update(value).digest('hex');
const recentFixture = 'dashboard-ab-recent';
const warmups = 3;
const trials = 10;
const dayMs = 86_400_000;

async function fingerprint(directory) {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
  return sha(JSON.stringify(await Promise.all(files.map(async file => [file.slice(directory.length + 1), sha(await fs.readFile(file))]))));
}

async function buildVariants(workspace, revision) {
  const before = join(workspace, 'before'), after = join(workspace, 'after');
  const paths = ['src', 'media', 'localization', 'package.json', 'tsconfig.json'];
  await fs.mkdir(before);
  await fs.mkdir(after);
  const archive = join(workspace, 'baseline.tar');
  execFileSync('git', ['archive', '--format=tar', '-o', archive, revision, ...paths], { cwd: repo });
  execFileSync('tar', ['-xf', archive, '-C', before]);
  for (const path of paths) await fs.cp(join(repo, path), join(after, path), { recursive: true });
  const source = {};
  for (const product of [before, after]) {
    await fs.symlink(join(repo, 'node_modules'), join(product, 'node_modules'), 'junction');
    execFileSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', join(product, 'tsconfig.json')], { stdio: 'inherit' });
    await fs.copyFile(join(repo, 'node_modules/i18next/dist/umd/i18next.min.js'), join(product, 'media/i18next.js'));
    await fs.copyFile(join(repo, 'node_modules/i18next/dist/cjs/i18next.js'), join(product, 'dist/src/localization/i18next.cjs'));
    source[basename(product)] = {
      extension: await fingerprint(join(product, 'src')),
      webview: await fingerprint(join(product, 'media')),
      build: await fingerprint(join(product, 'dist/src')),
    };
  }
  return { products: { before, after }, source };
}

function request(sessionId, promptId, timestamp) {
  const project = '/benchmark/project-' + sessionId.slice(-1);
  return [
    { type: 'user', sessionId, promptId, timestamp, cwd: project, message: { content: 'Synthetic benchmark request' } },
    { type: 'assistant', promptId, timestamp, requestId: 'request-' + promptId, message: {
      id: 'response-' + promptId, model: 'claude-sonnet-4-6', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 },
    } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
}

async function dataset(workspace, product, name, requests, now) {
  const folder = join(workspace, name);
  await fs.mkdir(folder);
  const start = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  let roots, inventory, inputSha256, expected, marker;
  if (requests) {
    const path = join(folder, 'claude');
    await fs.mkdir(path);
    roots = [{ provider: 'claude', path }];
    const perFile = requests === 100 ? 10 : 20;
    const sessions = requests / perFile, recentFiles = Math.max(1, Math.ceil(sessions * .02));
    for (let index = 0; index < sessions; index++) {
      const recent = index < recentFiles, session = index === 0 ? recentFixture : 'dashboard-ab-session-' + index;
      const timestamp = recent ? start : new Date(now.getTime() - (31 + (index % 90)) * dayMs);
      const file = join(path, session + '.jsonl');
      const body = Array.from({ length: perFile }, (_, turn) => request(session, session + '-' + turn, timestamp)).join('');
      await fs.writeFile(file, body);
      await fs.utimes(file, timestamp, timestamp);
    }
    marker = join(path, recentFixture + '.jsonl');
    expected = { requests, recentRequests: recentFiles * perFile, tokens: requests * 110, recentTokens: recentFiles * perFile * 110 };
    inventory = [{ provider: 'claude', files: sessions, recentFiles, perFile }];
    inputSha256 = await fingerprint(path);
  } else {
    const snapshot = await makeSnapshot(folder, { after: product, real: true });
    ({ roots, inventory, sha256: inputSha256 } = snapshot);
    const path = join(folder, 'marker');
    await fs.mkdir(path);
    marker = join(path, recentFixture + '.jsonl');
    await fs.writeFile(marker, request(recentFixture, 'recent-seed', start));
    await fs.utimes(marker, start, start);
    roots.push({ provider: 'claude', path });
    inventory.push({ provider: 'claude', files: 1, recentFiles: 1, perFile: 1 });
  }
  return { name, folder, roots, inventory, inputSha256, expected, marker, append: request(recentFixture, 'recent-added', now) };
}

function instrumentDashboard(product, onMessage) {
  const html = require(join(product, 'dist/src/ui/html'));
  const protocol = require(join(product, 'dist/src/ui/presentation'));
  const originalHtml = html.dashboardHtml, originalParse = protocol.parseDashboardMessage;
  const script = require('node:fs').readFileSync(join(product, 'media/dashboard.js'), 'utf8')
    .replace('const vscode = acquireVsCodeApi();',
      `const vscode = acquireVsCodeApi();
      document.getElementById('date-range').value = '30';
      window.addEventListener('dashboard-ab', event => vscode.postMessage(event.detail));`);
  const driver = `(() => {
    const report = detail => window.dispatchEvent(new CustomEvent('dashboard-ab', { detail: { ...detail, type: 'dashboard-ab' } }));
    const afterFrame = value => requestAnimationFrame(() => {
      const at = performance.timeOrigin + performance.now();
      requestAnimationFrame(() => report({ ...value, at }));
    });
    document.addEventListener('DOMContentLoaded', () => afterFrame({ stage: 'shell' }), { once: true });
    let refresh;
    window.addEventListener('message', ({ data }) => {
      if (data.type === 'refreshResult') {
        refresh = data.result;
        if (refresh.failed || refresh.interrupted) report({ stage: 'failed', failed: refresh.failed, interrupted: refresh.interrupted });
      }
      if (data.type !== 'usage' && data.type !== 'previewUsage') return;
      const rows = data.result.rows;
      afterFrame({ stage: 'data', committed: data.type === 'usage' && Boolean(refresh),
        preview: data.type === 'previewUsage', rows: rows.length, requests: rows.reduce((sum, row) => sum + row.turn_count, 0),
        tokens: rows.reduce((sum, row) => sum + (row.total_tokens || 0), 0) });
    });
  })();`;
  html.dashboardHtml = (...args) => originalHtml(...args).replace(/<script nonce="[^"]+" src="[^"]*dashboard\.js"><\/script>/,
    () => `<script nonce="${args[3]}">${script}</script><script nonce="${args[3]}">${driver}</script>`);
  protocol.parseDashboardMessage = raw => {
    if (raw?.type !== 'dashboard-ab') return originalParse(raw);
    onMessage(raw);
    return null;
  };
  return () => { html.dashboardHtml = originalHtml; protocol.parseDashboardMessage = originalParse; };
}

async function measure(vscode, product, variant, input, dbPath, seed) {
  const { SummaryClient } = require(join(product, 'dist/src/summary/client'));
  const { Dashboard } = require(join(product, 'dist/src/ui/dashboard'));
  const { readConfiguration } = require(join(product, 'dist/src/configuration'));
  if (seed) await fs.copyFile(seed, dbPath);
  const summary = new SummaryClient({ dbPath, roots: input.roots, timezone });
  const settings = readConfiguration({ get: (_key, fallback) => fallback });
  settings.roots = input.roots;
  settings.usage.timezone = timezone;
  const dashboard = new Dashboard({ summary, extensionUri: vscode.Uri.file(product), settings: () => settings });
  const query = summary.query.bind(summary);
  summary.query = filter => query({ ...filter, unknownTime: 'exclude' });
  if (variant === 'cached') {
    const enter = dashboard.enter.bind(dashboard);
    dashboard.enter = async () => { dashboard.update(); await dashboard.loadUsage(); enter(); };
  }
  let started, shellMs, first;
  const sample = new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(Error('No dashboard result before timeout')), 60_000);
    dashboard.benchmarkMessage = message => {
      if (message.stage === 'shell') shellMs = message.at - started;
      if (message.stage === 'data') {
        const frame = { ms: message.at - started, requests: message.requests, tokens: message.tokens, rows: message.rows,
          source: message.preview ? 'memory' : message.committed ? 'committed' : 'cached' };
        first ??= frame;
        if (message.committed) { clearTimeout(timeout); accept({ shellMs, first, final: frame }); }
      }
      if (message.stage === 'failed') { clearTimeout(timeout); accept({ shellMs, first, failed: message.failed, interrupted: message.interrupted }); }
    };
  });
  const restore = instrumentDashboard(product, dashboard.benchmarkMessage);
  try {
    await summary.initialize();
    started = performance.timeOrigin + performance.now();
    dashboard.open();
    return await sample;
  } finally {
    dashboard.dispose();
    restore();
    await summary.dispose();
  }
}

async function prepareBaseline(product, input, bounds) {
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const dbPath = join(input.folder, 'seed.sqlite');
  const db = new SummaryDatabase(dbPath);
  try {
    const refresh = await refreshSummary(db, { dbPath, roots: input.roots, timezone });
    const rows = db.connection.prepare('SELECT started_at_ms, total_tokens FROM turn_summary').all();
    const recent = rows.filter(row => row.started_at_ms !== null && row.started_at_ms >= bounds.fromMs && row.started_at_ms < bounds.toMs);
    const tokens = values => values.reduce((sum, row) => sum + row.total_tokens, 0);
    const counts = { requests: rows.length, recentRequests: recent.length, tokens: tokens(rows), recentTokens: tokens(recent) };
    if (input.expected) assert.deepEqual(counts, input.expected);
    // Opening the statistics page once materializes the daily rollup on disk.
    db.queryUsagePage({ ...bounds, unknownTime: 'exclude', chartMetric: 'tokens' }, 'day', timezone);
    return { dbPath, counts, parserFailures: refresh.failed };
  } finally { db.close(); }
}

async function run() {
  const vscode = require('vscode');
  const config = JSON.parse(await fs.readFile(process.env.AGENT_TRACKER_DASHBOARD_AB_CONFIG, 'utf8'));
  const { products, inputs, bounds, scenarios, warmups: warm, trials: pairs } = config;
  const results = [];
  for (const input of inputs) {
    const { dbPath, counts, parserFailures } = await prepareBaseline(products.after, input, bounds);
    const datasetResult = { name: input.name, inputSha256: input.inputSha256, inventory: input.inventory, counts, parserFailures, cold: [], warm: [] };
    for (const scenario of scenarios) {
      if (scenario === 'warm') {
        await fs.appendFile(input.marker, input.append);
        const written = new Date(Date.now() + 100);
        await fs.utimes(input.marker, written, written);
      }
      for (let index = -warm; index < pairs; index++) {
        const variants = index % 2 === 0 ? ['before', 'after'] : ['after', 'before'];
        if (scenario === 'warm') variants.push('cached');
        const pair = { order: variants };
        for (const variant of variants) {
          const file = join(input.folder, `${scenario}-${index}-${variant}.sqlite`);
          const result = await measure(vscode, products[variant === 'after' ? 'after' : 'before'], variant, input, file, scenario === 'warm' ? dbPath : undefined);
          if (result.final) {
            const expected = scenario === 'cold' ? counts.recentRequests : counts.recentRequests + 1;
            const tokens = scenario === 'cold' ? counts.recentTokens : counts.recentTokens + 110;
            assert.equal(result.final.requests, expected);
            assert.equal(result.final.tokens, tokens);
            if (variant === 'cached' && result.first.source === 'cached') {
              assert.equal(result.first.requests, counts.recentRequests);
              assert.equal(result.first.tokens, counts.recentTokens);
            }
            if (scenario === 'warm' && variant === 'after') assert.equal(result.first.tokens, tokens);
          }
          pair[variant] = result;
        }
        if (index >= 0) datasetResult[scenario].push(pair);
        process.stdout.write(`Dashboard A/B ${input.name} ${scenario} ${index + 1}/${pairs}\n`);
      }
    }
    results.push(datasetResult);
  }
  await fs.writeFile(config.result, JSON.stringify({ vscode: vscode.version, electron: process.versions.electron,
    extensionHostNode: process.version, datasets: results }, null, 2) + '\n');
}

async function main() {
  const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const output = option('output');
  assert.ok(output, '--output=<new JSON> is required');
  const outputPath = resolve(output);
  assert.ok(!existsSync(outputPath), 'Output already exists');
  const revision = execFileSync('git', ['rev-parse', option('before') ?? 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const workspace = await fs.mkdtemp(join(tmpdir(), 'agent-tracker-dashboard-ab-'));
  try {
    const { products, source } = await buildVariants(workspace, revision);
    const now = new Date();
    const { calendarPeriod, periodBounds } = require(join(products.after, 'dist/src/summary/db/timezone'));
    const today = calendarPeriod(now.getTime(), timezone, 'day');
    const start = new Date(`${today}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 29);
    const bounds = { fromMs: periodBounds(start.toISOString().slice(0, 10), timezone).fromMs, toMs: periodBounds(today, timezone).toMs };
    const inputs = [];
    for (const [name, count] of [['synthetic-100', 100], ['synthetic-10000', 10_000], ['current', 0]]) {
      if (option('dataset') && option('dataset') !== name) continue;
      inputs.push(await dataset(workspace, products.after, name, count, now));
    }
    assert.ok(inputs.length);
    const scenarios = option('scenario') ? [option('scenario')] : ['cold', 'warm'];
    assert.ok(scenarios.every(scenario => scenario === 'cold' || scenario === 'warm'));
    const warm = Number(option('warmups') ?? warmups), pairs = Number(option('pairs') ?? trials);
    const shell = join(workspace, 'test-extension');
    await fs.mkdir(shell);
    await fs.writeFile(join(shell, 'package.json'), JSON.stringify({ name: 'agent-tracker-timing-host', publisher: 'timing', version: '0.0.1', engines: { vscode: '^1.100.0' } }));
    const settingsDirectory = join(workspace, 'vscode', 'User');
    await fs.mkdir(settingsDirectory, { recursive: true });
    await fs.writeFile(join(settingsDirectory, 'settings.json'), JSON.stringify({
      'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off',
      'update.mode': 'none', 'extensions.autoCheckUpdates': false, 'chat.disableAIFeatures': true,
    }));
    const profile = join(workspace, 'config.json'), result = join(workspace, 'result.json');
    await fs.writeFile(profile, JSON.stringify({ products, inputs, bounds, scenarios, warmups: warm, trials: pairs, result }));
    const { runTests } = require('@vscode/test-electron');
    const installed = join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code/Code.exe');
    await runTests({ vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || (existsSync(installed) ? installed : undefined),
      extensionDevelopmentPath: shell, extensionTestsPath: __filename,
      extensionTestsEnv: { ELECTRON_RUN_AS_NODE: undefined, VSCODE_IPC_HOOK_CLI: undefined, AGENT_TRACKER_DASHBOARD_AB_CONFIG: profile },
      launchArgs: ['--user-data-dir', dirname(settingsDirectory), '--extensions-dir', join(workspace, 'extensions'), '--disable-extensions',
        '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--disable-workspace-trust'],
    });
    const measured = JSON.parse(await fs.readFile(result, 'utf8'));
    await fs.mkdir(dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify({ revision, source, timezone, today, bounds, scenarios, warmRollupPrepared: true, warmups: warm, pairs,
      platform: process.platform, cpu: cpus()[0]?.model, cores: cpus().length, ...measured }, null, 2) + '\n', { flag: 'wx' });
  } finally {
    assert.equal(dirname(resolve(workspace)), resolve(tmpdir()));
    assert.match(basename(workspace), /^agent-tracker-dashboard-ab-/);
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

module.exports = { run };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
