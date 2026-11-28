// 상태바 색상 입력과 미리 보기를 갱신하고 설정 저장을 요청한다.
(() => {
  'use strict';
  const t = (key, values) => globalThis.agentTrackerI18n.t(key, values);
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let busy = false;
  let lastValidColor = $('color-hex').value;
  function normalized(value) {
    // [색상 정책] 지원하는 HEX 길이만 받고 축약형은 자리마다 두 번 반복해 펼친다.
    const color = value.trim().toLowerCase();
    if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/.test(color)) return undefined;
    return color.length <= 5 ? '#'+[...color.slice(1)].map(character => character+character).join('') : color;
  }
  function preview() {
    // [미리보기 정책] 색상 모드에 맞춰 전경색을 바꾸고 저장 중이거나 사용자 지정색이 틀리면 적용을 막는다.
    const mode = $('color-mode').value;
    const color = normalized($('color-hex').value);
    const foreground = previewForeground(mode, color);
    if (foreground) $('color-preview').style.setProperty('--tracker-status-color', foreground);
    else $('color-preview').style.removeProperty('--tracker-status-color');
    $('color-apply').disabled = busy || mode === 'custom' && !color;
    $('color-status').textContent = mode === 'custom' && !color ? t('color.invalidHex') : '';
  }
  function previewForeground(mode, color) {
    switch (mode) {
      case 'white': return '#ffffff';
      case 'black': return '#000000';
      case 'custom': return color;
      default: return undefined;
    }
  }
  /**
   * 책임: HEX·색상 견본·불투명도·미리 보기를 같은 값으로 맞춘다.
   * 알고리즘: 유효한 HEX를 정규화해 RGB와 alpha를 나누고 마지막 유효 값을 보관하며 입력 검증 상태와 미리 보기를 다시 계산한다.
   */
  function syncInputs() {
    // [입력 정책] 유효한 HEX에서 RGB와 알파를 분리하고 마지막 유효 색상을 저장한다.
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
  /**
   * 책임: 색상 견본과 투명도 조작을 HEX 입력에 반영한다.
   * 알고리즘: RGB 뒤에 255 미만의 alpha만 두 자리 16진수로 붙이고 사용자 지정 모드로 전환한 뒤 입력을 동기화한다.
   */
  function fromPicker() {
    // [입력 정책] 불투명하지 않을 때만 알파를 HEX 뒤에 붙여 사용자 지정 모드로 바꾼다.
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
    // [저장 정책] 사용자 지정 외 모드는 마지막 유효 색상을 재사용하고 저장 응답까지 중복 요청을 막는다.
    const color = normalized($('color-hex').value) || ($('color-mode').value !== 'custom' ? lastValidColor : undefined);
    if (busy || !color) return;
    busy = true;preview();$('color-status').textContent = t('color.saving');
    vscode.postMessage({type:'save',mode:$('color-mode').value,color,target:$('color-target').value});
  });
  window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
      case 'state':
        // [설정 범위 정책] 호스트 설정을 적용하고 열린 작업공간이 없으면 작업공간 저장을 막는다.
        globalThis.updateAgentTrackerLocale?.(message.localization);
        $('color-mode').value = message.mode;
        $('color-hex').value = message.color;
        $('color-target').value = message.target;
        for (const option of $('color-target').options) option.disabled = option.value !== 'user' && !message.hasWorkspace;
        $('color-preview').classList.toggle('no-workspace', !message.hasWorkspace);
        syncInputs();
        break;
      case 'saved': case 'error':
        busy = false;preview();
        $('color-status').textContent = message.type === 'saved' ? t('color.saved') : message.message;
        break;
    }
  });
  vscode.postMessage({type:'ready'});
})();
