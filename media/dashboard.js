(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const send = message => vscode.postMessage(message);
  const number = value => value === null || value === undefined ? '—' : new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(value);
  const duration = value => value === null || value === undefined ? '—' : value < 1000 ? `${number(value)} ms` : `${number(value / 1000)}초`;
  let timezone;
  const date = value => value === null || value === undefined ? '알 수 없음' : new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'medium', timeZone: timezone }).format(new Date(value));
  let offset = 0;
  let diagnosticOffset = 0;
  let latestUsage;
  const saved = vscode.getState();
  if (saved && ['day', 'month', 'project', 'session', 'turn', 'all'].includes(saved.group)) $('group').value = saved.group;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function tab(name, notify = true) {
    if (!['usage', 'diagnostics'].includes(name)) return;
    if (name === 'diagnostics') diagnosticOffset = 0;
    for (const item of ['usage', 'diagnostics']) $(item).hidden = item !== name;
    document.querySelectorAll('[data-tab]').forEach(node => {
      if (node.dataset.tab === name) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    });
    if (notify) send({ type: 'tab', tab: name });
  }
  function query() {
    const request = { groupBy: $('group').value, offset };
    if ($('provider').value) request.provider = $('provider').value;
    if ($('project-key').value.trim()) request.projectKey = $('project-key').value.trim();
    if ($('session-id').value.trim()) request.sessionId = $('session-id').value.trim();
    if ($('from-day').value) request.fromDay = $('from-day').value;
    if ($('to-day').value) request.toDay = $('to-day').value;
    send({ type: 'queryUsage', query: request });
    vscode.setState({ group: request.groupBy });
  }
  function table(target, headers, rows) {
    target.replaceChildren();
    if (!rows.length) { target.append(element('p', '표시할 기록이 없습니다.', 'empty')); return; }
    const node = element('table');
    const head = element('thead');
    const tr = element('tr');
    for (const header of headers) tr.append(element('th', header));
    head.append(tr);
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
  function renderUsage(result) {
    latestUsage = result;
    const turn = result.groupBy === 'turn';
    const rows = result.rows;
    if (turn) {
      table($('usage-table'), ['제공자 / 프로젝트', '요청 / 세션', '시작 시각', '입력', '출력', '총 토큰', '소요 시간', '상태 / 품질'], rows.map(row => [
        `${row.provider} / ${row.project_name}`, `${row.root_turn_id} / ${row.session_id}`, date(row.started_at_ms), number(row.input_tokens), number(row.output_tokens), number(row.total_tokens), duration(row.duration_ms), `${row.status === 'completed' ? '완료' : '진행 중'} · ${row.duration_quality}${row.quality_flags ? ` · ${row.quality_flags}` : ''}${row.last_error ? ` · 이전 값: ${row.last_error}` : ''}`,
      ]));
    } else {
      table($('usage-table'), ['제공자', '기간 / 프로젝트 / 세션', '입력', '출력', '총 토큰', '완료 / 전체 요청', '평균 토큰', '평균 시간 / 표본'], rows.map(row => [
        row.provider, row.period ?? row.session_id ?? (row.project_name ? `${row.project_name} (${row.project_key})` : ['day', 'month'].includes(result.groupBy) ? '시각 미상' : '전체'), number(row.input_tokens), number(row.output_tokens), number(row.total_tokens), `${number(row.completed_turns)} / ${number(row.turn_count)}`, number(row.avg_tokens_per_turn), `${duration(row.avg_duration_ms)} / ${number(row.turns_with_duration)}개`,
      ]));
    }
    $('previous').disabled = offset === 0;
    $('next').disabled = offset + rows.length >= result.total;
    $('page-label').textContent = result.total ? `${number(offset + 1)}–${number(offset + rows.length)} / ${number(result.total)}` : '0개';
    const coverage = result.coverage;
    const durationCoverage = turn ? '' : ` · 시간 품질(현재 페이지) 정확 ${number(rows.reduce((n, r) => n + (r.exact_duration_turns ?? 0), 0))} / 계산 ${number(rows.reduce((n, r) => n + (r.derived_duration_turns ?? 0), 0))} / 근사 ${number(rows.reduce((n, r) => n + (r.approximate_duration_turns ?? 0), 0))} / 미상 ${number(rows.reduce((n, r) => n + (r.missing_duration_turns ?? 0), 0))}`;
    $('coverage').textContent = `파일 ${number(coverage.files)} · 정상 ${number(coverage.done)} · 오류 ${number(coverage.error)} · 중단 ${number(coverage.interrupted)} · 이전 수치 유지 요청 ${number(coverage.stale_summaries)}${durationCoverage}`;
  }
  function renderDiagnostics(result) {
    const counts = result.counts;
    $('diagnostic-counts').textContent = `파일 ${number(counts.files)} · 처리 중 ${number(counts.processing)} · 완료 ${number(counts.done)} · 오류 ${number(counts.error)} · 중단 ${number(counts.interrupted)} · 이전 수치 유지 ${number(counts.stale_summaries)}${result.lastRefresh?.error ? ` · 최근 스캔: ${result.lastRefresh.error}` : ''}`;
    table($('diagnostic-files'), ['제공자 / 파일', '세션', '상태 / 위치', '기록 시각', '원인'], result.files.map(row => [`${row.provider} · ${row.path}`, row.session_id, `${row.processing_status} · ${row.processing_position ?? '—'}`, date(row.recorded_at), row.last_error]));
    table($('diagnostic-summaries'), ['프로젝트 / 요청 / 세션', '마지막 정상 갱신', '품질', '원본 / byte', '원인'], result.summaries.map(row => [`${row.project_name} · ${row.root_turn_id} · ${row.session_id}`, date(row.updated_at), row.quality_flags, `${row.diagnostic_file_id ?? '—'} / ${row.diagnostic_offset ?? '—'}`, row.last_error]));
    $('diagnostic-previous').disabled = diagnosticOffset === 0;
    $('diagnostic-next').disabled = !result.nextFileId && !result.nextSummaryId;
    $('diagnostic-page').textContent = `${number(diagnosticOffset + 1)}번째부터`;
  }
  document.querySelectorAll('[data-tab]').forEach(node => node.addEventListener('click', () => tab(node.dataset.tab)));
  $('settings').addEventListener('click', () => send({ type: 'settings' }));
  $('cancel-usage').addEventListener('click', () => send({ type: 'cancelUsage' }));
  $('usage-filters').addEventListener('submit', event => { event.preventDefault(); offset = 0; query(); });
  $('previous').addEventListener('click', () => { offset = Math.max(0, offset - 100); query(); });
  $('next').addEventListener('click', () => { offset += 100; query(); });
  const diagnostics = () => send({ type: 'diagnostics', offset: diagnosticOffset });
  $('refresh-diagnostics').addEventListener('click', diagnostics);
  $('diagnostic-previous').addEventListener('click', () => { diagnosticOffset = Math.max(0, diagnosticOffset - 100); diagnostics(); });
  $('diagnostic-next').addEventListener('click', () => { diagnosticOffset += 100; diagnostics(); });
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'state': timezone = message.timezone; $('timezone').textContent = `집계 시간대: ${timezone}`; $('configuration-warning').textContent = message.timezoneWarning ?? ''; $('configuration-warning').hidden = !message.timezoneWarning; if (latestUsage) renderUsage(latestUsage); break;
      case 'navigate': tab(message.tab, false); break;
      case 'usage': $('error').hidden = true; renderUsage(message.result); break;
      case 'diagnostics': diagnosticOffset = message.offset; renderDiagnostics(message.result); break;
      case 'busy': $('cancel-usage').hidden = !message.busy; if (message.busy) $('usage-progress').textContent = '기록을 갱신하고 있습니다…'; break;
      case 'progress': { const p = message.progress; $('usage-progress').textContent = `${({ scanning: '파일 확인', parsing: '요청 집계', committing: '통계 저장', complete: '완료' })[p.phase] ?? p.phase} · 발견 ${number(p.discovered)} · 읽음 ${number(p.parsed)} · 실패 ${number(p.failed)}`; break; }
      case 'refreshResult': { const r = message.result; $('usage-progress').textContent = `${r.interrupted ? '중단됨' : r.failed ? '일부 실패 · 이전 정상 통계를 유지했습니다' : '갱신 완료'} · 발견 ${number(r.discovered)} · 읽음 ${number(r.parsed)} · 재사용 ${number(r.reused)} · 실패 ${number(r.failed)} · 읽은 데이터 ${number(r.bodyBytes)} bytes${r.error ? ` · 원인: ${r.error}` : ''}`; break; }
      case 'error': $('error').textContent = message.message; $('error').hidden = false; break;
    }
  });
  // Restore the query before ready so the initial scan returns the selected group.
  query();
  send({ type: 'ready' });
})();
