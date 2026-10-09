const assert = require('node:assert/strict');
const { mkdir, mkdtemp, writeFile } = require('node:fs/promises');
const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { operate, checksum, resolveAppRoot } = require('../../tools/vscode/statusbar-toggle.cjs');
const { withLocalizedManifest } = require('../../tools/localization-manifest.cjs');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(probe, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await sleep(100); }
  throw new Error(`Timeout: ${description}`);
}

class Cdp {
  constructor(socket) {
    this.socket = socket; this.nextId = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (pending) { this.pending.delete(message.id); clearTimeout(pending.timer); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); }
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    return new Cdp(socket);
  }
  call(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async click(point) {
    await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
}

async function verifyStatusColors(cdp, settingsPath, resultDirectory, appRoot) {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const themeDirectory=join(appRoot,'extensions','theme-defaults');
  const themes=JSON.parse(readFileSync(join(themeDirectory,'package.json'),'utf8')).contributes.themes;
  const observations = [];
  const inspect = () => cdp.evaluate(`(() => {
    const bar=document.querySelector('.part.statusbar');
    const labels=['agentTracker.quota','agentTracker.refreshQuota'].map(id=>document.querySelector('[id$="'+id+'"] .statusbar-item-label'));
    if(!bar || labels.some(label=>!label))return null;
    return {editorBackground:getComputedStyle(document.querySelector('.monaco-workbench')).getPropertyValue('--vscode-editor-background').trim().toLowerCase(),foreground:getComputedStyle(bar).color,
      labels:labels.map(label=>({css:label.style.color,color:getComputedStyle(label).color,
        icons:[...label.querySelectorAll('.codicon')].map(icon=>getComputedStyle(icon).color)}))};
  })()`);
  const save = () => writeFile(settingsPath, JSON.stringify(settings));
  const matches = (view, css, color) => view && view.labels.every(label=>(css==='fixed' ? Boolean(label.css) && label.css!=='inherit' : label.css===css) && label.color===(color ?? view.foreground) && label.icons.every(icon=>icon===label.color));
  const check = async (description, css, color) => {
    let view;
    try { view=await until(async()=>{const view=await inspect();return matches(view,css,color) && view;},description); }
    catch (error) { throw new Error(error.message+': '+JSON.stringify(await inspect())); }
    observations.push({description,...view});
    return view;
  };
  for (const theme of ['Dark 2026','Light 2026','Dark Modern','Default High Contrast']) {
    settings['workbench.colorTheme']=theme;
    settings['agentTracker.display.colorMode']='automatic';
    settings['agentTracker.display.customColor']='#ffffff';
    delete settings['workbench.colorCustomizations'];
    await save();
    const themeSource=JSON.parse(readFileSync(join(themeDirectory,themes.find(value=>value.id===theme).path),'utf8'));
    await until(async()=>{const view=await inspect();return view?.editorBackground===themeSource.colors['editor.background'].toLowerCase();},'theme switches to '+theme);
    await check(theme+': automatic label and icon colors match the status bar','inherit');
    const point=await cdp.evaluate(`(() => {const rect=document.querySelector('[id$="agentTracker.quota"] .statusbar-item-label').getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()`);
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    await check(theme+': automatic retains the theme foreground on hover','inherit');
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:300,y:100});
    for (const [mode,hex,color] of [['white','#ffffff','rgb(255, 255, 255)'],['black','#000000','rgb(0, 0, 0)'],['custom','#12345680','rgba(18, 52, 86, 0.5)']]) {
      settings['agentTracker.display.colorMode']=mode;
      settings['agentTracker.display.customColor']=hex;
      await save();
      await check(theme+': '+mode+' fixes label and icon colors','fixed',color);
    }
  }
  settings['agentTracker.display.colorMode']='automatic';
  settings['workbench.colorCustomizations']={'statusBar.foreground':'#91a2b3','statusBar.noFolderForeground':'#b3a291'};
  await save();
  const overridden=await check('automatic follows the no-folder theme override','inherit','rgb(179, 162, 145)');
  assert.equal(overridden.foreground,'rgb(179, 162, 145)');
  settings['agentTracker.display.colorMode']='custom';
  settings['agentTracker.display.customColor']='#123456';
  await save();
  await check('custom overrides the workbench foreground','rgb(18, 52, 86)','rgb(18, 52, 86)');
  settings['workbench.colorTheme']='Light 2026';
  settings['workbench.colorCustomizations']={'statusBar.foreground':'#abcdef','statusBar.noFolderForeground':'#abcdef'};
  await save();
  await until(async()=>{const view=await inspect();return view?.foreground==='rgb(171, 205, 239)';},'workbench foreground changes while custom remains selected');
  await check('custom remains fixed across theme and color customization changes','rgb(18, 52, 86)','rgb(18, 52, 86)');
  settings['agentTracker.display.colorMode']='automatic';
  await save();
  await check('switching back to automatic restores the current theme color','inherit','rgb(171, 205, 239)');
  settings['agentTracker.display.colorMode']='custom';
  settings['agentTracker.display.customColor']='invalid';
  await save();
  await check('invalid custom color falls back to theme inheritance','inherit','rgb(171, 205, 239)');
  const screenshot=await cdp.call('Page.captureScreenshot',{format:'png'});
  await writeFile(join(resultDirectory,'statusbar-colors.png'),Buffer.from(screenshot.data,'base64'));
  return observations;
}

