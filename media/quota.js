(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  let current = { states: [], percentage: 'used', detail: 'detailed' };
  const refresh = document.getElementById('refresh');
  const renderDisplayOptions = () => document.querySelectorAll('[data-detail]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.detail === current.detail)));
  const percent = value => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  const resetText = windows => {
    const resets = windows.map(window => window.resetsAt).filter(value => typeof value === 'number' && Number.isFinite(value));
    if (!resets.length) return '';
    const remaining = Math.min(...resets) - Date.now();
    if (remaining <= 0) return '초기화 시각 지남 · 조회 대기';
    const minutes = Math.ceil(remaining / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes % 1440 / 60);
    return `${[days ? `${days}일` : '', hours ? `${hours}시간` : '', `${minutes % 60}분`].filter(Boolean).join(' ')} 후 초기화`;
  };
  function renderCountdowns() {
    for (const provider of ['codex', 'claude']) {
      const state = current.states.find(value => value.provider === provider);
      const windows = state?.snapshot?.windows || [];
      const label = document.querySelector(`#provider-${provider} .availability`);
      label.textContent = !windows.length ? (state?.refreshing ? '조회 중…' : '조회 불가') : resetText(windows);
      label.title = state?.error?.message || '';
    }
  }
  function render() {
    const busy = current.states.some(state => state.refreshing);
    refresh.disabled = busy;
    refresh.setAttribute('aria-busy', String(busy));
    renderDisplayOptions();
    for (const provider of ['codex', 'claude']) {
      const state = current.states.find(value => value.provider === provider);
      const windows = state?.snapshot?.windows || [];
      const section = document.getElementById(`provider-${provider}`);
      const container = section.querySelector('.windows');
      container.replaceChildren(...windows.map(window => {
        const item = document.createElement('div'); item.className = 'quota-window';
        const label = document.createElement('span'); label.className = 'window-label'; label.textContent = window.label;
        const used = percent(window.usedPercent);
        const remaining = 100 - used;
        const bar = document.createElement('progress'); bar.max = 100; bar.value = remaining;
        bar.setAttribute('aria-label', `${window.label} 남은 사용량`);
        bar.setAttribute('aria-valuetext', `${Math.round(remaining)}% 남음`);
        const value = document.createElement('span'); value.textContent = `${Math.round(current.percentage === 'remaining' ? remaining : used)}% ${current.percentage === 'remaining' ? '남음' : '사용'}`;
        item.title = `${window.label}: ${Math.round(remaining)}% 남음${window.resetsAt ? ` · ${new Date(window.resetsAt).toLocaleString()} 초기화` : ''}`;
        item.append(label, bar, value); return item;
      }));
      const stale = section.querySelector('.stale');
      stale.hidden = state?.status !== 'stale';
      stale.textContent = state?.status === 'stale' ? '마지막 조회 값 · 현재 사용량 조회 불가' : '';
    }
    renderCountdowns();
  }
  refresh.addEventListener('click', () => { refresh.disabled = true; vscode.postMessage({ type: 'refreshQuota' }); });
  document.getElementById('open-usage').addEventListener('click', () => vscode.postMessage({ type: 'openUsage' }));
  document.querySelectorAll('.manage').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'manage', provider: button.dataset.provider })));
  document.querySelectorAll('[data-detail]').forEach(button => button.addEventListener('click', () => {
    current.detail = button.dataset.detail; renderDisplayOptions(); vscode.postMessage({ type: 'detail', detail: current.detail });
  }));
  window.addEventListener('message', event => { if (event.data && event.data.type === 'quota') { current = event.data; render(); } });
  setInterval(renderCountdowns, 30000);
  vscode.postMessage({ type: 'ready' });
})();
