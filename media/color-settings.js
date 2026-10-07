(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let busy = false;
  let lastValidColor = '#ffffff';
  function normalized(value) {
    const color = value.trim().toLowerCase();
    if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/.test(color)) return undefined;
    return color.length <= 5 ? '#'+[...color.slice(1)].map(character => character+character).join('') : color;
  }
  function preview() {
    const mode = $('color-mode').value;
    const color = normalized($('color-hex').value);
    const foreground = mode === 'white' ? '#ffffff' : mode === 'black' ? '#000000' : mode === 'custom' ? color : undefined;
    if (foreground) $('color-preview').style.setProperty('--tracker-status-color', foreground);
    else $('color-preview').style.removeProperty('--tracker-status-color');
    $('color-apply').disabled = busy || mode === 'custom' && !color;
    $('color-status').textContent = mode === 'custom' && !color ? 'HEX 색상을 #abc 또는 #aabbcc 형식으로 입력하세요.' : '';
  }
  function syncInputs() {
    const color = normalized($('color-hex').value);
    if (color) {
      lastValidColor = color;
      $('color-picker').value = color.slice(0, 7);
      const opacity = color.length === 9 ? parseInt(color.slice(7), 16) : 255;
      $('color-opacity').value = String(opacity);
      $('color-opacity-value').textContent = `${Math.round(opacity/255*100)}%`;
    }
    preview();
  }
  function fromPicker() {
    const alpha = Number($('color-opacity').value);
    $('color-hex').value = $('color-picker').value + (alpha < 255 ? alpha.toString(16).padStart(2, '0') : '');
    $('color-mode').value = 'custom';
    syncInputs();
  }
  $('color-hex').addEventListener('input', () => { $('color-mode').value = 'custom';syncInputs(); });
  $('color-picker').addEventListener('input', fromPicker);
  $('color-opacity').addEventListener('input', fromPicker);
  $('color-mode').addEventListener('change', preview);
  $('color-settings').addEventListener('submit', event => {
    event.preventDefault();
    const color = normalized($('color-hex').value) || ($('color-mode').value !== 'custom' ? lastValidColor : undefined);
    if (busy || !color) return;
    busy = true;preview();$('color-status').textContent = '색상 설정을 저장하는 중…';
    vscode.postMessage({type:'save',mode:$('color-mode').value,color,target:$('color-target').value});
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'state') {
      $('color-mode').value = message.mode;
      $('color-hex').value = message.color;
      $('color-target').value = message.target;
      for (const option of $('color-target').options) option.disabled = option.value !== 'user' && !message.hasWorkspace;
      $('color-preview').classList.toggle('no-workspace', !message.hasWorkspace);
      syncInputs();
    } else if (message.type === 'saved' || message.type === 'error') {
      busy = false;preview();
      $('color-status').textContent = message.type === 'saved' ? '색상 설정을 적용했습니다.' : message.message;
    }
  });
  vscode.postMessage({type:'ready'});
})();
