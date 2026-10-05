const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { existsSync } = require('node:fs');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extension = resolve(__dirname, '..');
  await rm(join(extension, 'test-results', 'vscode-smoke.json'), { force: true });
  const testHome = join(extension, '.vscode-test');
  await mkdir(testHome, { recursive: true });
  const sandbox = await mkdtemp(join(testHome, 'profile-'));
  const userData = join(sandbox, 'user-data');
  const source = join(sandbox, 'claude', 'projects');
  await mkdir(join(userData, 'User'), { recursive: true });
  await mkdir(source, { recursive: true });
  const fixture = [
    { type: 'ai-title', sessionId: 'ui-session', aiTitle: '통계 화면 검증' },
    { type: 'user', sessionId: 'ui-session', promptId: 'ui-turn', timestamp: '2026-10-03T00:00:00Z', cwd: '/synthetic/project', message: { content: 'synthetic request' } },
    { type: 'assistant', promptId: 'ui-turn', requestId: 'ui-request', timestamp: '2026-10-03T00:00:03Z', message: { id: 'ui-response', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } } },
  ];
  await writeFile(join(source, 'session.jsonl'), fixture.map(row => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(join(userData, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'workbench.colorTheme': 'Default Dark Modern',
    'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off',
    'extensions.autoCheckUpdates': false, 'update.mode': 'none',
    'agentTracker.claude.dataHome': join(sandbox, 'claude'),
    'agentTracker.codex.dataHome': join(sandbox, 'codex'),
    'agentTracker.codex.executable': join(sandbox, 'codex-not-installed.exe'),
    'agentTracker.usage.timezone': 'Asia/Seoul',
  }, null, 2));
  const installedWindows = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
  const executable = process.env.VSCODE_EXECUTABLE || (!process.env.VSCODE_TEST_VERSION && process.platform === 'win32' && existsSync(installedWindows) ? installedWindows : undefined);
  console.log(`Isolated VS Code test profile: ${sandbox}`);
  await runTests({
    ...(executable ? { vscodeExecutablePath: executable } : { version: process.env.VSCODE_TEST_VERSION || 'stable' }),
    extensionDevelopmentPath: extension,
    extensionTestsPath: join(extension, 'dist', 'tests', 'vscode', 'suite.js'),
    extensionTestsEnv: { ELECTRON_RUN_AS_NODE: undefined, VSCODE_IPC_HOOK_CLI: undefined, AGENT_TRACKER_TEST_ROOT: sandbox, AGENT_TRACKER_TEST_USER_DATA: userData },
    launchArgs: ['--user-data-dir', userData, '--extensions-dir', join(sandbox, 'extensions'), '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--disable-workspace-trust', '--no-sandbox'],
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
