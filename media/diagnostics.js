(() => {
  'use strict';
  const t = (key, values) => globalThis.agentTrackerI18n.t(key, values);
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const send = message => vscode.postMessage(message);
  const number = value => value == null ? '—' : new Intl.NumberFormat(globalThis.agentTrackerI18n.language, { maximumFractionDigits: 1 }).format(value);
  let timezone;
  let offset = 0;
  let latestResult;
  const date = value => value == null ? t('common.unknown') : new Intl.DateTimeFormat(globalThis.agentTrackerI18n.language, { dateStyle: 'short', timeStyle: 'medium', timeZone: timezone }).format(new Date(value));
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  /**
   * 책임: 원본 경로·오류 문구가 HTML로 해석되지 않도록 진단 표를 만든다.
   * 알고리즘: 기존 내용을 지운 뒤 머리글·행·셀을 DOM으로 생성하고 외부 값은 textContent로 넣으며 빈 결과는 안내로 대체한다.
   */
  function table(target, headers, rows) {
    target.replaceChildren();
    if (!rows.length) { target.append(element('p', t('common.noRecords'), 'empty')); return; }
    const node = element('table');
    const head = element('thead');
    const headerRow = element('tr');
    for (const header of headers) {
      const cell = element('th', header);
      cell.setAttribute('scope', 'col');
      headerRow.append(cell);
    }
    head.append(headerRow);
    node.append(head);
    const body = element('tbody');
    for (const values of rows) {
      const row = element('tr');
      for (const value of values) row.append(element('td', value ?? '—'));
      body.append(row);
    }
    node.append(body);
    target.append(node);
  }
  /**
   * 책임: 호스트에서 받은 진단 페이지와 이동 가능 상태를 표시한다.
   * 알고리즘: 파일·요약 진단을 textContent 기반 표로 변환하고 count·다음 cursor 존재 여부로 페이지 설명과 버튼을 갱신한다.
   */
  function render(result) {
    const counts = result.counts;
    $('diagnostic-counts').textContent = t('diagnostics.counts', { value0: number(counts.files), value1: number(counts.processing), value2: number(counts.done), value3: number(counts.error), value4: number(counts.interrupted), value5: number(counts.stale_summaries), value6: result.lastRefresh?.error ? t('diagnostics.recentScanSuffix', { value0: result.lastRefresh.error }) : '' });
    table($('diagnostic-files'), [t('diagnostics.providerFile'), t('common.session'), t('diagnostics.statusPosition'), t('diagnostics.recordedAt'), t('common.reason')], result.files.map(row => [`${row.provider} · ${row.path}`, row.session_id, `${row.processing_status} · ${row.processing_position ?? '—'}${row.source_missing ? ` · ${t('diagnostics.sourceMissing')}` : ''}`, date(row.recorded_at), row.last_error]));
    table($('diagnostic-summaries'), [t('diagnostics.projectRequestSession'), t('diagnostics.lastSuccess'), t('diagnostics.quality'), t('diagnostics.sourceByte'), t('common.reason')], result.summaries.map(row => [`${row.project_name} · ${row.root_turn_id} · ${row.session_id}`, date(row.updated_at), row.quality_flags, `${row.diagnostic_file_id ?? '—'} / ${row.diagnostic_offset ?? '—'}`, row.last_error]));
    $('diagnostic-previous').disabled = offset === 0;
    $('diagnostic-next').disabled = !result.nextFileId && !result.nextSummaryId;
    $('diagnostic-page').textContent = t('diagnostics.pageStart', { value0: number(offset + 1) });
  }
  const reload = () => send({ type: 'diagnostics', offset });
  $('settings').addEventListener('click', () => send({ type: 'settings' }));
  $('refresh-diagnostics').addEventListener('click', reload);
  $('diagnostic-previous').addEventListener('click', () => { offset = Math.max(0, offset - 100); reload(); });
  $('diagnostic-next').addEventListener('click', () => { offset += 100; reload(); });
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'state':
        globalThis.updateAgentTrackerLocale?.(message.localization);
        timezone = message.timezone;
        $('configuration-warning').textContent = message.timezoneWarning ?? '';
        $('configuration-warning').hidden = !message.timezoneWarning;
        if (latestResult) render(latestResult);
        break;
      case 'diagnostics': latestResult = message.result; offset = message.offset; $('error').hidden = true; render(message.result); break;
      case 'error': $('error').textContent = message.message; $('error').hidden = false; break;
    }
  });
  send({ type: 'ready' });
})();
