const assert = require('node:assert/strict');
const { mkdir, mkdtemp, writeFile } = require('node:fs/promises');
const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { operate, checksum } = require('./vscode/statusbar-toggle.cjs');

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

async function main() {
  const patch = operate({ check: true });
  const root = resolve(__dirname, '..');
  const resultDirectory = join(root, 'test-results');
  await mkdir(resultDirectory, { recursive: true });
  await mkdir(join(root, '.vscode-test'), { recursive: true });
  const sandbox = await mkdtemp(join(root, '.vscode-test', 'toggle-'));
  const userData = join(sandbox, 'user-data');
  await mkdir(join(userData, 'User'), { recursive: true });
  await writeFile(join(sandbox, 'empty.txt'), 'Agent Tracker native popup test\n');
  await writeFile(join(userData, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off', 'extensions.autoCheckUpdates': false, 'update.mode': 'none',
    // A short delay makes an accidentally retained automatic hover observable.
    'workbench.hover.delay': 100,
    'agentTracker.display.detail': 'compact',
    'agentTracker.claude.dataHome': join(sandbox, 'claude'),
    'agentTracker.codex.dataHome': join(sandbox, 'codex'),
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
  delete environment.ELECTRON_RUN_AS_NODE; delete environment.VSCODE_IPC_HOOK_CLI;
  const child = spawn(executable, ['--user-data-dir', userData, '--extensions-dir', join(sandbox, 'extensions'),
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
    const runtimeChecksums = await cdp.evaluate('globalThis.vscode.context.configuration().product.checksums');
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
    const editor = await cdp.evaluate(`(() => { const rect=document.querySelector('.part.editor').getBoundingClientRect();return {x:rect.x+rect.width/3,y:rect.y+100}; })()`);
    const visible = () => cdp.evaluate(`(() => {
      const card=[...document.querySelectorAll('.monaco-hover')].find(node => node.innerText.includes('사용량 통계') && node.innerText.includes('확장 관리'));
      if(!card)return null;const rect=card.getBoundingClientRect();return rect.width&&rect.height ? {top:rect.top,bottom:rect.bottom} : null;
    })()`);
    const assertStaysClosed = async description => {
      for (let attempt = 0; attempt < 15; attempt++) {
        await sleep(100); assert.equal(await visible(), null, description);
      }
    };
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x, y: button.y });
    await assertStaysClosed('hover alone must not open the quota card');
    outcomes.push('hover does not open the card with a normal short delay');
    await cdp.click(button);
    const card = await until(visible, 'first click opens quota card');
    assert.ok(card.bottom <= button.top + 8, 'card is anchored above the status bar');
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: editor.x, y: editor.y });
    await sleep(500); assert.ok(await visible(), 'card remains pinned after the mouse leaves');
    outcomes.push('first click opens and pins the card above the status bar');
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(resultDirectory, 'statusbar-toggle.png'), Buffer.from(screenshot.data, 'base64'));
    await cdp.click(button);
    await until(async () => !await visible(), 'second click closes quota card');
    await assertStaysClosed('the card stays closed while the mouse remains over the button');
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: editor.x, y: editor.y });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x, y: button.y });
    await assertStaysClosed('hovering again after closing must not reopen the card');
    outcomes.push('second click closes the pinned card');
    outcomes.push('closed card stays closed on mouse reentry');
    await cdp.click(button); await until(visible, 'reopen');
    await cdp.click(editor); await until(async () => !await visible(), 'outside click closes card');
    await cdp.click(button); await until(visible, 'reopen after outside dismissal');
    outcomes.push('outside dismissal followed by one click reopens correctly');
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await until(async () => !await visible(), 'Escape closes card');
    await cdp.click(button); await until(visible, 'reopen after Escape');
    outcomes.push('Escape followed by one click reopens correctly');
    await sleep(3000);
    const notificationText = await cdp.evaluate('[...document.querySelectorAll(".notification-list-item-message")].map(node=>node.innerText).join("\\n")');
    assert.doesNotMatch(notificationText, /installation appears to be corrupt|설치가 손상/iu, 'fresh startup must not show an installation corruption warning');
    outcomes.push('fresh startup has no installation integrity warning');
    await writeFile(join(resultDirectory, 'statusbar-toggle.json'), JSON.stringify({ passed: true, version: patch.version, outcomes }, null, 2));
    console.log('Native statusbar click toggle passed:', outcomes.join('; '));
  } catch (error) {
    await writeFile(join(resultDirectory, 'statusbar-toggle.json'), JSON.stringify({ passed: false, version: patch.version, error: error.message, outcomes }, null, 2));
    throw error;
  } finally {
    await writeFile(join(resultDirectory, 'statusbar-toggle.log'), log);
    if (cdp) { try { await cdp.call('Browser.close'); } catch {} cdp.socket.close(); }
    for (let attempt = 0; !exited && attempt < 30; attempt++) await sleep(100);
    if (!exited) child.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
