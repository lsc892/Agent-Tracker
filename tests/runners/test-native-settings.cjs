const { mkdir, mkdtemp, writeFile, copyFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { withLocalizedManifest } = require('../../tools/localization-manifest.cjs');

async function main() {
  const root = resolve(__dirname, '../..');
  const languages = process.argv.slice(2);
  if (!languages.length) languages.push('en');
  if (languages.some(language => !['en','ko'].includes(language))) throw new Error('Expected en or ko; Korean requires an installed language pack.');
  const cache = join(root, 'tests/.cache/vscode');
  await mkdir(cache, {recursive:true});
  await withLocalizedManifest(root, async () => {
    for (const language of languages) {
      const profile = await mkdtemp(join(cache, 'native-settings-'));
      const userData = join(profile,'user-data');
      await mkdir(join(userData,'User'),{recursive:true});
      await writeFile(join(userData,'User/settings.json'),JSON.stringify({
        'workbench.startupEditor':'none','security.workspace.trust.enabled':false,'telemetry.telemetryLevel':'off',
        'update.mode':'none','extensions.autoCheckUpdates':false,
        'agentTracker.dataHome':profile,'agentTracker.language':language === 'en' ? 'ko' : 'en',
        'agentTracker.claude.enabled':false,'agentTracker.codex.enabled':false,'agentTracker.quota.refreshPolicy':'manual',
      }));
      if (language === 'ko') {
        const languagePacks = process.env.APPDATA && join(process.env.APPDATA,'Code/languagepacks.json');
        if (!languagePacks || !existsSync(languagePacks)) throw new Error('No installed Korean language pack configuration.');
        await copyFile(languagePacks,join(userData,'languagepacks.json'));
      }
      const executable = process.env.VSCODE_EXECUTABLE || (process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA,'Programs/Microsoft VS Code/Code.exe') : undefined);
      await runTests({
        cachePath:cache,...(executable ? {vscodeExecutablePath:executable} : {version:'stable'}),
        extensionDevelopmentPath:root,extensionTestsPath:join(root,'dist/tests/vscode/native-settings-suite.js'),
        extensionTestsEnv:{ELECTRON_RUN_AS_NODE:undefined,VSCODE_IPC_HOOK_CLI:undefined,AGENT_TRACKER_TEST_EDITOR_LANGUAGE:language},
        launchArgs:['--locale',language,'--user-data-dir',userData,'--extensions-dir',join(profile,'extensions'),
          '--disable-extensions','--skip-welcome','--skip-release-notes','--disable-gpu','--disable-workspace-trust','--no-sandbox'],
      });
    }
  });
}
main().catch(error => {console.error(error);process.exitCode=1;});
