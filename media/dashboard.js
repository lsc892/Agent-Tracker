(() => {
  'use strict';
  const t = (key, values) => globalThis.agentTrackerI18n.t(key, values);
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const send = message => vscode.postMessage(message);
  const number = value => value === null || value === undefined ? '—' : new Intl.NumberFormat(globalThis.agentTrackerI18n.language, { maximumFractionDigits: 1 }).format(value);
  const duration = value => value === null || value === undefined ? '—' : value < 1000 ? `${number(value)} ms` : t('dashboard.seconds', { value0: number(value / 1000) });
  const tokenHeaders = [
    { get label() { return t('common.input'); }, get title() { return t('dashboard.inputHelp'); } },
    { get label() { return t('common.output'); }, get title() { return t('dashboard.outputHelp'); } },
    { get label() { return t('common.cacheWrite'); }, get title() { return t('dashboard.cacheWriteHelp'); } },
    { get label() { return t('common.cacheRead'); }, get title() { return t('dashboard.cacheReadHelp'); } },
  ];
  const tokenValues = row => [
    number(row.input_tokens == null || row.cache_write_input_tokens == null || row.cache_read_input_tokens == null
      ? null : Math.max(0, row.input_tokens - row.cache_write_input_tokens - row.cache_read_input_tokens)),
    number(row.output_tokens), number(row.cache_write_input_tokens), number(row.cache_read_input_tokens),
  ];
  const chartMetrics = { get tokens() { return t('dashboard.totalTokens'); }, get requests() { return t('dashboard.requests'); }, get averageTokens() { return t('dashboard.averageTokens'); }, get averageDuration() { return t('dashboard.averageTime'); } };
  let timezone;
  const date = value => value === null || value === undefined ? t('common.unknown') : new Intl.DateTimeFormat(globalThis.agentTrackerI18n.language, { dateStyle: 'short', timeStyle: 'medium', timeZone: timezone }).format(new Date(value));
  let offset = 0;
  let chartBy = 'provider';
  let showCosts = false;
  let section = 'tokens';
  let capabilitiesEnabled = true;
  const capabilityCategories = ['skill', 'subagent', 'plugin', 'model'];
  const capabilityOffsets = { skill: 0, subagent: 0, plugin: 0, model: 0 };
  let latestUsage;
  let latestProgress;
  let latestRefreshResult;
  let busy = false;
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
    $(`${kind}-name`).textContent = text || (kind === 'project' ? t('dashboard.allProjects') : t('dashboard.allSessions'));
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
    nameCaption('project', row ? row.project_name || t('dashboard.unnamedProject') : '', row?.project_key);
    nameCaption('session', '');
    closeNames(true); offset = 0; query();
  }
  function chooseSession(row) {
    selectedSession = row?.session_id;
    if (row) {
      selectedProject = row.project_key;
      nameCaption('project', row.project_name || t('dashboard.unnamedProject'), row.project_key);
      $('provider').value = row.provider;
    }
    nameCaption('session', row ? row.session_name || t('dashboard.unnamedSession') : '', row ? t('dashboard.sessionId', { value0: row.session_id }) : '');
    closeNames(true); offset = 0; query();
  }
  function loadNames(kind) {
    const page = namePages[kind];
    if (openNameKind !== kind || page.pending !== undefined) return;
    const request = { kind, offset: page.loaded };
    if ($('provider').value) request.provider = $('provider').value;
    if (kind === 'session' && selectedProject) request.projectKey = selectedProject;
    page.pending = ++nameRequestId;
    $(`${kind}-list-status`).textContent = t('dashboard.loadingNames');
    send({ type: 'queryNames', query: request, requestId: page.pending });
  }
  function nameOption(kind, row) {
    const title = kind === 'project' ? row?.project_name || t('dashboard.unnamedProject') : row?.session_name || t('dashboard.unnamedSession');
    const node = element('button', row ? title : kind === 'project' ? t('dashboard.allProjects') : t('dashboard.allSessions'), 'name-option');
    node.type = 'button';
    const selected = row ? kind === 'project' ? selectedProject === row.project_key
      : selectedProject === row.project_key && selectedSession === row.session_id && $('provider').value === row.provider
      : kind === 'project' ? !selectedProject : !selectedSession;
    node.setAttribute('aria-pressed', String(selected));
    if (row) {
      node.title = `${row.project_key}${row.session_id ? t('dashboard.sessionIdLine', { value0: row.session_id }) : ''}`;
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
    $(`${kind}-list-status`).textContent = page.total ? t('dashboard.nameCount', { value0: number(page.loaded), value1: number(page.total), value2: page.loaded < page.total ? t('dashboard.scrollMore') : '' }) : t('dashboard.noNames');
    const list = $(`${kind}-options`);
    if (message.result.rows.length && page.loaded < page.total && list.scrollHeight <= list.clientHeight) loadNames(kind);
  }
  function table(target, headers, rows) {
    target.replaceChildren();
    if (!rows.length) { target.append(element('p', t('common.noRecords'), 'empty')); return; }
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
  const requestLabel = row => row.request_title || row.session_name || t('dashboard.untitled');
  function projectLabel(row) {
    const name = row.project_name || t('dashboard.unnamedProject');
    const node = element('button', undefined, 'name-filter');
    node.append(tableLabel(name));
    node.type = 'button';
    node.title = `${name}\n${row.project_key || ''}`;
    node.addEventListener('click', () => chooseProject(row));
    return node;
  }
  function sessionLabel(row, request = false) {
    const label = tableLabel(request ? requestLabel(row) : `${row.project_name || t('dashboard.unnamedProject')} / ${row.session_name || t('dashboard.unnamedSession')}`);
    const node = element('button', undefined, 'name-filter');
    node.type = 'button';
    node.title = t('dashboard.sessionDetails', { value0: label.textContent, value1: row.session_name || '', value2: row.project_key || '', value3: row.session_id, value4: request ? t('dashboard.requestIdLine', { value0: row.root_turn_id }) : '' });
    label.append(element('span', request ? row.session_name || t('dashboard.unnamedSession') : date(row.session_started_at_ms), 'muted session-start'));
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
  const modelLabel = row => row.other_models ? t('dashboard.otherModels', { value0: providerLabel(row.provider) })
    : (row.model || t('dashboard.unknownModel')).replace(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d{8})?$/, '$1$2.$3');
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
  const compact = value => value == null ? '—' : new Intl.NumberFormat(globalThis.agentTrackerI18n.language, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const compactDuration = value => value == null || value < 1000 ? duration(value) : t('dashboard.seconds', { value0: compact(value / 1000) });
  function chartValue(row, metric, turn) {
    if (turn) return metric === 'averageDuration' ? row.duration_ms : row.total_tokens;
    return row[({ tokens: 'total_tokens', requests: 'turn_count', averageTokens: 'avg_tokens_per_turn', averageDuration: 'avg_duration_ms' })[metric]];
  }
  function chartLabel(row, mode) {
    const provider = seriesLabel(row);
    if (mode === 'turn') return `${provider} · ${date(row.started_at_ms)} · ${row.session_name || t('dashboard.unnamedSession')} · ${requestLabel(row)} (${row.root_turn_id})`;
    if (mode === 'calendar') return `${row.period || t('dashboard.unknownTime')} · ${provider}`;
    if (mode === 'total') return provider;
    return `${provider} · ${row.project_name || t('dashboard.unnamedProject')}${row.session_id ? ` / ${row.session_name || t('dashboard.unnamedSession')}` : ''}`;
  }
  function chartSegments(row) {
    if (row.cache_write_input_tokens == null || row.cache_read_input_tokens == null) return [{ value: row.total_tokens, className: 'chart-unknown', label: t('dashboard.unknownTokenTotal') }];
    return [Math.max(0, row.input_tokens - row.cache_write_input_tokens - row.cache_read_input_tokens), row.output_tokens,
      row.cache_write_input_tokens, row.cache_read_input_tokens].map((value, index) => ({ value, className: `chart-series-${index}`, label: tokenHeaders[index].label }));
  }
  function chartDescription(row, chart) {
    const turn = chart.mode === 'turn';
    const value = chartValue(row, chart.metric, turn);
    let detail = `${chartLabel(row, chart.mode)} · ${chart.metric === 'averageDuration' ? duration(value) : `${number(value)} ${chart.metric === 'requests' ? t('dashboard.items') : t('common.tokens')}`}`;
    if (chart.metric === 'tokens') {
      detail += row.cache_write_input_tokens == null || row.cache_read_input_tokens == null ? t('dashboard.unknownBreakdownSuffix')
        : ` · ${tokenHeaders.map((header, index) => `${header.label} ${tokenValues(row)[index]}`).join(' / ')}`;
    }
    if (chart.metric === 'requests') detail += t('dashboard.completedCountSuffix', { value0: number(row.completed_turns) });
    if (chart.metric === 'averageDuration' && !turn) detail += t('dashboard.timeSampleSuffix', { value0: number(row.turns_with_duration) });
    if (chart.metric === 'averageTokens') detail += t('dashboard.completedRequestsSuffix', { value0: number(row.completed_turns) });
    if (chart.mode === 'ranking' && row.session_id) detail += t('dashboard.sessionIdSuffix', { value0: row.session_id });
    if (turn) detail += ` · ${row.status === 'completed' ? t('common.completed') : row.status === 'failed' ? t('common.failed') : t('common.inProgress')} · ${row.duration_quality}`;
    if (chart.by === 'model' && chart.metric === 'averageDuration') detail += t('dashboard.modelTimeSuffix');
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
      if (option.value === 'averageDuration') option.textContent = turn ? t('dashboard.duration') : t('dashboard.averageTime');
    }
    const title = turn && metric === 'averageDuration' ? t('dashboard.requestDuration') : chartMetrics[metric];
    $('chart-title').textContent = title;
    const rows = chart.rows;
    const pageRange = result.rows.length ? t('dashboard.pageRange', { value0: number(offset + 1), value1: number(offset + result.rows.length), value2: number(result.total) }) : t('dashboard.zeroItems');
    $('chart-scope').textContent = t('dashboard.chartScope', { value0: pageRange });
    if (rows.length < result.rows.length) $('chart-scope').textContent += t('dashboard.emptyExcludedSuffix', { value0: number(result.rows.length - rows.length) });
    if (chart.by === 'model') $('chart-scope').textContent += t('dashboard.modelScopeSuffix');
    if (!rows.length) { plot.append(element('p', t('common.noRecords'), 'empty')); return; }
    if (metric === 'tokens') {
      const entries = tokenHeaders.map((header, index) => ({ ...header, className: `chart-series-${index}` }));
      if (rows.some(row => row.cache_write_input_tokens == null || row.cache_read_input_tokens == null)) {
        entries.push({ label: t('dashboard.unknownBreakdown'), get title() { return t('dashboard.unknownBreakdownHelp'); }, className: 'chart-unknown' });
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
    svg.append(svgElement('title', {}, t('dashboard.chartTitle', { value0: title })));
    const max = Math.max(1, ...rows.map(row => chartValue(row, metric, turn) ?? 0));
    const maximum = max === 1 ? 1 : Math.ceil(max / (10 ** Math.floor(Math.log10(max)))) * (10 ** Math.floor(Math.log10(max)));
    const left = vertical ? 70 : 0;
    const top = vertical ? 28 : 26;
    const length = vertical ? 224 : width - 96;
    const tick = value => metric === 'averageDuration' ? compactDuration(value) : compact(value);
    svg.append(svgElement('text', { x: left, y: 14, class: 'chart-axis-label' }, metric === 'averageDuration' ? t('dashboard.time') : metric === 'requests' ? t('dashboard.requestCountAxis') : t('common.tokens')));
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
        const label = turn ? shortened(requestLabel(row)) : sessions ? shortened(row.session_name || t('dashboard.unnamedSession')) : projects ? shortened(row.project_name || t('dashboard.unnamedProject')) : category || t('dashboard.unknownTime');
        const parts = turn ? [label] : label.split(' ~ ');
        const labelY = chart.by === 'model' ? 352 : 292;
        const caption = svgElement('text', { x, y: labelY, 'text-anchor': 'middle', class: 'chart-axis-label' }, parts[0]);
        if (turn) caption.append(svgElement('title', {}, requestLabel(row)));
        svg.append(caption);
        if (parts[1]) svg.append(svgElement('text', { x, y: labelY + 16, 'text-anchor': 'middle', class: 'chart-axis-label' }, `~ ${parts[1]}`));
        if (turn) {
          svg.append(svgElement('text', { x, y: labelY + 16, 'text-anchor': 'middle', class: 'chart-axis-label' }, row.started_at_ms == null ? t('dashboard.unknownTime')
            : new Intl.DateTimeFormat(globalThis.agentTrackerI18n.language, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone }).format(new Date(row.started_at_ms))));
        }
        if (sessions) svg.append(svgElement('text', { x, y: labelY + 16, 'text-anchor': 'middle', class: 'chart-axis-label' }, shortened(row.project_name || t('dashboard.unnamedProject'))));
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
          const detail = t('dashboard.tokenChartDetail', { value0: chartLabel(row, chart.mode), value1: segment.label, value2: number(segment.value) });
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
        table($(`${category}-table`), [t('common.provider'), t('common.name'), t('dashboard.usageCount'), t('dashboard.overallRatio')],
          page.rows.map(row => [providerLabel(row.provider), row.name || t('dashboard.unknownModel'), number(row.usage_count), capabilityRatio(row, maximum, page.totalUses)]));
        $(`${category}-total`).textContent = t('dashboard.totalUses', { value0: number(page.totalUses) });
        $(`${category}-previous`).disabled = capabilityOffsets[category] === 0;
        $(`${category}-next`).disabled = capabilityOffsets[category] + page.rows.length >= page.total;
        $(`${category}-page`).textContent = page.total ? `${number(capabilityOffsets[category] + 1)}–${number(capabilityOffsets[category] + page.rows.length)} / ${number(page.total)}` : t('dashboard.zeroItems');
      }
      return;
    }
    renderChart(result);
    const costHeaders = showCosts ? [t('dashboard.estimatedApiCost')] : [];
    const cost = row => {
      if (!showCosts) return [];
      const value = row.billing_mode === 'subscription' ? t('dashboard.subscriptionZero') : row.cost_usd == null ? '—'
        : new Intl.NumberFormat(globalThis.agentTrackerI18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(row.cost_usd);
      return [`${value}${row.unknown_costs ? t('dashboard.unknownCostsSuffix', { value0: number(row.unknown_costs) }) : ''}`];
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
      : row.project_key ? projectLabel(row) : tableLabel(['day', 'month'].includes(result.groupBy) ? t('dashboard.unknownTime') : t('common.all'));
    const rows = result.rows;
    if (turn) {
      table($('usage-table'), [t('dashboard.projectHeader', { value0: model ? t('common.model') : t('common.provider') }), t('dashboard.requestSessionHeader'), t('dashboard.startTime'), ...tokenHeaders, t('dashboard.totalTokens'), t('dashboard.duration'), t('dashboard.statusQuality'), ...costHeaders], rows.map(row => [
        model ? identity(row, ` / ${row.project_name}`) : tableLabel(identity(row, ` / ${row.project_name}`)), sessionLabel(row, true), date(row.started_at_ms), ...tokenValues(row), number(row.total_tokens), duration(row.duration_ms), `${row.status === 'completed' ? t('common.completed') : row.status === 'failed' ? t('common.failed') : t('common.inProgress')} · ${row.duration_quality}${row.quality_flags ? ` · ${row.quality_flags}` : ''}${row.last_error ? t('dashboard.previousValueSuffix', { value0: row.last_error }) : ''}`, ...cost(row),
      ]));
    } else {
      table($('usage-table'), [model ? t('common.model') : t('common.provider'), t('dashboard.periodProjectSession'), ...tokenHeaders, t('dashboard.totalTokens'), t('dashboard.completedTotal'), t('dashboard.averageTokens'), t('dashboard.averageTimeSamples'), ...costHeaders], rows.map(row => [
        identity(row), scopeLabel(row), ...tokenValues(row), number(row.total_tokens), `${number(row.completed_turns)} / ${number(row.turn_count)}`, number(row.avg_tokens_per_turn), t('dashboard.timeSamples', { value0: duration(row.avg_duration_ms), value1: number(row.turns_with_duration) }), ...cost(row),
      ]));
    }
    for (const prefix of ['', 'chart-']) {
      $(`${prefix}previous`).disabled = offset === 0;
      $(`${prefix}next`).disabled = offset + rows.length >= result.total;
      $(`${prefix}page-label`).textContent = rows.length ? `${number(offset + 1)}–${number(offset + rows.length)} / ${number(result.total)}` : t('dashboard.zeroItems');
    }
    const coverage = result.coverage;
    const durationCoverage = turn ? '' : t('dashboard.timeQualitySuffix', { value0: number(rows.reduce((n, r) => n + (r.exact_duration_turns ?? 0), 0)), value1: number(rows.reduce((n, r) => n + (r.derived_duration_turns ?? 0), 0)), value2: number(rows.reduce((n, r) => n + (r.approximate_duration_turns ?? 0), 0)), value3: number(rows.reduce((n, r) => n + (r.missing_duration_turns ?? 0), 0)) });
    $('coverage').textContent = t('dashboard.coverage', { value0: number(coverage.files), value1: number(coverage.done), value2: number(coverage.error), value3: number(coverage.interrupted), value4: number(coverage.stale_summaries), value5: durationCoverage });
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
    const detail = t('dashboard.ratioDetail', { value0: number(row.percentage), value1: number(totalUses), value2: number(row.usage_count), value3: number(row.usage_count / maximum * 100) });
    const bar = svgElement('svg', { viewBox: '0 0 160 12', width: 160, height: 12, role: 'img', 'aria-label': detail });
    bar.append(svgElement('title', {}, detail),
      svgElement('rect', { width: 160, height: 12, rx: 3, class: 'capability-ratio-track' }),
      svgElement('rect', { width: Math.min(160, row.usage_count / maximum * 160), height: 12, rx: 3, class: providerClass(row.provider) }));
    node.append(bar, element('span', `${number(row.percentage)}%`));
    return node;
  }
  function renderProgress() {
    if (latestRefreshResult) {
      const r = latestRefreshResult;
      $('usage-progress').textContent = t('dashboard.refreshResult', { value0: r.interrupted ? t('common.interrupted') : r.failed ? t('dashboard.partialFailure') : t('dashboard.updated'), value1: number(r.discovered), value2: number(r.parsed), value3: number(r.reused), value4: number(r.failed), value5: number(r.bodyBytes), value6: r.error ? t('dashboard.reasonSuffix', { value0: r.error }) : '' });
    } else if (latestProgress) {
      const p = latestProgress;
      $('usage-progress').textContent = t('dashboard.progress', { value0: ({ scanning: t('dashboard.scanning'), parsing: t('dashboard.parsing'), committing: t('dashboard.committing'), complete: t('common.completed') })[p.phase] ?? p.phase, value1: number(p.discovered), value2: number(p.parsed), value3: number(p.failed) });
    } else if (busy) $('usage-progress').textContent = t('dashboard.updating');
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
        if (globalThis.updateAgentTrackerLocale?.(message.localization)) {
          if (!selectedProject) nameCaption('project', '');
          if (!selectedSession) nameCaption('session', '');
        }
        if (typeof message.showApiCosts === 'boolean') { showCosts = message.showApiCosts; updateCostControls(); }
        if (typeof message.capabilitiesEnabled === 'boolean') {
          if (latestUsage?.capabilitiesEnabled !== undefined && latestUsage.capabilitiesEnabled !== message.capabilitiesEnabled) latestUsage = undefined;
          setCapabilitiesEnabled(message.capabilitiesEnabled);
        }
        timezone = message.timezone;
        $('timezone').textContent = t('dashboard.timezone', { value0: timezone });
        $('configuration-warning').textContent = message.timezoneWarning ?? '';
        $('configuration-warning').hidden = !message.timezoneWarning;
        if (Array.isArray(message.providers)) {
          for (const option of $('provider').options) option.disabled = Boolean(option.value) && !message.providers.includes(option.value);
          closeNames();
          if ($('provider').selectedOptions[0]?.disabled) { $('provider').value = ''; selectedSession = undefined; nameCaption('session', ''); offset = 0; query(); }
        }
        if (latestUsage) renderUsage(latestUsage);
        renderProgress();
        break;
      case 'usage': $('error').hidden = true; renderUsage(message.result); break;
      case 'names': renderNames(message); break;
      case 'busy': busy = message.busy; $('cancel-usage').hidden = !busy; if (busy) { latestProgress = undefined; latestRefreshResult = undefined; } renderProgress(); break;
      case 'progress': latestProgress = message.progress; latestRefreshResult = undefined; renderProgress(); break;
      case 'refreshResult': closeNames(); latestRefreshResult = message.result; renderProgress(); break;
      case 'error': $('error').textContent = message.message; $('error').hidden = false; $('billing-mode').disabled = !selectedSession; break;
    }
  });
  // Restore the query before ready so the initial scan returns the selected group.
  query();
  send({ type: 'ready' });
})();
