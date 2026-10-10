import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';

/** Confirms VS Code itself localizes configuration contributions and opens its native settings editor. */
export async function run(): Promise<void> {
  const root = resolve(__dirname, '../../..');
  const language = process.env.AGENT_TRACKER_TEST_EDITOR_LANGUAGE!;
  assert.equal(vscode.env.language, language, 'the actual VS Code display language must match the scenario');
  const extension = vscode.extensions.getExtension('AgentTracker.agent-tracker')!;
  assert.ok(extension);
  const raw = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const messages = JSON.parse(readFileSync(join(root, `localization/package.nls.${language}.json`), 'utf8')) as Record<string,string>;
  const translate = (value: unknown): unknown => {
    if (typeof value === 'string' && /^%[\w.]+%$/.test(value)) return messages[value.slice(1,-1)];
    if (Array.isArray(value)) return value.map(translate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,translate(item)]));
    return value;
  };
  const native = extension.packageJSON.contributes.configuration as {title:string;properties:Record<string,unknown>}[];
  assert.deepEqual(native, translate(raw.contributes.configuration), 'VS Code must load translated categories, descriptions and enum labels');
  const untouched = JSON.stringify(native);
  await extension.activate();
  const localization = require(join(root,'dist/src/localization')) as typeof import('../../src/localization');
  assert.notEqual(localization.getLocale(), language, 'the extension UI intentionally uses a different language');
  await vscode.commands.executeCommand('agentTracker.openSettings');
  const label = language === 'ko' ? '설정' : 'Settings';
  const deadline = Date.now()+3000;
  while (!vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.label === label) && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait,50));
  }
  assert.ok(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.label === label), 'the native settings editor opens');
  assert.equal(JSON.stringify(extension.packageJSON.contributes.configuration), untouched, 'native settings keep the editor language independently of the extension override');
  await mkdir(join(root,'tests/results'),{recursive:true});
  await writeFile(join(root,`tests/results/native-settings-${language}.json`),JSON.stringify({
    passed:true,version:vscode.version,editorLanguage:language,extensionLanguage:localization.getLocale(),
    categories:native.length,settings:native.reduce((count:number,section:{properties:object}) => count+Object.keys(section.properties).length,0),
  },null,2));
  console.log(`Native VS Code settings passed: ${language}, six categories, twenty settings, extension override remains independent.`);
}
