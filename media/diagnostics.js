(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const send = message => vscode.postMessage(message);
  const number = value => value == null ? '—' : new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(value);
  let timezone;
  let offset = 0;
  const date = value => value == null ? '알 수 없음' : new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'medium', timeZone: timezone }).format(new Date(value));
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function table(target, headers, rows) {
    target.replaceChildren();
    if (!rows.length) { target.append(element('p', '표시할 기록이 없습니다.', 'empty')); return; }
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
  function render(result) {
    const counts = result.counts;
    $('diagnostic-counts').textContent = `파일 ${number(counts.files)} · 처리 중 ${number(counts.processing)} · 완료 ${number(counts.done)} · 오류 ${number(counts.error)} · 중단 ${number(counts.interrupted)} · 이전 수치 유지 ${number(counts.stale_summaries)}${result.lastRefresh?.error ? ` · 최근 스캔: ${result.lastRefresh.error}` : ''}`;
    table($('diagnostic-files'), ['제공자 / 파일', '세션', '상태 / 위치', '기록 시각', '원인'], result.files.map(row => [`${row.provider} · ${row.path}`, row.session_id, `${row.processing_status} · ${row.processing_position ?? '—'}`, date(row.recorded_at), row.last_error]));
    table($('diagnostic-summaries'), ['프로젝트 / 요청 / 세션', '마지막 정상 갱신', '품질', '원본 / byte', '원인'], result.summaries.map(row => [`${row.project_name} · ${row.root_turn_id} · ${row.session_id}`, date(row.updated_at), row.quality_flags, `${row.diagnostic_file_id ?? '—'} / ${row.diagnostic_offset ?? '—'}`, row.last_error]));
    $('diagnostic-previous').disabled = offset === 0;
    $('diagnostic-next').disabled = !result.nextFileId && !result.nextSummaryId;
    $('diagnostic-page').textContent = `${number(offset + 1)}번째부터`;
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
        timezone = message.timezone;
        $('configuration-warning').textContent = message.timezoneWarning ?? '';
        $('configuration-warning').hidden = !message.timezoneWarning;
        break;
      case 'diagnostics': offset = message.offset; $('error').hidden = true; render(message.result); break;
      case 'error': $('error').textContent = message.message; $('error').hidden = false; break;
    }
  });
  send({ type: 'ready' });
})();