async function main() {
  const baseline = process.argv.includes('--baseline');
  const quotaFixture = process.argv.includes('--quota-fixture');
  const statusColors = process.argv.includes('--status-colors');
  const appRoot = resolveAppRoot();
  const patch = baseline || statusColors ? { appRoot, version: JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version } : operate({ check: true });
  const reportName = statusColors ? 'statusbar-colors.json' : baseline ? 'statusbar-toggle-baseline.json' : quotaFixture ? 'quota-card.json' : 'statusbar-toggle.json';
  const root = resolve(__dirname, '../..');
  const resultDirectory = join(root, 'tests', 'results');
  await mkdir(resultDirectory, { recursive: true });
  const testHome = join(root, 'tests', '.cache', 'vscode');
  await mkdir(testHome, { recursive: true });
  const sandbox = await mkdtemp(join(testHome, 'toggle-'));
  const userData = join(sandbox, 'user-data');
  await mkdir(join(userData, 'User'), { recursive: true });
  await writeFile(join(sandbox, 'empty.txt'), 'Agent Tracker native popup test\n');
  await writeFile(join(userData, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'workbench.colorTheme': 'Default Dark Modern', 'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off', 'extensions.autoCheckUpdates': false, 'update.mode': 'none',
    // A short delay makes an accidentally retained automatic hover observable.
    'workbench.hover.delay': 100,
    'agentTracker.display.detail': 'compact',
    'agentTracker.display.colorMode': 'automatic',
    'agentTracker.quota.refreshPolicy': 'manual',
    'agentTracker.dataHome': sandbox,
    'agentTracker.codex.executable': join(sandbox, 'codex-not-installed.exe'),
  }));
  const candidates = [process.env.VSCODE_EXECUTABLE,
    join(patch.appRoot, '..', '..', '..', 'Code.exe'), join(patch.appRoot, '..', '..', 'Code.exe'),
    join(patch.appRoot, '..', '..', 'MacOS', 'Electron'), join(patch.appRoot, '..', '..', 'code')];
  const executable = candidates.find(value => value && existsSync(value));
  assert.ok(executable, 'VS Code executable is discoverable');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const environment = { ...process.env };
  if (quotaFixture) environment.AGENT_TRACKER_QUOTA_FIXTURE_READY = join(sandbox, 'quota-fixture-ready');
  delete environment.ELECTRON_RUN_AS_NODE; delete environment.VSCODE_IPC_HOOK_CLI;
  const child = spawn(executable, ['--user-data-dir', userData, '--extensions-dir', join(sandbox, 'extensions'),
    ...(quotaFixture ? ['--extensionTestsPath', join(root, 'dist/tests/fixtures/quotaCardFixture.js')] : []),
    '--extensionDevelopmentPath', root, '--disable-extensions', '--skip-welcome', '--skip-release-notes',
    '--disable-gpu', '--disable-workspace-trust', '--no-sandbox', '--new-window',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, join(sandbox, 'empty.txt')],
  { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', cdp, exited = false;
  child.on('exit', () => { exited = true; });
  child.on('error', error => { log += error.message; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk.toString()).slice(-1000000); });
  const outcomes = [];
  try {
    const page = await until(async () => {
      try { const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); return pages.find(page => page.type === 'page' && page.url.includes('workbench')); } catch { return false; }
    }, 'isolated workbench debugger');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    const runtimeChecksums = await until(() => cdp.evaluate('globalThis.vscode?.context?.configuration?.()?.product?.checksums'), 'workbench preload configuration');
    const diskChecksums = JSON.parse(readFileSync(join(patch.appRoot, 'product.json'), 'utf8')).checksums;
    const integrity = Object.entries(runtimeChecksums).map(([file, expected]) => ({
      file, expected, actual: checksum(readFileSync(join(patch.appRoot, 'out', file))),
    }));
    await writeFile(join(resultDirectory, 'statusbar-integrity.json'), JSON.stringify({
      version: patch.version, runtimeMatchesDisk: JSON.stringify(runtimeChecksums) === JSON.stringify(diskChecksums),
      proof: integrity,
    }, null, 2));
    assert.deepEqual(runtimeChecksums, diskChecksums, 'a fresh VS Code process loads the current checksum registry');
    assert.ok(integrity.every(file => file.expected === file.actual), 'every file passes the checksum registry actually loaded by VS Code');
    outcomes.push('fresh VS Code runtime integrity: all registered files match');
    const button = await until(() => cdp.evaluate(`(() => {
      const element = [...document.querySelectorAll('.statusbar-item')].find(node => node.id.endsWith('agentTracker.quota'))?.querySelector('.statusbar-item-label');
      if (!element) return null; const rect = element.getBoundingClientRect(); return rect.width ? {x:rect.x+rect.width/2,y:rect.y+rect.height/2,top:rect.top} : null;
    })()`), 'quota status item');
    if (statusColors) {
      if (quotaFixture) await until(()=>existsSync(environment.AGENT_TRACKER_QUOTA_FIXTURE_READY),'quota fixture finishes its initial settings updates');
      const observations=await verifyStatusColors(cdp,join(userData,'User','settings.json'),resultDirectory,appRoot);
      await writeFile(join(resultDirectory,reportName),JSON.stringify({passed:true,version:patch.version,observations},null,2));
      console.log('Native statusbar colors passed:',observations.map(view=>view.description).join('; '));
      return;
    }
    const editor = await cdp.evaluate(`(() => { const rect=document.querySelector('.part.editor').getBoundingClientRect();return {x:rect.x+rect.width/3,y:rect.y+100}; })()`);
    const visible = () => cdp.evaluate(`(() => {
      const card=[...document.querySelectorAll('.monaco-hover')].find(node => node.innerText.includes('사용량 통계') && node.querySelector('a[data-href="command:agentTracker.openSettings"]'));
      if(!card)return null;const rect=card.getBoundingClientRect();return rect.width&&rect.height ? {top:rect.top,bottom:rect.bottom} : null;
    })()`);
    if (baseline) {
      await cdp.click(button);
      await until(visible, 'baseline first click opens the card');
      await cdp.evaluate(`globalThis.quotaMutations=[];globalThis.quotaObserver=new MutationObserver(records=>{
        for(const record of records) for(const [kind,nodes] of [['removed',record.removedNodes],['added',record.addedNodes]])
          for(const node of nodes) if(node.nodeType===1 && (node.matches('.monaco-hover') || node.querySelector('.monaco-hover'))) globalThis.quotaMutations.push(kind);
      });globalThis.quotaObserver.observe(document.body,{childList:true,subtree:true});`);
      await cdp.click(button);
      await sleep(500);
      assert.ok(await visible(), 'baseline bug: second click reopens the card');
      const mutations = await cdp.evaluate('globalThis.quotaObserver.disconnect();globalThis.quotaMutations');
      assert.ok(mutations.includes('removed') && mutations.includes('added'), 'baseline observes dismissal followed by recreation');
      await writeFile(join(resultDirectory, reportName), JSON.stringify({ reproduced: true, version: patch.version, mutations, cause: 'mousedown dismisses the card; workbench.action.showHover opens it again on click' }, null, 2));
      console.log('Reproduced: the second click removes the quota card and creates it again.');
      return;
    }
    const summary = () => cdp.evaluate(`(() => {
      const hover=[...document.querySelectorAll('.monaco-hover')].find(node => node.innerText.includes('클릭하여 열기/닫기'));
      if(!hover)return null;const rect=hover.getBoundingClientRect();return rect.width&&rect.height ? hover.innerText : null;
    })()`);
    const assertStaysClosed = async description => {
      for (let attempt = 0; attempt < 15; attempt++) {
        await sleep(100); assert.equal(await visible(), null, description);
      }
    };
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x, y: button.y });
    const preview = await until(summary, 'hover opens the short preview');
    assert.match(preview, quotaFixture ? /Claude: 5시간 - 67% 남음/ : /Claude: 조회불가/);
    assert.match(preview, quotaFixture ? /Codex: 5시간 - 31% 남음/ : /Codex: 조회불가/);
    await assertStaysClosed('hover alone must not open the quota card');
    outcomes.push('hover shows only the short provider summary and click instruction');
    await cdp.click(button);
    const card = await until(visible, 'first click opens quota card');
    assert.equal(await summary(), null, 'click replaces the preview with the quota UI');
    assert.ok(card.bottom <= button.top + 8, 'card is anchored above the status bar');
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: editor.x, y: editor.y });
    await sleep(500); assert.ok(await visible(), 'card remains pinned after the mouse leaves');
    outcomes.push('first click opens and pins the card above the status bar');
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x, y: button.y });
    for (let attempt = 0; attempt < 15; attempt++) {
      await sleep(100);
      assert.equal(await summary(), null, 'an open quota UI suppresses the preview');
      assert.ok(await visible(), 'hover cannot replace the pinned quota UI');
    }
    outcomes.push('hover preview stays suppressed while the quota UI is pinned');
    const refresh = await cdp.evaluate(`(() => {
      const link=document.querySelector('.monaco-hover a[data-href="command:agentTracker.refreshQuota"]');
      if(!link)return null;const rect=link.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    })()`);
    assert.ok(refresh, 'the quota UI has a refresh action');
    await cdp.click(refresh);
    await sleep(500);
    assert.ok(await visible(), 'refresh updates the pinned card in place');
    assert.equal(await summary(), null, 'a quota update must not replace the card with a preview');
    outcomes.push('quota refresh retains the pinned UI and suppresses the preview');
    if (quotaFixture) {
      const inspect = () => cdp.evaluate(`(() => {
        const card=[...document.querySelectorAll('.monaco-hover')].find(node => node.innerText.includes('rate-limit 재설정'));
        if(!card)return null;
        const rect=card.getBoundingClientRect();
        return {text:card.innerText,tables:[...card.querySelectorAll('table')].filter(table=>!table.querySelector('h3')).length,
          meters:[...card.querySelectorAll('img[alt^="사용 "], img[alt^="남음 "]')].map(img=>({loaded:img.complete&&img.naturalWidth>0,width:img.width,height:img.height})),
          periods:[...card.querySelectorAll('table')].filter(table=>!table.querySelector('h3')).map(table=>({
            widths:[...table.querySelectorAll('img')].map(img=>img.width),
            captions:[...table.rows[1].cells].map(cell=>{
              const span=cell.querySelector('span'),range=document.createRange();range.selectNodeContents(span);
              const bounds=range.getBoundingClientRect();return {left:bounds.left,right:bounds.right,height:bounds.height,lineHeight:parseFloat(getComputedStyle(span).lineHeight)};
            }),
          })),
          colors:[...card.querySelectorAll('span[style]')].map(span=>getComputedStyle(span).color),
          dividers:[...card.querySelectorAll('hr')].map(line=>{const bounds=line.getBoundingClientRect(),style=getComputedStyle(line);return {
            leftGap:bounds.left-rect.left,rightGap:rect.right-bounds.right,height:bounds.height,color:style.borderTopColor,borderWidth:style.borderTopWidth,borderStyle:style.borderTopStyle};}),
          clip:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,scale:1}};
      })()`);
      const rendered = await until(async () => {
        const value=await inspect(); return value?.meters.length === 4 && value.meters.every(meter=>meter.loaded) ? value : null;
      }, 'native usage meters load');
      assert.equal(rendered.tables, 2, 'each provider has aligned period and reset rows');
      assert.doesNotMatch(rendered.text, /gpt-reserve/);
      assert.match(rendered.text, /4h 37m 후 초기화/);
      assert.match(rendered.text, /rate-limit 재설정 2회 사용 가능/);
      assert.match(rendered.text, /다음 항목이 17d 8h 후 만료됨/);
      assert.ok(rendered.meters.every(meter=>meter.width >= 62 && meter.width <= 113 && meter.height === 8));
      assert.ok(rendered.colors.includes('rgb(233, 164, 0)'), 'moderate usage is amber');
      assert.ok(rendered.colors.includes('rgb(250, 48, 72)'), 'high usage is red');
      const assertDividers = card => {
        assert.equal(card.dividers.length, 3, 'provider sections and footer each have a divider');
        for (const line of card.dividers) {
          assert.ok(Math.abs(line.leftGap) <= 2 && Math.abs(line.rightGap) <= 2, 'dividers reach both card edges');
          assert.equal(line.height, 2, 'dividers are two CSS pixels thick');
          // Chromium snaps borders to device pixels (2px becomes 1.6px at 125% scaling).
          assert.ok(parseFloat(line.borderWidth) >= 1.5 && parseFloat(line.borderWidth) <= 2, 'border thickness survives display scaling');
          assert.equal(line.borderStyle, 'solid');
          assert.equal(line.color, 'rgb(136, 136, 136)', 'dividers use a visible gray in either theme');
        }
      };
      const assertPeriodSpacing = value => {
        for (const period of value.periods) {
          assert.equal(new Set(period.widths).size, 1, 'sibling meters have equal widths');
          for (const [index, caption] of period.captions.entries()) {
            assert.ok(caption.height <= caption.lineHeight + 1, 'reset captions stay on one line');
            if (index) assert.ok(caption.left - period.captions[index-1].right >= 24, 'reset captions have a visible column gap');
          }
        }
      };
      assertDividers(rendered);
      assertPeriodSpacing(rendered);
      const settingsPath = join(userData, 'User', 'settings.json');
      for (const showReserve of [true, false]) {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        settings['agentTracker.codex.showReserve'] = showReserve;
        await writeFile(settingsPath, JSON.stringify(settings, null, 2));
        await until(async () => {
          const card = await inspect();
          return card && card.text.includes('gpt-reserve') === showReserve && card.meters.length === (showReserve ? 5 : 4);
        }, `reserve ${showReserve ? 'appears' : 'disappears'} in the pinned card`);
        assert.ok(await visible(), 'the quota card stays pinned when reserve visibility changes');
      }
      outcomes.push('Show Reserve immediately toggles the named base_model_inference bucket in the pinned card');
      const dark = await cdp.call('Page.captureScreenshot', {format:'png',clip:rendered.clip});
      await writeFile(join(resultDirectory,'quota-card-dark.png'),Buffer.from(dark.data,'base64'));
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      settings['workbench.colorTheme'] = 'Default Light Modern';
      await writeFile(settingsPath, JSON.stringify(settings, null, 2));
      await until(()=>cdp.evaluate('document.querySelector(".monaco-workbench")?.classList.contains("vs")'), 'light theme applies');
      await sleep(750);
      const lightCard = await until(inspect, 'usage card stays open after theme change');
      assertDividers(lightCard);
      assertPeriodSpacing(lightCard);
      const light = await cdp.call('Page.captureScreenshot', {format:'png',clip:lightCard.clip});
      await writeFile(join(resultDirectory,'quota-card-light.png'),Buffer.from(light.data,'base64'));
      outcomes.push('provider summaries, SVG meters, usage colors and earned-reset metadata render in dark and light themes');
      outcomes.push('three visible 2px dividers reach both card edges in dark and light themes');
      outcomes.push('wider equal-length meters and separated reset captions render in dark and light themes');
    }
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(resultDirectory, 'statusbar-toggle.png'), Buffer.from(screenshot.data, 'base64'));
    await cdp.click(button);
    await until(async () => !await visible(), 'second click closes quota card');
    await assertStaysClosed('the card stays closed while the mouse remains over the button');
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: editor.x, y: editor.y });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x, y: button.y });
    await until(summary, 'preview is available again after closing');
    await assertStaysClosed('hovering again after closing must not reopen the card');
    outcomes.push('second click closes the pinned card');
    outcomes.push('closed card stays closed on mouse reentry');
    for (let attempt = 0; attempt < 3; attempt++) {
      await cdp.click(button); await until(visible, 'repeated click opens');
      await cdp.click(button); await assertStaysClosed('repeated second click must not reopen');
    }
    outcomes.push('repeated open/close clicks never reopen a dismissed card');
    await cdp.click(button); await until(visible, 'reopen');
    await cdp.click(editor); await until(async () => !await visible(), 'outside click closes card');
    await cdp.click(button); await until(visible, 'reopen after outside dismissal');
    outcomes.push('outside dismissal followed by one click reopens correctly');
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await until(async () => !await visible(), 'Escape closes card');
    await cdp.click(button); await until(visible, 'reopen after Escape');
    outcomes.push('Escape followed by one click reopens correctly');
    await cdp.evaluate(`document.querySelector('[id$="agentTracker.quota"] .statusbar-item-label').focus()`);
    for (const open of [false, true]) {
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await until(async () => Boolean(await visible()) === open, `Enter toggles ${open ? 'open' : 'closed'}`);
    }
    outcomes.push('keyboard Enter toggles the same quota UI');
    await sleep(3000);
    const notificationText = await cdp.evaluate('[...document.querySelectorAll(".notification-list-item-message")].map(node=>node.innerText).join("\\n")');
    assert.doesNotMatch(notificationText, /installation appears to be corrupt|설치가 손상/iu, 'fresh startup must not show an installation corruption warning');
    outcomes.push('fresh startup has no installation integrity warning');
    await writeFile(join(resultDirectory, reportName), JSON.stringify({ passed: true, version: patch.version, outcomes }, null, 2));
    console.log('Native statusbar click toggle passed:', outcomes.join('; '));
  } catch (error) {
    await writeFile(join(resultDirectory, reportName), JSON.stringify({ passed: false, version: patch.version, error: error.message, outcomes }, null, 2));
    throw error;
  } finally {
    await writeFile(join(resultDirectory, 'statusbar-toggle.log'), log);
    if (cdp) { try { await cdp.call('Browser.close'); } catch {} cdp.socket.close(); }
    for (let attempt = 0; !exited && attempt < 30; attempt++) await sleep(100);
    if (!exited) child.kill();
  }
}
withLocalizedManifest(resolve(__dirname, '../..'), main).catch(error => { console.error(error); process.exitCode = 1; });
