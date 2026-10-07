import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const patcher = require('../../../tools/vscode/statusbar-toggle.cjs') as {
  command: string; checksum(value: string): string;
  hash(value: string): string;
  resolveAppRoot(options: { cli?: string; executable?: string }): string;
  patchSource(source: string): { original: string; patched: string; alreadyPatched: boolean; upgradeRequired: boolean };
  operate(options: { appRoot: string; check?: boolean; restore?: boolean }): { status: string };
};
const source = `const nativeToggle={id:"statusBar.entry.toggleTooltip",title:""};
class Item{constructor(container=new EventTarget()){this.label={};this.container=container;this.disposables=[]}_register(value){this.disposables.push(value);return value}update(e){if(this.label.showProgress=e.showProgress??false){}this.commandPointerListener=e.command;this.entry=e}
show(){return this.hoverService.getStickyHover(this.container)}}
globalThis.Item=Item;globalThis.nativeToggle=nativeToggle;`;

function rendererContext(): Record<string, any> {
  const styles: { id?: string; textContent?: string }[] = [];
  const document = {
    getElementById: (id: string) => styles.find(style => style.id === id),
    createElement: () => ({}),
    head: { appendChild: (style: { id?: string; textContent?: string }) => styles.push(style) },
  };
  class Container extends EventTarget { readonly ownerDocument = document; }
  return { EventTarget: Container, styles };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tracker-vscode-patch-'));
  const directory = join(root, 'out', 'vs', 'workbench');
  mkdirSync(directory, { recursive: true });
  const target = join(directory, 'workbench.desktop.main.js');
  const productPath = join(root, 'product.json');
  const product = JSON.stringify({ checksums: { 'vs/workbench/workbench.desktop.main.js': patcher.checksum(source), unrelated: 'unchanged' } }, null, 2) + '\n';
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'Code', version: '1.140.0' }));
  writeFileSync(target, source);
  writeFileSync(productPath, product);
  return { root, target, productPath, product, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('native toggle mapping preserves object identity and is limited to the Agent Tracker extension and command', () => {
  const result = patcher.patchSource(source);
  const context = rendererContext();
  runInNewContext(result.patched, context);
  const entry = { extensionId: 'agent-tracker.agent-tracker', command: { id: patcher.command, title: '' } };
  const item = new context.Item(); item.update(entry);
  assert.equal(item.entry.command, context.nativeToggle);
  assert.notEqual(entry.command, context.nativeToggle, 'mapping does not mutate the incoming entry');
  for (const other of [
    { extensionId: 'another.extension', command: { id: patcher.command } },
    { extensionId: 'agent-tracker.agent-tracker', command: { id: 'another.command' } },
    { extensionId: 'agent-tracker.agent-tracker', command: undefined },
  ]) { item.update(other); assert.equal(item.entry, other); }
  assert.equal(patcher.patchSource(result.patched).alreadyPatched, true);
  assert.equal(patcher.patchSource(result.patched).patched, result.patched);
  assert.throws(() => patcher.patchSource(source + source), /유일하게/);
});

test('the preview uses plain text, the clicked card retains Markdown, and pinned cards suppress automatic hover', () => {
  const context = rendererContext();
  runInNewContext(patcher.patchSource(source).patched, context);
  const target = new context.EventTarget();
  const item = new context.Item(target);
  let pinned = false;
  const shown: { content: unknown; focus?: boolean }[] = [];
  const delegate = { delay: 100, placement: 'element', showHover: (options: { content: unknown }, focus?: boolean) => { shown.push({ content: options.content, focus }); } };
  item.hoverDelegate = delegate;
  item.hoverService = { getStickyHover: () => pinned ? {} : undefined };
  const entry = { extensionId: 'agent-tracker.agent-tracker', command: { id: patcher.command }, ariaLabel: 'Claude: 조회 불가\nCodex: 5시간 - 83% 남음, 재설정까지 3h 10m\n클릭하여 열기/닫기' };
  item.update(entry); item.update(entry);
  assert.equal(item.disposables.length, 1, 'updates do not register duplicate capture filters');
  assert.notEqual(item.hoverDelegate, delegate, 'the shared delegate is not modified');
  assert.equal(item.hoverDelegate.delay, 100);
  delegate.delay = 500;
  assert.equal(item.hoverDelegate.delay, 500, 'configuration changes remain observable');
  const card = { value: '### 사용량' };
  item.hoverDelegate.showHover({ content: card }, false);
  assert.deepEqual(shown.at(-1), { content: entry.ariaLabel, focus: false });
  item.hoverDelegate.showHover({ content: card }, true);
  assert.deepEqual(shown.at(-1), { content: card, focus: true });
  pinned = true;
  const count = shown.length;
  item.hoverDelegate.showHover({ content: card }, false);
  assert.equal(shown.length, count, 'a pending preview cannot replace a pinned card');
  const events: string[] = [];
  for (const type of ['mouseover', 'focus', 'click', 'pointerdown', 'keydown']) {
    target.addEventListener(type, () => events.push(type), true);
    target.dispatchEvent(new Event(type));
  }
  assert.deepEqual(events, ['click', 'pointerdown', 'keydown']);
  pinned = false;
  target.dispatchEvent(new Event('mouseover'));
  assert.equal(events.at(-1), 'mouseover', 'closed cards allow ordinary preview hover');
  item.update({ ...entry, ariaLabel: 'updated preview' });
  item.hoverDelegate.showHover({ content: card }, false);
  assert.equal(shown.at(-1)?.content, 'updated preview', 'refresh uses the latest summary');
  item.hoverDelegate.showHover({ content: card }, true);
  assert.equal(shown.at(-1)?.content, card, 'refresh of a pinned card keeps full content');
  item.update({ ...entry, command: { id: 'another.command' } });
  pinned = true;
  target.dispatchEvent(new Event('mouseover'));
  assert.equal(events.at(-1), 'mouseover', 'a different command retains ordinary hover');
  item.hoverDelegate.showHover({ content: card }, false);
  assert.equal(shown.at(-1)?.content, card, 'another command retains its own tooltip');
  item.update(entry);
  for (const disposable of item.disposables) disposable.dispose();
  target.dispatchEvent(new Event('focus'));
  assert.equal(events.at(-1), 'focus', 'disposing removes the capture filter');
  const other = new context.Item();
  other.update({ ...entry, extensionId: 'another.extension' });
  assert.equal(other.disposables.length, 0, 'another extension receives no capture filter');
  assert.equal(context.styles.length, 1, 'quota updates install only one divider stylesheet per document');
});

for (const version of [1, 2, 3]) test(`v${version} upgrades while retaining the original restore backups`, () => {
  const files = fixture();
  try {
    const anchor = 'update(e){';
    // Exact historical v2 payload: automatic activation was always suppressed.
    const clickOnly = version === 1 ? '' : `if(!this._agentTrackerClickOnly){this._agentTrackerClickOnly=true;const stop=event=>{if(this.entry?.extensionId==="agent-tracker.agent-tracker"&&this.entry?.command===nativeToggle)event.stopImmediatePropagation();};for(const type of ["mouseover","focus"])this.container.addEventListener(type,stop,{capture:true});this._register({dispose:()=>{for(const type of ["mouseover","focus"])this.container.removeEventListener(type,stop,{capture:true});}});}`;
    const old = version === 3
      ? patcher.patchSource(source).patched.replace(':statusbar-toggle:v4*/', ':statusbar-toggle:v3*/')
        .replace(/\(function configureQuotaDividers\(item\) \{[\s\S]*?\}\)\(this\);/, '')
      : source.replace(anchor, `${anchor}/*agent-tracker:statusbar-toggle:v${version}*/if(e.extensionId==="agent-tracker.agent-tracker"&&e.command?.id==="${patcher.command}"){e={...e,command:nativeToggle};${clickOnly}}/*agent-tracker:statusbar-toggle:end*/`);
    const oldProduct = JSON.stringify({ checksums: { 'vs/workbench/workbench.desktop.main.js': patcher.checksum(old), unrelated: 'unchanged' } });
    writeFileSync(`${files.target}.agent-tracker-toggle.bak`, source);
    writeFileSync(`${files.productPath}.agent-tracker-toggle.bak`, files.product);
    writeFileSync(files.target, old); writeFileSync(files.productPath, oldProduct);
    writeFileSync(`${files.target}.agent-tracker-toggle.json`, JSON.stringify({ originalHash: patcher.hash(source), originalProductHash: patcher.hash(files.product), patchedHash: patcher.hash(old), patchedProductHash: patcher.hash(oldProduct) }));
    assert.equal(patcher.patchSource(old).upgradeRequired, true);
    assert.throws(() => patcher.operate({ appRoot: files.root, check: true }), /적용/);
    assert.equal(readFileSync(files.target, 'utf8'), old, 'check does not upgrade');
    assert.equal(patcher.operate({ appRoot: files.root }).status, 'upgraded');
    assert.equal(patcher.operate({ appRoot: files.root, check: true }).status, 'already-patched');
    assert.equal(readFileSync(`${files.target}.agent-tracker-toggle.bak`, 'utf8'), source);
    assert.equal(readFileSync(`${files.productPath}.agent-tracker-toggle.bak`, 'utf8'), files.product);
    // Restore must also handle an interrupted upgrade that retained the old renderer.
    writeFileSync(files.target, old);
    assert.equal(patcher.operate({ appRoot: files.root, restore: true }).status, 'restored');
    assert.equal(readFileSync(files.target, 'utf8'), source);
    assert.equal(readFileSync(files.productPath, 'utf8'), files.product);
  } finally { files.dispose(); }
});

test('renderer patch backs up exact originals, updates only its checksum, restores, and can be reapplied', () => {
  const files = fixture();
  try {
    assert.equal(patcher.operate({ appRoot: files.root }).status, 'patched');
    assert.equal(readFileSync(`${files.target}.agent-tracker-toggle.bak`, 'utf8'), source);
    assert.equal(readFileSync(`${files.productPath}.agent-tracker-toggle.bak`, 'utf8'), files.product);
    const patched = readFileSync(files.target, 'utf8');
    const checksums = JSON.parse(readFileSync(files.productPath, 'utf8')).checksums;
    assert.equal(checksums['vs/workbench/workbench.desktop.main.js'], patcher.checksum(patched));
    assert.equal(checksums.unrelated, 'unchanged');
    assert.equal(patcher.operate({ appRoot: files.root, check: true }).status, 'already-patched');
    assert.equal(patcher.operate({ appRoot: files.root }).status, 'already-patched');
    assert.equal(patcher.operate({ appRoot: files.root, restore: true }).status, 'restored');
    assert.equal(readFileSync(files.target, 'utf8'), source);
    assert.equal(readFileSync(files.productPath, 'utf8'), files.product);
    assert.equal(patcher.operate({ appRoot: files.root, restore: true }).status, 'already-restored');
    assert.equal(patcher.operate({ appRoot: files.root }).status, 'patched');
  } finally { files.dispose(); }
});

test('missing native implementation, read-only check, and mismatched checksum do not modify installed files', () => {
  const files = fixture();
  try {
    assert.throws(() => patcher.operate({ appRoot: files.root, check: true }), /적용/);
    assert.equal(readFileSync(files.target, 'utf8'), source);
    assert.equal(existsSync(`${files.target}.agent-tracker-toggle.bak`), false);
    writeFileSync(files.target, source.replace('statusBar.entry.toggleTooltip', 'unsupported'));
    assert.throws(() => patcher.operate({ appRoot: files.root }), /ToggleTooltipCommand/);
    assert.equal(existsSync(`${files.target}.agent-tracker-toggle.bak`), false);
    writeFileSync(files.target, source + '\n// another modification');
    assert.throws(() => patcher.operate({ appRoot: files.root }), /무결성/);
    assert.equal(readFileSync(files.productPath, 'utf8'), files.product);
  } finally { files.dispose(); }
});

test('restore refuses to overwrite later edits or use a damaged backup', () => {
  const files = fixture();
  try {
    patcher.operate({ appRoot: files.root });
    const patched = readFileSync(files.target, 'utf8');
    writeFileSync(files.target, patched + '\n// later modification');
    assert.throws(() => patcher.operate({ appRoot: files.root, restore: true }), /이후 파일이 변경/);
    assert.equal(readFileSync(files.target, 'utf8'), patched + '\n// later modification');
    writeFileSync(files.target, patched);
    writeFileSync(`${files.target}.agent-tracker-toggle.bak`, 'damaged backup');
    assert.throws(() => patcher.operate({ appRoot: files.root, restore: true }), /백업 무결성/);
    assert.equal(readFileSync(files.target, 'utf8'), patched);
  } finally { files.dispose(); }
});

test('restore recovers an interrupted apply with only one installed file changed', () => {
  const files = fixture();
  try {
    patcher.operate({ appRoot: files.root });
    writeFileSync(files.productPath, files.product);
    assert.equal(patcher.operate({ appRoot: files.root, restore: true }).status, 'restored');
    assert.equal(readFileSync(files.target, 'utf8'), source);
    assert.equal(readFileSync(files.productPath, 'utf8'), files.product);
    patcher.operate({ appRoot: files.root });
    writeFileSync(files.target, source);
    assert.equal(patcher.operate({ appRoot: files.root, restore: true }).status, 'restored');
    assert.equal(readFileSync(files.productPath, 'utf8'), files.product);
  } finally { files.dispose(); }
});

test('installation discovery follows the selected CLI and refuses an invalid explicit target', () => {
  const files = fixture();
  try {
    const bin = join(files.root, 'bin');
    const app = join(files.root, 'selected-version', 'resources', 'app');
    mkdirSync(bin); mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'product.json'), '{}');
    const cli = join(bin, 'code-insiders.cmd');
    writeFileSync(cli, '"%~dp0..\\selected-version\\resources\\app\\out\\cli.js"');
    assert.equal(patcher.resolveAppRoot({ cli }), resolve(app));
    assert.throws(() => patcher.resolveAppRoot({ executable: join(files.root, 'missing.exe') }), /설치를 찾지/);
  } finally { files.dispose(); }
});
