(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const send = message => vscode.postMessage(message);
  const number = value => value === null || value === undefined ? '—' : new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(value);
  const duration = value => value === null || value === undefined ? '—' : value < 1000 ? `${number(value)} ms` : `${number(value / 1000)}초`;
  const tokenHeaders = [
    { label: 'Input', title: '캐시 읽기·쓰기를 제외한 입력 토큰' },
    { label: 'Output', title: '생성한 출력 토큰' },
    { label: 'Cache Write', title: '새 캐시를 생성하며 기록한 입력 토큰' },
    { label: 'Cache Read', title: '기존 캐시에서 재사용한 입력 토큰' },
  ];
  const tokenValues = row => [
    number(row.input_tokens == null || row.cache_write_input_tokens == null || row.cache_read_input_tokens == null
      ? null : Math.max(0, row.input_tokens - row.cache_write_input_tokens - row.cache_read_input_tokens)),
    number(row.output_tokens), number(row.cache_write_input_tokens), number(row.cache_read_input_tokens),
  ];
  const chartMetrics = { tokens: '총 토큰', requests: '요청 수', averageTokens: '평균 토큰', averageDuration: '평균 시간' };
  let timezone;
  const date = value => value === null || value === undefined ? '알 수 없음' : new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'medium', timeZone: timezone }).format(new Date(value));
  let offset = 0;
  let chartBy = 'provider';
  let showCosts = false;
  let section = 'tokens';
  let capabilitiesEnabled = true;
  const capabilityCategories = ['skill', 'subagent', 'plugin', 'model'];
  const capabilityOffsets = { skill: 0, subagent: 0, plugin: 0, model: 0 };
  let latestUsage;
  let selectedProject;
  let selectedSession;
  let openNameKind;
  let nameRequestId = 0;
  const namePages = { project: { loaded: 0, total: 0 }, session: { loaded: 0, total: 0 } };
  const saved = vscode.getState();
  if (saved && ['day', 'month', 'project', 'session', 'turn', 'all'].includes(saved.group)) $('group').value = saved.group;
  if (saved && Object.hasOwn(chartMetrics, saved.chartMetric)) $('chart-metric').value = saved.chartMetric;
  if (saved?.chartBy === 'model') chartBy = 'model';
  if (saved?.section === 'skills') section = 'skills';

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function query(resetCapabilities = true) {
    if (resetCapabilities) for (const category of capabilityCategories) capabilityOffsets[category] = 0;
    $('token-section').hidden = section !== 'tokens';
    $('skill-section').hidden = section !== 'skills';
    $('group-control').hidden = section !== 'tokens';
    $('chart-by-control').hidden = section !== 'tokens';
    for (const name of ['tokens', 'skills']) $(`section-${name}`).setAttribute('aria-pressed', String(section === name));
    const request = { section, groupBy: $('group').value, offset, chartBy };
    if (section === 'skills') request.capabilityOffsets = { ...capabilityOffsets };
    const metric = $('chart-metric').value || 'tokens';
    request.chartMetric = request.groupBy === 'turn' && metric !== 'averageDuration' ? 'tokens' : metric;
    $('chart-metric').value = request.chartMetric;
    if ($('provider').value) request.provider = $('provider').value;
    if (selectedProject) request.projectKey = selectedProject;
    if (selectedSession) request.sessionId = selectedSession;
    if ($('from-day').value) request.fromDay = $('from-day').value;
    if ($('to-day').value) request.toDay = $('to-day').value;
    send({ type: 'queryUsage', query: request });
    saveState();
    updateCostControls();
    $('billing-mode').disabled = true;
    for (const by of ['provider', 'model']) $(`chart-${by}`).setAttribute('aria-pressed', String(chartBy === by));
  }
  function updateCostControls() {
    $('cost-note').hidden = !showCosts;
    $('billing-control').hidden = !showCosts || !selectedSession || !$('provider').value;
  }
  function saveState() {
    vscode.setState({ section, group: $('group').value, chartMetric: $('chart-metric').value, chartBy });
  }
  function nameCaption(kind, text, title = '') {
    $(`${kind}-name`).textContent = text || (kind === 'project' ? '전체 프로젝트' : '전체 세션');
    $(`${kind}-name`).title = title;
  }
  function closeNames(focus = false) {
    const previous = openNameKind;
    openNameKind = undefined;
    for (const kind of ['project', 'session']) {
      $(`${kind}-options`).hidden = true;
      $(`${kind}-name`).setAttribute('aria-expanded', 'false');
      $(`${kind}-list`).replaceChildren();
      namePages[kind].pending = undefined;
    }
    if (focus && previous) $(`${previous}-name`).focus();
  }
  function chooseProject(row) {
    selectedProject = row?.project_key;
    selectedSession = undefined;
    nameCaption('project', row ? row.project_name || '이름 없는 프로젝트' : '', row?.project_key);
    nameCaption('session', '');
    closeNames(true); offset = 0; query();
  }
  function chooseSession(row) {
    selectedSession = row?.session_id;
    if (row) {
      selectedProject = row.project_key;
      nameCaption('project', row.project_name || '이름 없는 프로젝트', row.project_key);
      $('provider').value = row.provider;
    }
    nameCaption('session', row ? row.session_name || '이름 없는 세션' : '', row ? `세션 ID: ${row.session_id}` : '');
    closeNames(true); offset = 0; query();
  }
  function loadNames(kind) {
    const page = namePages[kind];
    if (openNameKind !== kind || page.pending !== undefined) return;
    const request = { kind, offset: page.loaded };
    if ($('provider').value) request.provider = $('provider').value;
    if (kind === 'session' && selectedProject) request.projectKey = selectedProject;
    page.pending = ++nameRequestId;
    $(`${kind}-list-status`).textContent = '목록을 불러오는 중…';
    send({ type: 'queryNames', query: request, requestId: page.pending });
  }
  function nameOption(kind, row) {
    const title = kind === 'project' ? row?.project_name || '이름 없는 프로젝트' : row?.session_name || '이름 없는 세션';
    const node = element('button', row ? title : kind === 'project' ? '전체 프로젝트' : '전체 세션', 'name-option');
    node.type = 'button';
    const selected = row ? kind === 'project' ? selectedProject === row.project_key
      : selectedProject === row.project_key && selectedSession === row.session_id && $('provider').value === row.provider
      : kind === 'project' ? !selectedProject : !selectedSession;
    node.setAttribute('aria-pressed', String(selected));
    if (row) {
      node.title = `${row.project_key}${row.session_id ? `\n세션 ID: ${row.session_id}` : ''}`;
      node.append(element('span', kind === 'project' ? row.project_key
        : `${providerLabel(row.provider)} · ${row.project_name} · ${date(row.session_started_at_ms)}`, 'muted'));
    }
    node.addEventListener('click', () => kind === 'project' ? chooseProject(row) : chooseSession(row));
    return node;
  }
  function toggleNames(kind) {
    if (openNameKind === kind) { closeNames(); return; }
    closeNames(); openNameKind = kind;
    namePages[kind] = { loaded: 0, total: 0 };
    $(`${kind}-options`).hidden = false;
    $(`${kind}-options`).scrollTop = 0;
    $(`${kind}-name`).setAttribute('aria-expanded', 'true');
    $(`${kind}-list`).append(nameOption(kind));
    loadNames(kind);
  }
  function renderNames(message) {
    const kind = message.kind;
    const page = namePages[kind];
    if (openNameKind !== kind || !page || page.pending !== message.requestId) return;
    page.pending = undefined;
    if (message.error) { $(`${kind}-list-status`).textContent = message.error; return; }
    for (const row of message.result.rows) $(`${kind}-list`).append(nameOption(kind, row));
    page.loaded += message.result.rows.length;
    page.total = message.result.total;
    $(`${kind}-list-status`).textContent = page.total ? `${number(page.loaded)} / ${number(page.total)}개${page.loaded < page.total ? ' · 아래로 스크롤하면 계속 표시합니다.' : ''}` : '선택할 기록이 없습니다.';
    const list = $(`${kind}-options`);
    if (message.result.rows.length && page.loaded < page.total && list.scrollHeight <= list.clientHeight) loadNames(kind);
  }
  function table(target, headers, rows) {
    target.replaceChildren();
    if (!rows.length) { target.append(element('p', '표시할 기록이 없습니다.', 'empty')); return; }
    const node = element('table');
    const head = element('thead');
    const tr = element('tr');
    for (const header of headers) {
      const cell = element('th', typeof header === 'string' ? header : header.label);
      cell.setAttribute('scope', 'col');
      if (typeof header !== 'string') cell.title = header.title;
      tr.append(cell);
    }
    head.append(tr);
    node.append(head);
    const body = element('tbody');
    for (const values of rows) {
      const row = element('tr');
      for (const value of values) {
        const cell = element('td');
        if (value && typeof value === 'object') cell.append(value);
        else cell.textContent = String(value ?? '—');
        row.append(cell);
      }
      body.append(row);
    }
    node.append(body);
    target.append(node);
  }
  function tableLabel(text) {
    const node = element('span', text, 'table-label');
    node.title = String(text);
    return node;
  }
  const requestLabel = row => row.request_title || row.session_name || '제목 없음';
  function projectLabel(row) {
    const name = row.project_name || '이름 없는 프로젝트';
    const node = element('button', undefined, 'name-filter');
    node.append(tableLabel(name));
    node.type = 'button';
    node.title = `${name}\n${row.project_key || ''}`;
    node.addEventListener('click', () => chooseProject(row));
    return node;
  }
  function sessionLabel(row, request = false) {
    const label = tableLabel(request ? requestLabel(row) : `${row.project_name || '이름 없는 프로젝트'} / ${row.session_name || '이름 없는 세션'}`);
    const node = element('button', undefined, 'name-filter');
    node.type = 'button';
    node.title = `${label.textContent}\n${row.session_name || ''}\n${row.project_key || ''}\n세션 ID: ${row.session_id}${request ? `\n요청 ID: ${row.root_turn_id}` : ''}`;
    label.append(element('span', request ? row.session_name || '이름 없는 세션' : date(row.session_started_at_ms), 'muted session-start'));
    node.append(label);
    node.addEventListener('click', () => chooseSession(row));
    return node;
  }
  function svgElement(tag, attributes = {}, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const providerLabel = provider => provider === 'claude' ? 'Claude' : 'Codex';
  const providerClass = provider => `chart-provider-${provider}`;
  const modelLabel = row => row.other_models ? `기타 모델 (${providerLabel(row.provider)})`
    : (row.model || '미상').replace(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d{8})?$/, '$1$2.$3');
  const seriesLabel = row => row.model !== undefined ? modelLabel(row) : providerLabel(row.provider);
  function providerMarker(provider, attributes = {}) {
    return svgElement('rect', { width: 8, height: 8, class: `provider-marker ${providerClass(provider)}`, 'aria-hidden': 'true', ...attributes });
  }
  function modelName(row, suffix = '') {
    const node = element('span', undefined, 'model-name');
    node.title = providerLabel(row.provider);
    const marker = svgElement('svg', { width: 8, height: 8, role: 'img', 'aria-label': providerLabel(row.provider) });
    marker.append(providerMarker(row.provider));
    node.append(marker, suffix ? tableLabel(`${modelLabel(row)}${suffix}`) : element('span', modelLabel(row)));
    return node;
  }
  const compact = value => value == null ? '—' : new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const compactDuration = value => value == null || value < 1000 ? duration(value) : `${compact(value / 1000)}초`;
  function chartValue(row, metric, turn) {
    if (turn) return metric === 'averageDuration' ? row.duration_ms : row.total_tokens;
    return row[({ tokens: 'total_tokens', requests: 'turn_count', averageTokens: 'avg_tokens_per_turn', averageDuration: 'avg_duration_ms' })[metric]];
  }
  function chartLabel(row, mode) {
    const provider = seriesLabel(row);
    if (mode === 'turn') return `${provider} · ${date(row.started_at_ms)} · ${row.session_name || '이름 없는 세션'} · ${requestLabel(row)} (${row.root_turn_id})`;
    if (mode === 'calendar') return `${row.period || '시각 미상'} · ${provider}`;
    if (mode === 'total') return provider;
    return `${provider} · ${row.project_name || '이름 없는 프로젝트'}${row.session_id ? ` / ${row.session_name || '이름 없는 세션'}` : ''}`;
  }
  function chartSegments(row) {
    if (row.cache_write_input_tokens == null || row.cache_read_input_tokens == null) return [{ value: row.total_tokens, className: 'chart-unknown', label: '총 토큰 (구성 미확인)' }];
    return [Math.max(0, row.input_tokens - row.cache_write_input_tokens - row.cache_read_input_tokens), row.output_tokens,
      row.cache_write_input_tokens, row.cache_read_input_tokens].map((value, index) => ({ value, className: `chart-series-${index}`, label: tokenHeaders[index].label }));
  }
  function chartDescription(row, chart) {
    const turn = chart.mode === 'turn';
    const value = chartValue(row, chart.metric, turn);
    let detail = `${chartLabel(row, chart.mode)} · ${chart.metric === 'averageDuration' ? duration(value) : `${number(value)} ${chart.metric === 'requests' ? '개' : '토큰'}`}`;
    if (chart.metric === 'tokens') {
      detail += row.cache_write_input_tokens == null || row.cache_read_input_tokens == null ? ' · 구성 미확인'
        : ` · ${tokenHeaders.map((header, index) => `${header.label} ${tokenValues(row)[index]}`).join(' / ')}`;
    }
    if (chart.metric === 'requests') detail += ` · 완료 ${number(row.completed_turns)}개`;
    if (chart.metric === 'averageDuration' && !turn) detail += ` · 시간 표본 ${number(row.turns_with_duration)}개`;
    if (chart.metric === 'averageTokens') detail += ` · 완료 요청 ${number(row.completed_turns)}개`;
    if (chart.mode === 'ranking' && row.session_id) detail += ` · 세션 ID: ${row.session_id}`;
    if (turn) detail += ` · ${row.status === 'completed' ? '완료' : row.status === 'failed' ? '실패' : '진행 중'} · ${row.duration_quality}`;
    if (chart.by === 'model' && chart.metric === 'averageDuration') detail += ' · 해당 모델을 포함한 요청 전체의 시간';
    return detail;
  }
  function renderChart(result) {
    const chart = result.chart;
    const plot = $('usage-chart');
    const legend = $('chart-legend');
    plot.replaceChildren();
    legend.replaceChildren();
    legend.hidden = true;
    $('chart-detail').textContent = '';
    if (!chart) return;
    const turn = chart.mode === 'turn';
    const metric = chart.metric;
    $('chart-metric').value = metric;
    for (const option of $('chart-metric').options) {
      option.disabled = turn && ['requests', 'averageTokens'].includes(option.value);
      if (option.value === 'averageDuration') option.textContent = turn ? '소요 시간' : '평균 시간';
    }
    const title = turn && metric === 'averageDuration' ? '요청별 소요 시간' : chartMetrics[metric];
    $('chart-title').textContent = title;
    const rows = chart.rows;
    const pageRange = result.rows.length ? `${number(offset + 1)}–${number(offset + result.rows.length)} / 전체 ${number(result.total)}개` : '0개';
    $('chart-scope').textContent = `현재 표 ${pageRange} · 표 페이지와 연동`;
    if (rows.length < result.rows.length) $('chart-scope').textContent += ` · 사용량 없는 항목 ${number(result.rows.length - rows.length)}개 제외`;
    if (chart.by === 'model') $('chart-scope').textContent += ' · 모델별 · 여러 모델을 쓴 요청은 각 모델에 포함';
    if (!rows.length) { plot.append(element('p', '표시할 기록이 없습니다.', 'empty')); return; }
    if (metric === 'tokens') {
      const entries = tokenHeaders.map((header, index) => ({ ...header, className: `chart-series-${index}` }));
      if (rows.some(row => row.cache_write_input_tokens == null || row.cache_read_input_tokens == null)) {
        entries.push({ label: '구성 미확인', title: '토큰 구성을 확인할 수 없는 총 토큰', className: 'chart-unknown' });
      }
      for (const entry of entries) {
        const item = element('li');
        item.title = entry.title;
        const swatch = svgElement('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' });
        swatch.append(svgElement('rect', { width: 12, height: 12, rx: 2, class: entry.className }));
        item.append(swatch, element('span', entry.label));
        legend.append(item);
      }
      legend.hidden = false;
    }
    const sessions = chart.mode === 'ranking' && result.groupBy === 'session';
    const projects = chart.mode === 'ranking' && result.groupBy === 'project';
    const vertical = chart.mode === 'calendar' || turn || sessions || projects;
    const categoryKey = (row, index) => turn ? String(index) : sessions ? `${row.provider}/${row.project_key}/${row.session_id}` : projects ? `${row.provider}/${row.project_key}` : row.period;
    const categories = vertical ? [...new Set(rows.map(categoryKey))] : [];
    const maxPeers = vertical && !turn ? Math.max(1, ...categories.map(category => rows.filter((row, index) => categoryKey(row, index) === category).length)) : 1;
    const categoryWidth = Math.max(turn || sessions || projects ? 164 : 128, maxPeers * 46 + 36);
    const width = Math.max(plot.clientWidth || 736, 736, vertical ? 86 + categories.length * categoryWidth : 0);
    const height = vertical ? chart.by === 'model' ? 414 : 372 : 62 + rows.length * 62;
    const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg', role: 'group', 'aria-label': `${title} · ${$('chart-scope').textContent}` });
    svg.append(svgElement('title', {}, `${title} 사용량 도표`));
    const max = Math.max(1, ...rows.map(row => chartValue(row, metric, turn) ?? 0));
    const maximum = max === 1 ? 1 : Math.ceil(max / (10 ** Math.floor(Math.log10(max)))) * (10 ** Math.floor(Math.log10(max)));
    const left = vertical ? 70 : 0;
    const top = vertical ? 28 : 26;
    const length = vertical ? 224 : width - 96;
    const tick = value => metric === 'averageDuration' ? compactDuration(value) : compact(value);
    svg.append(svgElement('text', { x: left, y: 14, class: 'chart-axis-label' }, metric === 'averageDuration' ? '시간' : metric === 'requests' ? '요청 수 (개)' : '토큰'));
    for (let index = 0; index <= 4; index++) {
      const ratio = index / 4;
      if (vertical) {
        const y = top + length * (1 - ratio);
        svg.append(svgElement('line', { x1: left, x2: width - 16, y1: y, y2: y, class: 'chart-grid' }),
          svgElement('text', { x: left - 8, y: y + 4, 'text-anchor': 'end', class: 'chart-axis-label' }, tick(maximum * ratio)));
      } else {
        const x = left + length * ratio;
        svg.append(svgElement('line', { x1: x, x2: x, y1: top, y2: height - 16, class: 'chart-grid' }),
          svgElement('text', { x, y: top - 5, 'text-anchor': index === 0 ? 'start' : 'middle', class: 'chart-axis-label' }, tick(maximum * ratio)));
      }
    }
    if (vertical) {
      categories.forEach((category, index) => {
        const x = left + (width - left - 16) * (index + .5) / categories.length;
        const row = rows.find((row, rowIndex) => categoryKey(row, rowIndex) === category);
        const shortened = text => text.length > 16 ? `${text.slice(0, 15)}…` : text;
        const label = turn ? shortened(requestLabel(row)) : sessions ? shortened(row.session_name || '이름 없는 세션') : projects ? shortened(row.project_name || '이름 없는 프로젝트') : category || '시각 미상';
        const parts = turn ? [label] : label.split(' ~ ');
        const labelY = chart.by === 'model' ? 352 : 292;
        const caption = svgElement('text', { x, y: labelY, 'text-anchor': 'middle', class: 'chart-axis-label' }, parts[0]);
        if (turn) caption.append(svgElement('title', {}, requestLabel(row)));
        svg.append(caption);
        if (parts[1]) svg.append(svgElement('text', { x, y: labelY + 16, 'text-anchor': 'middle', class: 'chart-axis-label' }, `~ ${parts[1]}`));
        if (turn) {
          svg.append(svgElement('text', { x, y: labelY + 16, 'text-anchor': 'middle', class: 'chart-axis-label' }, row.started_at_ms == null ? '시각 미상'
            : new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone }).format(new Date(row.started_at_ms))));
        }
        if (sessions) svg.append(svgElement('text', { x, y: labelY + 16, 'text-anchor': 'middle', class: 'chart-axis-label' }, shortened(row.project_name || '이름 없는 프로젝트')));
      });
    }
    rows.forEach((row, index) => {
      const value = chartValue(row, metric, turn);
      const description = chartDescription(row, chart);
      const group = svgElement('g', { class: 'chart-bar', tabindex: 0, role: 'img', 'aria-label': row.model === undefined ? description : `${providerLabel(row.provider)} · ${description}` });
      group.append(svgElement('title', {}, description));
      const peers = vertical && !turn ? rows.filter((peer, peerIndex) => categoryKey(peer, peerIndex) === categoryKey(row, index)) : [row];
      const categoryIndex = categories.indexOf(categoryKey(row, index));
      const center = left + (width - left - 16) * (categoryIndex + .5) / Math.max(1, categories.length);
      const x = vertical ? center + (peers.indexOf(row) - (peers.length - 1) / 2) * 46 - 18 : left;
      const y = vertical ? top + length : 58 + index * 62;
      const barSize = vertical ? 36 : 22;
      group.append(svgElement('rect', { x: vertical ? x - 4 : x, y: vertical ? top : y - 20,
        width: vertical ? barSize + 8 : width, height: vertical ? length + 32 : 52, class: 'chart-hit' }));
      const segments = metric === 'tokens' ? chartSegments(row) : [{ value, className: 'chart-measure' }];
      let consumed = 0;
      for (const segment of segments) {
        if (segment.value == null || segment.value <= 0) continue;
        const size = segment.value / maximum * length;
        const mark = svgElement('rect', { x: vertical ? x : x + consumed, y: vertical ? y - consumed - size : y,
          width: vertical ? barSize : size, height: vertical ? size : barSize, class: `chart-segment ${segment.className}` });
        if (metric === 'tokens') {
          const detail = `${chartLabel(row, chart.mode)} · ${segment.label}: ${number(segment.value)} 토큰`;
          mark.append(svgElement('title', {}, detail));
          mark.setAttribute('aria-label', detail);
          mark.addEventListener('mouseenter', () => { $('chart-detail').textContent = detail; });
          mark.addEventListener('mouseleave', () => { $('chart-detail').textContent = description; });
        }
        group.append(mark);
        consumed += size;
      }
      if (value === 0) group.append(svgElement('line', { x1: x, x2: x + (vertical ? barSize : 2), y1: y, y2: y + (vertical ? 0 : barSize), class: 'chart-grid' }));
      const displayValue = metric === 'averageDuration' ? compactDuration(value) : compact(value);
      group.append(svgElement('text', { x: vertical ? x + barSize / 2 : x + consumed + 8,
        y: vertical ? y - consumed - 8 : y + 16, 'text-anchor': vertical ? 'middle' : 'start', class: 'chart-value' }, displayValue));
      if (vertical) {
        if (row.model !== undefined) {
          const label = modelLabel(row);
          const name = svgElement('g', { transform: `translate(${x + barSize / 2} 274) rotate(35)` });
          name.append(providerMarker(row.provider, { x: 0, y: -8 }),
            svgElement('text', { x: 14, y: 0, 'text-anchor': 'start', class: 'chart-provider' }, label.length > 18 ? `${label.slice(0,17)}…` : label));
          group.append(name);
        } else group.append(svgElement('text', { x: x + barSize / 2, y: 274, 'text-anchor': 'middle', class: 'chart-provider' }, providerLabel(row.provider)));
      }
      else {
        const label = chartLabel(row, chart.mode);
        if (row.model !== undefined) group.append(providerMarker(row.provider, { x, y: y - 14 }));
        group.append(svgElement('text', { x: x + (row.model === undefined ? 0 : 14), y: y - 6, class: 'chart-label' }, label.length > 48 ? `${label.slice(0, 47)}…` : label));
      }
      const showDetail = () => { $('chart-detail').textContent = description; };
      group.addEventListener('mouseenter', showDetail);
      group.addEventListener('focus', showDetail);
      group.addEventListener('click', showDetail);
      svg.append(group);
    });
    plot.append(svg);
    $('chart-detail').textContent = chartDescription(rows[0], chart);
  }
  function renderUsage(result) {
    latestUsage = result;
    if (result.capabilitiesEnabled !== undefined) setCapabilitiesEnabled(result.capabilitiesEnabled);
    if (section === 'skills' && !capabilitiesEnabled) return;
    if (result.capabilities) {
      for (const category of capabilityCategories) {
        const page = result.capabilities[category];
        const maximum = Math.max(1, ...(page.chartRows ?? page.rows).map(row => row.usage_count));
        table($(`${category}-table`), ['제공자', '이름', '사용 횟수', '전체 비율'],
          page.rows.map(row => [providerLabel(row.provider), row.name || '미상', number(row.usage_count), capabilityRatio(row, maximum, page.totalUses)]));
        $(`${category}-total`).textContent = `전체 ${number(page.totalUses)}회`;
        $(`${category}-previous`).disabled = capabilityOffsets[category] === 0;
        $(`${category}-next`).disabled = capabilityOffsets[category] + page.rows.length >= page.total;
        $(`${category}-page`).textContent = page.total ? `${number(capabilityOffsets[category] + 1)}–${number(capabilityOffsets[category] + page.rows.length)} / ${number(page.total)}` : '0개';
      }
      return;
    }
    renderChart(result);
    const costHeaders = showCosts ? ['API 추정 비용 (USD)'] : [];
    const cost = row => {
      if (!showCosts) return [];
      const value = row.billing_mode === 'subscription' ? '0원 (구독)' : row.cost_usd == null ? '—'
        : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(row.cost_usd);
      return [`${value}${row.unknown_costs ? ` · 미확인 ${number(row.unknown_costs)}건` : ''}`];
    };
    if (result.billing && selectedSession && showCosts) {
      $('billing-mode').value = result.billing;
      $('billing-mode').disabled = false;
    }
    const turn = result.groupBy === 'turn';
    const model = result.by === 'model';
    $('model-note').hidden = !model;
    const identity = (row, suffix = '') => model ? modelName(row, suffix) : `${providerLabel(row.provider)}${suffix}`;
    const scopeLabel = row => row.period != null ? tableLabel(row.period) : row.session_id ? sessionLabel(row)
      : row.project_key ? projectLabel(row) : tableLabel(['day', 'month'].includes(result.groupBy) ? '시각 미상' : '전체');
    const rows = result.rows;
    if (turn) {
      table($('usage-table'), [`${model ? '모델' : '제공자'} / 프로젝트`, '요청 / 세션', '시작 시각', ...tokenHeaders, '총 토큰', '소요 시간', '상태 / 품질', ...costHeaders], rows.map(row => [
        model ? identity(row, ` / ${row.project_name}`) : tableLabel(identity(row, ` / ${row.project_name}`)), sessionLabel(row, true), date(row.started_at_ms), ...tokenValues(row), number(row.total_tokens), duration(row.duration_ms), `${row.status === 'completed' ? '완료' : row.status === 'failed' ? '실패' : '진행 중'} · ${row.duration_quality}${row.quality_flags ? ` · ${row.quality_flags}` : ''}${row.last_error ? ` · 이전 값: ${row.last_error}` : ''}`, ...cost(row),
      ]));
    } else {
      table($('usage-table'), [model ? '모델' : '제공자', '기간 / 프로젝트 / 세션', ...tokenHeaders, '총 토큰', '완료 / 전체 요청', '평균 토큰', '평균 시간 / 표본', ...costHeaders], rows.map(row => [
        identity(row), scopeLabel(row), ...tokenValues(row), number(row.total_tokens), `${number(row.completed_turns)} / ${number(row.turn_count)}`, number(row.avg_tokens_per_turn), `${duration(row.avg_duration_ms)} / ${number(row.turns_with_duration)}개`, ...cost(row),
      ]));
    }
    for (const prefix of ['', 'chart-']) {
      $(`${prefix}previous`).disabled = offset === 0;
      $(`${prefix}next`).disabled = offset + rows.length >= result.total;
      $(`${prefix}page-label`).textContent = rows.length ? `${number(offset + 1)}–${number(offset + rows.length)} / ${number(result.total)}` : '0개';
    }
    const coverage = result.coverage;
    const durationCoverage = turn ? '' : ` · 시간 품질(현재 페이지) 정확 ${number(rows.reduce((n, r) => n + (r.exact_duration_turns ?? 0), 0))} / 계산 ${number(rows.reduce((n, r) => n + (r.derived_duration_turns ?? 0), 0))} / 근사 ${number(rows.reduce((n, r) => n + (r.approximate_duration_turns ?? 0), 0))} / 미상 ${number(rows.reduce((n, r) => n + (r.missing_duration_turns ?? 0), 0))}`;
    $('coverage').textContent = `파일 ${number(coverage.files)} · 정상 ${number(coverage.done)} · 오류 ${number(coverage.error)} · 중단 ${number(coverage.interrupted)} · 이전 수치 유지 요청 ${number(coverage.stale_summaries)}${durationCoverage}`;
  }
  function setCapabilitiesEnabled(enabled) {
    capabilitiesEnabled = enabled;
    $('skill-content').hidden = !enabled;
    $('skill-disabled').hidden = enabled;
    if (!enabled) for (const category of capabilityCategories) {
      $(`${category}-table`).replaceChildren();$(`${category}-total`).textContent = '';
    }
  }
  function capabilityRatio(row, maximum, totalUses) {
    const node = element('div', undefined, 'capability-ratio');
    const detail = `${number(row.percentage)}% · 전체 ${number(totalUses)}회 중 ${number(row.usage_count)}회 · 최다 사용 대비 ${number(row.usage_count / maximum * 100)}%`;
    const bar = svgElement('svg', { viewBox: '0 0 160 12', width: 160, height: 12, role: 'img', 'aria-label': detail });
    bar.append(svgElement('title', {}, detail),
      svgElement('rect', { width: 160, height: 12, rx: 3, class: 'capability-ratio-track' }),
      svgElement('rect', { width: Math.min(160, row.usage_count / maximum * 160), height: 12, rx: 3, class: providerClass(row.provider) }));
    node.append(bar, element('span', `${number(row.percentage)}%`));
    return node;
  }
  $('skill-settings').addEventListener('click', () => send({ type: 'settings' }));
  $('open-diagnostics').addEventListener('click', event => { event.preventDefault(); send({ type: 'openDiagnostics' }); });
  $('settings').addEventListener('click', () => send({ type: 'settings' }));
  $('cancel-usage').addEventListener('click', () => send({ type: 'cancelUsage' }));
  $('usage-filters').addEventListener('submit', event => { event.preventDefault(); offset = 0; query(); });
  $('reset-filters').addEventListener('click', () => {
    closeNames(); selectedProject = undefined; selectedSession = undefined;
    for (const id of ['provider', 'from-day', 'to-day']) $(id).value = '';
    $('group').value = 'day'; $('chart-metric').value = 'tokens';
    nameCaption('project', ''); nameCaption('session', '');
    offset = 0; chartBy = 'provider'; section = 'tokens'; query();
  });
  for (const name of ['tokens', 'skills']) $(`section-${name}`).addEventListener('click', () => {
    section = name; closeNames(); query();
  });
  for (const category of capabilityCategories) {
    $(`${category}-previous`).addEventListener('click', () => { capabilityOffsets[category] = Math.max(0, capabilityOffsets[category] - 100); query(false); });
    $(`${category}-next`).addEventListener('click', () => { capabilityOffsets[category] += 100; query(false); });
  }
  $('billing-mode').addEventListener('change', () => {
    if (!selectedSession || !$('provider').value) return;
    $('billing-mode').disabled = true;
    send({ type: 'setSessionBilling', provider: $('provider').value, sessionId: selectedSession, mode: $('billing-mode').value });
  });
  for (const by of ['provider', 'model']) $(`chart-${by}`).addEventListener('click', () => {
    chartBy = by; offset = 0; query();
  });
  for (const kind of ['project', 'session']) {
    $(`${kind}-name`).addEventListener('click', () => toggleNames(kind));
    $(`${kind}-options`).addEventListener('scroll', () => {
      const list = $(`${kind}-options`);
      if (namePages[kind].loaded < namePages[kind].total && list.scrollTop + list.clientHeight >= list.scrollHeight - 40) loadNames(kind);
    });
    $(`${kind}-picker`).addEventListener('focusout', event => {
      if (openNameKind === kind && !$(`${kind}-picker`).contains(event.relatedTarget)) closeNames();
    });
  }
  window.addEventListener('click', event => {
    if (openNameKind && !$(`${openNameKind}-picker`).contains(event.target)) closeNames();
  });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && openNameKind) { event.preventDefault(); closeNames(true); }
  });
  $('provider').addEventListener('change', () => { selectedSession = undefined; nameCaption('session', ''); closeNames(); });
  $('chart-metric').addEventListener('change', query);
  for (const prefix of ['', 'chart-']) {
    $(`${prefix}previous`).addEventListener('click', () => { offset = Math.max(0, offset - 100); query(); });
    $(`${prefix}next`).addEventListener('click', () => { offset += 100; query(); });
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'state':
        if (typeof message.showApiCosts === 'boolean') { showCosts = message.showApiCosts; updateCostControls(); }
        if (typeof message.capabilitiesEnabled === 'boolean') {
          if (latestUsage?.capabilitiesEnabled !== undefined && latestUsage.capabilitiesEnabled !== message.capabilitiesEnabled) latestUsage = undefined;
          setCapabilitiesEnabled(message.capabilitiesEnabled);
        }
        timezone = message.timezone;
        $('timezone').textContent = `집계 시간대: ${timezone}`;
        $('configuration-warning').textContent = message.timezoneWarning ?? '';
        $('configuration-warning').hidden = !message.timezoneWarning;
        if (Array.isArray(message.providers)) {
          for (const option of $('provider').options) option.disabled = Boolean(option.value) && !message.providers.includes(option.value);
          closeNames();
          if ($('provider').selectedOptions[0]?.disabled) { $('provider').value = ''; selectedSession = undefined; nameCaption('session', ''); offset = 0; query(); }
        }
        if (latestUsage) renderUsage(latestUsage);
        break;
      case 'usage': $('error').hidden = true; renderUsage(message.result); break;
      case 'names': renderNames(message); break;
      case 'busy': $('cancel-usage').hidden = !message.busy; if (message.busy) $('usage-progress').textContent = '기록을 갱신하고 있습니다…'; break;
      case 'progress': { const p = message.progress; $('usage-progress').textContent = `${({ scanning: '파일 확인', parsing: '요청 집계', committing: '통계 저장', complete: '완료' })[p.phase] ?? p.phase} · 발견 ${number(p.discovered)} · 읽음 ${number(p.parsed)} · 실패 ${number(p.failed)}`; break; }
      case 'refreshResult': { closeNames(); const r = message.result; $('usage-progress').textContent = `${r.interrupted ? '중단됨' : r.failed ? '일부 실패 · 이전 정상 통계를 유지했습니다' : '갱신 완료'} · 발견 ${number(r.discovered)} · 읽음 ${number(r.parsed)} · 재사용 ${number(r.reused)} · 실패 ${number(r.failed)} · 읽은 데이터 ${number(r.bodyBytes)} bytes${r.error ? ` · 원인: ${r.error}` : ''}`; break; }
      case 'error': $('error').textContent = message.message; $('error').hidden = false; $('billing-mode').disabled = !selectedSession; break;
    }
  });
  // Restore the query before ready so the initial scan returns the selected group.
  query();
  send({ type: 'ready' });
})();
