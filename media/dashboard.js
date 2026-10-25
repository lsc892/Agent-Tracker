// 사용량 통계의 필터·표·차트를 렌더링하고 사용자 요청을 확장에 전달한다.
(() => {
  'use strict';
  const t = (key, values) => globalThis.agentTrackerI18n.t(key, values);
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const send = message => vscode.postMessage(message);
  const number = value => value === null || value === undefined ? '—' : new Intl.NumberFormat(globalThis.agentTrackerI18n.language, { maximumFractionDigits: 1 }).format(value);
  function duration(value) {
    if (value === null || value === undefined) return '—';
    if (value < 1000) return `${number(value)} ms`;
    return t('dashboard.seconds', { value0: number(value / 1000) });
  }
  const tokenHeaders = [
    { get label() { return t('common.input'); }, get title() { return t('dashboard.inputHelp'); } },
    { get label() { return t('common.output'); }, get title() { return t('dashboard.outputHelp'); } },
    { get label() { return t('common.cacheWrite'); }, get title() { return t('dashboard.cacheWriteHelp'); } },
    { get label() { return t('common.cacheRead'); }, get title() { return t('dashboard.cacheReadHelp'); } },
  ];
  const tokenSortKeys = ['input', 'output', 'cacheWrite', 'cacheRead', 'tokens'];
  const tokenValues = row => [
    number(row.input_tokens == null || row.cache_write_input_tokens == null || row.cache_read_input_tokens == null
      ? null : Math.max(0, row.input_tokens - row.cache_write_input_tokens - row.cache_read_input_tokens)),
    number(row.output_tokens), number(row.cache_write_input_tokens), number(row.cache_read_input_tokens),
  ];
  const chartMetrics = { get tokens() { return t('dashboard.totalTokens'); }, get requests() { return t('dashboard.requests'); }, get averageTokens() { return t('dashboard.averageTokens'); }, get averageDuration() { return t('dashboard.averageTime'); } };
  let timezone;
  const date = value => value === null || value === undefined ? t('common.unknown') : new Intl.DateTimeFormat(globalThis.agentTrackerI18n.language, { dateStyle: 'short', timeStyle: 'medium', timeZone: timezone }).format(new Date(value));
  let offset = 0;
  let pageSize = 100;
  let chartBy = 'provider';
  let tableSort = { key: 'period', direction: 'desc' };
  let showCosts = false;
  let section = 'tokens';
  let capabilitiesEnabled = true;
  const capabilityCategories = ['skill', 'subagent', 'plugin', 'model'];
  const capabilityOffsets = { skill: 0, subagent: 0, plugin: 0, model: 0 };
  const capabilityPageSizes = { skill: 100, subagent: 100, plugin: 100, model: 100 };
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
  if (validPageSize(saved?.pageSize)) pageSize = saved.pageSize;
  for (const category of capabilityCategories) {
    if (validPageSize(saved?.capabilityPageSizes?.[category])) capabilityPageSizes[category] = saved.capabilityPageSizes[category];
  }
  syncPageSizes();

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  /**
   * 책임: 현재 필터·정렬·페이지 상태를 호스트 조회 요청으로 변환한다.
   * 알고리즘: 직접 입력한 날짜를 date picker로 교차 검증하고 구역별 페이지 조건과 선택 ID를 모아 전송한 뒤 화면 상태를 저장한다.
   */
  function query(resetCapabilities = true) {
    if (!validateDateFilters()) return;
    if (resetCapabilities) for (const category of capabilityCategories) capabilityOffsets[category] = 0;
    updateSectionControls();
    const request = usageRequest();
    send({ type: 'queryUsage', query: request });
    saveState();
    updateCostControls();
    $('billing-mode').disabled = true;
    for (const by of ['provider', 'model']) $(`chart-${by}`).setAttribute('aria-pressed', String(chartBy === by));
  }
  function validateDateFilters() {
    for (const id of ['from-day', 'to-day']) {
      const input = $(id);
      const picker = $(`${id}-picker`);
      picker.value = input.value;
      if (!input.value || /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(input.value) && picker.value === input.value) continue;
      $('error').textContent = t('dashboard.invalidDate');
      $('error').hidden = false;
      input.focus();
      return false;
    }
    return true;
  }
  function updateSectionControls() {
    $('token-section').hidden = section !== 'tokens';
    $('skill-section').hidden = section !== 'skills';
    $('group-control').hidden = section !== 'tokens';
    $('chart-by-control').hidden = section !== 'tokens';
    for (const name of ['tokens', 'skills']) $(`section-${name}`).setAttribute('aria-pressed', String(section === name));
  }
  function usageRequest() {
    const request = { section, groupBy: $('group').value, limit: pageSize, offset, chartBy, tableSort: { ...tableSort } };
    if (section === 'skills') {
      request.capabilityOffsets = { ...capabilityOffsets };
      request.capabilityLimits = { ...capabilityPageSizes };
    }
    const metric = $('chart-metric').value || 'tokens';
    request.chartMetric = request.groupBy === 'turn' && metric !== 'averageDuration' ? 'tokens' : metric;
    $('chart-metric').value = request.chartMetric;
    if ($('provider').value) request.provider = $('provider').value;
    if (selectedProject) request.projectKey = selectedProject;
    if (selectedSession) request.sessionId = selectedSession;
    if ($('from-day').value) request.fromDay = $('from-day').value;
    if ($('to-day').value) request.toDay = $('to-day').value;
    return request;
  }
  function updateCostControls() {
    $('cost-note').hidden = !showCosts;
    $('billing-control').hidden = !showCosts || !selectedSession || !$('provider').value;
  }
  function saveState() {
    vscode.setState({ section, group: $('group').value, chartMetric: $('chart-metric').value, chartBy, pageSize, capabilityPageSizes: { ...capabilityPageSizes } });
  }
  function validPageSize(value) {
    return Number.isSafeInteger(value) && value >= 1 && value <= 1000;
  }
  function syncPageSizes() {
    for (const id of ['page-size', 'chart-page-size']) $(id).value = String(pageSize);
    for (const category of capabilityCategories) $(`${category}-page-size`).value = String(capabilityPageSizes[category]);
  }
  /**
   * 책임: 페이지당 행 수를 유효한 정수일 때만 적용한다.
   * 알고리즘: 변경·Enter 이벤트에서 1~1000 범위를 검증하고 오류는 입력칸에 표시하며 성공 값만 호출자에게 전달한다.
   */
  function bindPageSize(id, apply) {
    const input = $(id);
    const commit = () => {
      input.setCustomValidity('');
      const value = Number(input.value);
      if (!validPageSize(value)) {
        input.setCustomValidity(t('dashboard.invalidPageSize'));
        input.reportValidity();
        return;
      }
      apply(value);
    };
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.addEventListener('change', commit);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); commit(); }
    });
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
  /**
   * 책임: 이름 선택 목록을 중복 요청 없이 다음 페이지까지 불러온다.
   * 알고리즘: 열린 목록의 pending 상태를 검사하고 현재 제공자·프로젝트와 loaded offset에 증가하는 request ID를 붙여 조회한다.
   */
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
  /**
   * 책임: 이름이 같아도 식별자로 구분되는 프로젝트·세션 선택지를 만든다.
   * 알고리즘: 표시 이름과 경로·세션 metadata를 textContent로 조합하고 선택 상태는 제공자·프로젝트·세션 ID로 비교해 클릭 동작을 연결한다.
   */
  function nameOption(kind, row) {
    const title = kind === 'project' ? row?.project_name || t('dashboard.unnamedProject') : row?.session_name || t('dashboard.unnamedSession');
    let label = title;
    if (!row) label = kind === 'project' ? t('dashboard.allProjects') : t('dashboard.allSessions');
    const node = element('button', label, 'name-option');
    node.type = 'button';
    const selected = isNameSelected(kind, row);
    node.setAttribute('aria-pressed', String(selected));
    if (row) {
      node.title = `${row.project_key}${row.session_id ? t('dashboard.sessionIdLine', { value0: row.session_id }) : ''}`;
      node.append(element('span', kind === 'project' ? row.project_key
        : `${providerLabel(row.provider)} · ${row.project_name} · ${date(row.session_started_at_ms)}`, 'muted'));
    }
    node.addEventListener('click', () => kind === 'project' ? chooseProject(row) : chooseSession(row));
    return node;
  }
  function isNameSelected(kind, row) {
    if (!row) return kind === 'project' ? !selectedProject : !selectedSession;
    if (kind === 'project') return selectedProject === row.project_key;
    return selectedProject === row.project_key && selectedSession === row.session_id && $('provider').value === row.provider;
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
  /**
   * 책임: 선택 목록에 현재 요청의 응답만 누적한다.
   * 알고리즘: 열린 목록·pending ID를 대조해 오래된 응답을 버리고 loaded·total을 갱신하며 표시 공간이 남으면 다음 페이지를 요청한다.
   */
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
  /**
   * 책임: 통계 표와 헤더 정렬 조작을 안전한 DOM으로 만든다.
   * 알고리즘: 문자열은 textContent로 넣고 정렬 가능한 헤더에만 방향·접근성 속성을 붙이며 클릭 시 첫 페이지부터 호스트에 다시 조회한다.
   */
  function table(target, headers, rows, sortKeys = []) {
    target.replaceChildren();
    if (!rows.length) { target.append(element('p', t('common.noRecords'), 'empty')); return; }
    const node = element('table');
    const head = element('thead');
    const tr = element('tr');
    for (const [index, header] of headers.entries()) {
      const label = typeof header === 'string' ? header : header.label;
      const key = sortKeys[index];
      const cell = tableHeader(header, label, key);
      tr.append(cell);
    }
    head.append(tr);
    node.append(head);
    const body = element('tbody');
    for (const values of rows) {
      const row = tableRow(values);
      body.append(row);
    }
    node.append(body);
    target.append(node);
  }
  function tableHeader(header, label, key) {
    const cell = element('th', key ? undefined : label);
    cell.setAttribute('scope', 'col');
    if (typeof header !== 'string') cell.title = header.title;
    if (!key) return cell;
    const active = tableSort.key === key;
    let direction = 'none';
    if (active) direction = tableSort.direction === 'asc' ? 'ascending' : 'descending';
    cell.setAttribute('aria-sort', direction);
    const button = element('button', undefined, 'table-sort');
    button.type = 'button';
    button.setAttribute('data-sort-key', key);
    button.append(element('span', label));
    if (active) {
      const indicator = element('span', tableSort.direction === 'asc' ? '↑' : '↓', 'sort-indicator');
      indicator.setAttribute('aria-hidden', 'true');
      button.append(indicator);
    }
    button.addEventListener('click', () => {
      tableSort = { key, direction: tableSort.key === key && tableSort.direction === 'desc' ? 'asc' : 'desc' };
      offset = 0;
      query();
    });
    cell.append(button);
    return cell;
  }
  function tableRow(values) {
    const row = element('tr');
    for (const value of values) {
      const cell = element('td');
      if (value && typeof value === 'object') cell.append(value);
      else cell.textContent = String(value ?? '—');
      row.append(cell);
    }
    return row;
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
  function seriesName(row, model, suffix = '') {
    const node = element('span', undefined, 'series-name');
    const label = model ? modelLabel(row) : providerLabel(row.provider);
    node.title = providerLabel(row.provider);
    const marker = svgElement('svg', { width: 8, height: 8, role: 'img', 'aria-label': providerLabel(row.provider) });
    marker.append(providerMarker(row.provider));
    node.append(marker, suffix ? tableLabel(`${label}${suffix}`) : element('span', label));
    return node;
  }
  const compact = value => value == null ? '—' : new Intl.NumberFormat(globalThis.agentTrackerI18n.language, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const compactDuration = value => value == null || value < 1000 ? duration(value) : t('dashboard.seconds', { value0: compact(value / 1000) });
  function chartValue(row, metric, turn) {
    if (turn) return metric === 'averageDuration' ? row.duration_ms : row.total_tokens;
    return row[({ tokens: 'total_tokens', requests: 'turn_count', averageTokens: 'avg_tokens_per_turn', averageDuration: 'avg_duration_ms' })[metric]];
  }
  function unknownPriority(row, mode) {
    const model = row.model !== undefined && !row.model;
    const time = mode === 'calendar' ? row.period == null : mode === 'turn' && row.started_at_ms == null;
    return Number(model) + 2 * Number(time);
  }
  function chartLabel(row, mode) {
    const provider = seriesLabel(row);
    if (mode === 'turn') return `${provider} · ${date(row.started_at_ms)} · ${row.session_name || t('dashboard.unnamedSession')} · ${requestLabel(row)} (${row.root_turn_id})`;
    if (mode === 'calendar') return `${row.period || t('dashboard.unknownTime')} · ${provider}`;
    if (mode === 'total') return provider;
    return `${provider} · ${row.project_name || t('dashboard.unnamedProject')}${row.session_id ? ` / ${row.session_name || t('dashboard.unnamedSession')}` : ''}`;
  }
  /**
   * 책임: 토큰 총량·평균을 중복 없는 누적 막대 성분으로 나눈다.
   * 알고리즘: 입력에서 캐시 읽기·쓰기를 뺀 뒤 출력·캐시를 별도 성분으로 만들고 캐시가 미상이면 총량 한 구간으로 표시한다.
   */
  function chartSegments(row, metric) {
    const average = metric === 'averageTokens';
    const input = average ? row.avg_input_tokens : row.input_tokens;
    const output = average ? row.avg_output_tokens : row.output_tokens;
    const write = average ? row.avg_cache_write_input_tokens : row.cache_write_input_tokens;
    const read = average ? row.avg_cache_read_input_tokens : row.cache_read_input_tokens;
    if (write == null || read == null) return [{ value: average ? row.avg_tokens_per_turn : row.total_tokens, className: 'chart-unknown',
      label: average ? `${t('dashboard.averageTokens')} (${t('dashboard.unknownBreakdown')})` : t('dashboard.unknownTokenTotal') }];
    return [Math.max(0, input - write - read), output, write, read]
      .map((value, index) => ({ value, className: `chart-series-${index}`, label: tokenHeaders[index].label }));
  }
  /**
   * 책임: 막대의 의미·토큰 구성·평균 표본을 접근 가능한 설명으로 제공한다.
   * 알고리즘: 도표 모드와 지표에 맞는 값·구성을 선택하고 완료 횟수·시간 표본·모델 시간 중복 안내를 필요한 경우 덧붙인다.
   */
  function chartDescription(row, chart) {
    const turn = chart.mode === 'turn';
    const value = chartValue(row, chart.metric, turn);
    let detail = `${chartLabel(row, chart.mode)} · ${chartMetricValue(value, chart)}`;
    if (['tokens', 'averageTokens'].includes(chart.metric) && value != null) {
      const segments = chartSegments(row, chart.metric);
      detail += segments[0].className === 'chart-unknown' ? t('dashboard.unknownBreakdownSuffix')
        : ` · ${segments.map(segment => `${segment.label} ${number(segment.value)}`).join(' / ')}`;
    }
    if (chart.metric === 'requests') detail += t('dashboard.completedCountSuffix', { value0: number(row.completed_turns) });
    if (chart.metric === 'averageDuration' && !turn) detail += t('dashboard.timeSampleSuffix', { value0: number(row.turns_with_duration) });
    if (chart.metric === 'averageTokens') detail += t('dashboard.completedRequestsSuffix', { value0: number(row.completed_turns) });
    if (chart.mode === 'ranking' && row.session_id) detail += t('dashboard.sessionIdSuffix', { value0: row.session_id });
    if (turn) detail += ` · ${requestStatus(row)} · ${row.duration_quality}`;
    if (chart.by === 'model' && chart.metric === 'averageDuration') detail += t('dashboard.modelTimeSuffix');
    return detail;
  }
  function chartMetricValue(value, chart) {
    if (chart.metric === 'averageDuration') return duration(value);
    return `${number(value)} ${chart.metric === 'requests' ? t('dashboard.items') : t('common.tokens')}`;
  }
  /**
   * 책임: 현재 표 페이지의 통계를 기간·요청·비교 도표로 그린다.
   * 알고리즘: 분류별 peer와 축 최댓값으로 SVG 좌표를 계산하고 토큰 성분을 누적 배치하며, 각 구간에 키보드 접근과 상세 설명을 연결한다.
   */
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
    const rows = [...chart.rows].sort((a, b) => unknownPriority(a, chart.mode) - unknownPriority(b, chart.mode));
    const pageRange = result.rows.length ? t('dashboard.pageRange', { value0: number(offset + 1), value1: number(offset + result.rows.length), value2: number(result.total) }) : t('dashboard.zeroItems');
    $('chart-scope').textContent = t('dashboard.chartScope', { value0: pageRange });
    if (rows.length < result.rows.length) $('chart-scope').textContent += t('dashboard.emptyExcludedSuffix', { value0: number(result.rows.length - rows.length) });
    if (chart.by === 'model') $('chart-scope').textContent += t('dashboard.modelScopeSuffix');
    if (!rows.length) { plot.append(element('p', t('common.noRecords'), 'empty')); return; }
    renderChartLegend(legend, rows, metric, turn);
    const layout = calculateChartLayout(chart, rows, result.groupBy, plot);
    const { width, height } = layout;
    const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg', role: 'group', 'aria-label': `${title} · ${$('chart-scope').textContent}` });
    svg.append(svgElement('title', {}, t('dashboard.chartTitle', { value0: title })));
    appendChartAxes(svg, metric, layout);
    appendChartCategories(svg, chart, rows, layout);
    appendChartBars(svg, chart, rows, layout);
    plot.append(svg);
    $('chart-detail').textContent = chartDescription(rows[0], chart);
  }

  function renderChartLegend(legend, rows, metric, turn) {
    if (!['tokens', 'averageTokens'].includes(metric)) return;
    const entries = tokenHeaders.map((header, index) => ({ ...header, className: `chart-series-${index}` }));
    if (rows.some(row => chartValue(row, metric, turn) != null && chartSegments(row, metric)[0].className === 'chart-unknown')) {
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

  function calculateChartLayout(chart, rows, groupBy, plot) {
    const turn = chart.mode === 'turn';
    const metric = chart.metric;
    const sessions = chart.mode === 'ranking' && groupBy === 'session';
    const projects = chart.mode === 'ranking' && groupBy === 'project';
    const vertical = chart.mode === 'calendar' || turn || sessions || projects;
    const categoryKey = (row, index) => turn ? String(index) : sessions ? `${row.provider}/${row.project_key}/${row.session_id}` : projects ? `${row.provider}/${row.project_key}` : row.period;
    const categories = vertical ? [...new Set(rows.map(categoryKey))] : [];
    if (chart.mode === 'calendar') categories.sort((a, b) => Number(a == null) - Number(b == null));
    const maxPeers = vertical && !turn ? Math.max(1, ...categories.map(category => rows.filter((row, index) => categoryKey(row, index) === category).length)) : 1;
    const peerWidth = chart.by === 'model' ? 46 : 60;
    const categoryWidth = Math.max(turn || sessions || projects ? 164 : 128, maxPeers * peerWidth + 36);
    const width = Math.max(plot.clientWidth || 736, 736, vertical ? 86 + categories.length * categoryWidth : 0);
    const height = vertical ? chart.by === 'model' ? 414 : 372 : 62 + rows.length * 62;
    const max = Math.max(1, ...rows.map(row => chartValue(row, metric, turn) ?? 0));
    const maximum = max === 1 ? 1 : Math.ceil(max / (10 ** Math.floor(Math.log10(max)))) * (10 ** Math.floor(Math.log10(max)));
    const left = vertical ? 70 : 0;
    const top = vertical ? 28 : 26;
    const length = vertical ? 224 : width - 96;
    return { turn, sessions, projects, vertical, categoryKey, categories, peerWidth, width, height, maximum, left, top, length };
  }

  function appendChartAxes(svg, metric, layout) {
    const { vertical, maximum, left, top, length, width, height } = layout;
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
  }

  function appendChartCategories(svg, chart, rows, layout) {
    const { turn, sessions, projects, vertical, categoryKey, categories, left, width } = layout;
    if (!vertical) return;
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

  function appendChartBars(svg, chart, rows, layout) {
    const { turn, vertical, categoryKey, categories, peerWidth, width, maximum, left, top, length } = layout;
    const metric = chart.metric;
    const tokenMetric = ['tokens', 'averageTokens'].includes(metric);
    rows.forEach((row, index) => {
      const value = chartValue(row, metric, turn);
      const description = chartDescription(row, chart);
      const group = svgElement('g', { class: 'chart-bar', tabindex: 0, role: 'img', 'aria-label': row.model === undefined ? description : `${providerLabel(row.provider)} · ${description}` });
      group.append(svgElement('title', {}, description));
      const peers = vertical && !turn ? rows.filter((peer, peerIndex) => categoryKey(peer, peerIndex) === categoryKey(row, index)) : [row];
      const categoryIndex = categories.indexOf(categoryKey(row, index));
      const center = left + (width - left - 16) * (categoryIndex + .5) / Math.max(1, categories.length);
      const x = vertical ? center + (peers.indexOf(row) - (peers.length - 1) / 2) * peerWidth - 18 : left;
      const y = vertical ? top + length : 58 + index * 62;
      const barSize = vertical ? 36 : 22;
      group.append(svgElement('rect', { x: vertical ? x - 4 : x, y: vertical ? top : y - 20,
        width: vertical ? barSize + 8 : width, height: vertical ? length + 32 : 52, class: 'chart-hit' }));
      const bar = { x, y, barSize, vertical, maximum, length, value, metric, tokenMetric, description };
      const consumed = appendChartSegments(group, row, chart, bar);
      if (value === 0) group.append(svgElement('line', { x1: x, x2: x + (vertical ? barSize : 2), y1: y, y2: y + (vertical ? 0 : barSize), class: 'chart-grid' }));
      const displayValue = metric === 'averageDuration' ? compactDuration(value) : compact(value);
      group.append(svgElement('text', { x: vertical ? x + barSize / 2 : x + consumed + 8,
        y: vertical ? y - consumed - 8 : y + 16, 'text-anchor': vertical ? 'middle' : 'start', class: 'chart-value' }, displayValue));
      appendChartBarLabel(group, row, chart, bar);
      const showDetail = () => { $('chart-detail').textContent = description; };
      group.addEventListener('mouseenter', showDetail);
      group.addEventListener('focus', showDetail);
      group.addEventListener('click', showDetail);
      svg.append(group);
    });
  }

  function appendChartSegments(group, row, chart, bar) {
    const { x, y, barSize, vertical, maximum, length, value, metric, tokenMetric, description } = bar;
    const segments = tokenMetric ? chartSegments(row, metric) : [{ value, className: 'chart-measure' }];
    let consumed = 0;
    for (const segment of segments) {
      if (segment.value == null || segment.value <= 0) continue;
      const size = segment.value / maximum * length;
      const mark = svgElement('rect', { x: vertical ? x : x + consumed, y: vertical ? y - consumed - size : y,
        width: vertical ? barSize : size, height: vertical ? size : barSize, class: `chart-segment ${segment.className}` });
      if (tokenMetric) {
        const detail = t('dashboard.tokenChartDetail', { value0: chartLabel(row, chart.mode), value1: segment.label, value2: number(segment.value) });
        mark.append(svgElement('title', {}, detail));
        mark.setAttribute('aria-label', detail);
        mark.addEventListener('mouseenter', () => { $('chart-detail').textContent = detail; });
        mark.addEventListener('mouseleave', () => { $('chart-detail').textContent = description; });
      }
      group.append(mark);
      consumed += size;
    }
    return consumed;
  }

  function appendChartBarLabel(group, row, chart, bar) {
    const { x, y, barSize, vertical } = bar;
    if (!vertical) {
      const label = chartLabel(row, chart.mode);
      group.append(providerMarker(row.provider, { x, y: y - 14 }));
      group.append(svgElement('text', { x: x + 14, y: y - 6, class: 'chart-label' }, label.length > 48 ? `${label.slice(0, 47)}…` : label));
      return;
    }
    if (row.model === undefined) {
      group.append(providerMarker(row.provider, { x: x + barSize / 2 - 26, y: 266 }),
        svgElement('text', { x: x + barSize / 2 + 7, y: 274, 'text-anchor': 'middle', class: 'chart-provider' }, providerLabel(row.provider)));
      return;
    }
    const label = modelLabel(row);
    const name = svgElement('g', { transform: `translate(${x + barSize / 2} 274) rotate(35)` });
    name.append(providerMarker(row.provider, { x: 0, y: -8 }),
      svgElement('text', { x: 14, y: 0, 'text-anchor': 'start', class: 'chart-provider' }, label.length > 18 ? `${label.slice(0,17)}…` : label));
    group.append(name);
  }
  /**
   * 책임: 조회 결과를 다시 그려도 사용자가 읽던 위치를 유지한다.
   * 알고리즘: 창과 표·도표의 스크롤 위치를 저장하고 DOM 갱신 후 finally에서 가로 스크롤과 창 위치를 복원한다.
   */
  function renderUsage(result) {
    const left = window.scrollX, top = window.scrollY;
    const tableLeft = $('usage-table').scrollLeft, chartLeft = $('usage-chart').scrollLeft;
    try { updateUsage(result); }
    finally {
      $('usage-table').scrollLeft = tableLeft;
      $('usage-chart').scrollLeft = chartLeft;
      // Replacing chart/table content can move the browser's scroll anchor during layout.
      if (window.scrollX !== left || window.scrollY !== top) window.scrollTo({ left, top, behavior: 'instant' });
    }
  }
  /**
   * 책임: 조회 응답을 토큰 또는 Skill 표와 페이지 상태에 반영한다.
   * 알고리즘: 구역에 맞춰 행·전체 개수·지표를 렌더링하고 Skill은 전체 범위 최댓값·비율을 사용하며 토큰 표는 같은 결과로 도표를 갱신한다.
   */
  function updateUsage(result) {
    latestUsage = result;
    if (result.capabilitiesEnabled !== undefined) setCapabilitiesEnabled(result.capabilitiesEnabled);
    if (section === 'skills' && !capabilitiesEnabled) return;
    if (result.capabilities) {
      renderCapabilityTables(result.capabilities);
      return;
    }
    renderChart(result);
    if (result.billing && selectedSession && showCosts) {
      $('billing-mode').value = result.billing;
      $('billing-mode').disabled = false;
    }
    const turn = result.groupBy === 'turn';
    const model = result.by === 'model';
    $('model-note').hidden = !model;
    const rows = result.rows;
    if (turn) renderTurnTable(rows, model);
    else renderAggregateTable(rows, model, result.groupBy);
    updateUsagePagination(rows, result.total);
    updateUsageCoverage(result.coverage, rows, turn);
  }

  function renderCapabilityTables(pages) {
    for (const category of capabilityCategories) {
      const page = pages[category];
      const maximum = Math.max(1, page.maxUses);
      table($(`${category}-table`), [t('common.provider'), t('common.name'), t('dashboard.usageCount'), t('dashboard.overallRatio')],
        page.rows.map(row => [providerLabel(row.provider), row.name || t('dashboard.unknownModel'), number(row.usage_count), capabilityRatio(row, maximum, page.totalUses)]));
      $(`${category}-total`).textContent = t('dashboard.totalUses', { value0: number(page.totalUses) });
      $(`${category}-previous`).disabled = capabilityOffsets[category] === 0;
      $(`${category}-next`).disabled = capabilityOffsets[category] + page.rows.length >= page.total;
      $(`${category}-page`).textContent = page.total ? `${number(capabilityOffsets[category] + 1)}–${number(capabilityOffsets[category] + page.rows.length)} / ${number(page.total)}` : t('dashboard.zeroItems');
    }
  }

  function renderTurnTable(rows, model) {
    const costHeaders = showCosts ? [t('dashboard.estimatedApiCost')] : [];
    const costSortKeys = showCosts ? ['cost'] : [];
    table($('usage-table'), [t('dashboard.projectHeader', { value0: model ? t('common.model') : t('common.provider') }), t('dashboard.requestSessionHeader'), t('dashboard.startTime'), ...tokenHeaders, t('dashboard.totalTokens'), t('dashboard.duration'), t('dashboard.statusQuality'), ...costHeaders], rows.map(row => [
      seriesName(row, model, ` / ${row.project_name}`), sessionLabel(row, true), date(row.started_at_ms), ...tokenValues(row), number(row.total_tokens), duration(row.duration_ms), requestStatusQuality(row), ...costValues(row),
    ]), ['model', undefined, 'period', ...tokenSortKeys, 'averageDuration', undefined, ...costSortKeys]);
  }

  function renderAggregateTable(rows, model, groupBy) {
    const costHeaders = showCosts ? [t('dashboard.estimatedApiCost')] : [];
    const costSortKeys = showCosts ? ['cost'] : [];
    table($('usage-table'), [model ? t('common.model') : t('common.provider'), t('dashboard.periodProjectSession'), ...tokenHeaders, t('dashboard.totalTokens'), t('dashboard.completedTotal'), t('dashboard.averageTokens'), t('dashboard.averageTimeSamples'), ...costHeaders], rows.map(row => [
      seriesName(row, model), usageScopeLabel(row, groupBy), ...tokenValues(row), number(row.total_tokens), `${number(row.completed_turns)} / ${number(row.turn_count)}`, number(row.avg_tokens_per_turn), t('dashboard.timeSamples', { value0: duration(row.avg_duration_ms), value1: number(row.turns_with_duration) }), ...costValues(row),
    ]), ['model', 'period', ...tokenSortKeys, 'requests', 'averageTokens', 'averageDuration', ...costSortKeys]);
  }

  function costValues(row) {
    if (!showCosts) return [];
    const value = estimatedCost(row);
    return [`${value}${row.unknown_costs ? t('dashboard.unknownCostsSuffix', { value0: number(row.unknown_costs) }) : ''}`];
  }

  function estimatedCost(row) {
    if (row.billing_mode === 'subscription') return t('dashboard.subscriptionZero');
    if (row.cost_usd == null) return '—';
    return new Intl.NumberFormat(globalThis.agentTrackerI18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(row.cost_usd);
  }

  function requestStatus(row) {
    if (row.status === 'completed') return t('common.completed');
    if (row.status === 'failed') return t('common.failed');
    return t('common.inProgress');
  }

  function requestStatusQuality(row) {
    const status = requestStatus(row);
    let quality = `${status} · ${row.duration_quality}`;
    if (row.quality_flags) quality += ` · ${row.quality_flags}`;
    if (row.last_error) quality += t('dashboard.previousValueSuffix', { value0: row.last_error });
    return quality;
  }

  function usageScopeLabel(row, groupBy) {
    if (row.period != null) return tableLabel(row.period);
    if (row.session_id) return sessionLabel(row);
    if (row.project_key) return projectLabel(row);
    return tableLabel(['day', 'month'].includes(groupBy) ? t('dashboard.unknownTime') : t('common.all'));
  }

  function updateUsagePagination(rows, total) {
    for (const prefix of ['', 'chart-']) {
      $(`${prefix}previous`).disabled = offset === 0;
      $(`${prefix}next`).disabled = offset + rows.length >= total;
      $(`${prefix}page-label`).textContent = rows.length ? `${number(offset + 1)}–${number(offset + rows.length)} / ${number(total)}` : t('dashboard.zeroItems');
    }
  }

  function updateUsageCoverage(coverage, rows, turn) {
    const durationCoverage = turn ? '' : t('dashboard.timeQualitySuffix', { value0: number(rows.reduce((n, r) => n + (r.exact_duration_turns ?? 0), 0)), value1: number(rows.reduce((n, r) => n + (r.derived_duration_turns ?? 0), 0)), value2: number(rows.reduce((n, r) => n + (r.approximate_duration_turns ?? 0), 0)), value3: number(rows.reduce((n, r) => n + (r.missing_duration_turns ?? 0), 0)) });
    $('coverage').textContent = t('dashboard.coverage', { value0: number(coverage.files), value1: number(coverage.done), value2: number(coverage.error), value3: number(coverage.interrupted), value4: number(coverage.stale_summaries), value5: durationCoverage });
  }
  function setCapabilitiesEnabled(enabled) {
    capabilitiesEnabled = enabled;
    $('skill-content').hidden = !enabled;
    $('skill-disabled').hidden = enabled;
    if (enabled) return;
    for (const category of capabilityCategories) {
      $(`${category}-table`).replaceChildren();$(`${category}-total`).textContent = '';
    }
  }
  /**
   * 책임: Skill 사용량의 상대 막대와 전체 비율을 함께 표시한다.
   * 알고리즘: 막대 길이는 분류 최다 횟수 대비로 계산하고 텍스트 비율은 서버가 전체 합계로 계산한 값을 사용한다.
   */
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
      $('usage-progress').textContent = t('dashboard.refreshResult', { value0: refreshStatus(r), value1: number(r.discovered), value2: number(r.parsed), value3: number(r.reused), value4: number(r.failed), value5: number(r.bodyBytes), value6: r.error ? t('dashboard.reasonSuffix', { value0: r.error }) : '' });
      return;
    }
    if (latestProgress) {
      const p = latestProgress;
      $('usage-progress').textContent = t('dashboard.progress', { value0: ({ scanning: t('dashboard.scanning'), parsing: t('dashboard.parsing'), committing: t('dashboard.committing'), complete: t('common.completed') })[p.phase] ?? p.phase, value1: number(p.discovered), value2: number(p.parsed), value3: number(p.failed) });
      return;
    }
    if (busy) $('usage-progress').textContent = t('dashboard.updating');
  }
  function refreshStatus(result) {
    if (result.interrupted) return t('common.interrupted');
    if (result.failed) return t('dashboard.partialFailure');
    return t('dashboard.updated');
  }
  $('skill-settings').addEventListener('click', () => send({ type: 'settings' }));
  $('open-diagnostics').addEventListener('click', event => { event.preventDefault(); send({ type: 'openDiagnostics' }); });
  $('settings').addEventListener('click', () => send({ type: 'settings' }));
  $('cancel-usage').addEventListener('click', () => send({ type: 'cancelUsage' }));
  $('usage-filters').addEventListener('submit', event => { event.preventDefault(); offset = 0; query(); });
  for (const id of ['from-day', 'to-day']) {
    $(id).addEventListener('input', () => { $(`${id}-picker`).value = $(id).value; });
    $(`${id}-picker`).addEventListener('change', () => { $(id).value = $(`${id}-picker`).value; });
  }
  $('reset-filters').addEventListener('click', () => {
    closeNames(); selectedProject = undefined; selectedSession = undefined;
    for (const id of ['provider', 'from-day', 'to-day', 'from-day-picker', 'to-day-picker']) $(id).value = '';
    $('group').value = 'day'; $('chart-metric').value = 'tokens';
    pageSize = 100;
    for (const category of capabilityCategories) capabilityPageSizes[category] = 100;
    syncPageSizes();
    for (const id of ['page-size', 'chart-page-size', ...capabilityCategories.map(category => `${category}-page-size`)]) $(id).setCustomValidity('');
    nameCaption('project', ''); nameCaption('session', '');
    offset = 0; chartBy = 'provider'; tableSort = { key: 'period', direction: 'desc' }; section = 'tokens'; query();
  });
  for (const name of ['tokens', 'skills']) $(`section-${name}`).addEventListener('click', () => {
    section = name; closeNames(); query();
  });
  for (const category of capabilityCategories) {
    bindPageSize(`${category}-page-size`, value => {
      if (value === capabilityPageSizes[category]) return;
      capabilityPageSizes[category] = value; capabilityOffsets[category] = 0; query(false);
    });
    $(`${category}-previous`).addEventListener('click', () => { capabilityOffsets[category] = Math.max(0, capabilityOffsets[category] - capabilityPageSizes[category]); query(false); });
    $(`${category}-next`).addEventListener('click', () => { capabilityOffsets[category] += capabilityPageSizes[category]; query(false); });
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
    bindPageSize(`${prefix}page-size`, value => {
      if (value === pageSize) return;
      pageSize = value; offset = 0;
      for (const id of ['page-size', 'chart-page-size']) { $(id).value = String(pageSize); $(id).setCustomValidity(''); }
      query();
    });
    $(`${prefix}previous`).addEventListener('click', () => { offset = Math.max(0, offset - pageSize); query(); });
    $(`${prefix}next`).addEventListener('click', () => { offset += pageSize; query(); });
  }
  function applyState(message) {
    updateLocaleCaptions(message);
    if (typeof message.showApiCosts === 'boolean') { showCosts = message.showApiCosts; updateCostControls(); }
    updateCapabilities(message);
    timezone = message.timezone;
    $('timezone').textContent = t('dashboard.timezone', { value0: timezone });
    $('configuration-warning').textContent = message.timezoneWarning ?? '';
    $('configuration-warning').hidden = !message.timezoneWarning;
    updateProviders(message);
    if (latestUsage) renderUsage(latestUsage);
    renderProgress();
  }
  function updateLocaleCaptions(message) {
    if (!globalThis.updateAgentTrackerLocale?.(message.localization)) return;
    if (!selectedProject) nameCaption('project', '');
    if (!selectedSession) nameCaption('session', '');
  }
  function updateCapabilities(message) {
    if (typeof message.capabilitiesEnabled !== 'boolean') return;
    if (latestUsage?.capabilitiesEnabled !== undefined && latestUsage.capabilitiesEnabled !== message.capabilitiesEnabled) latestUsage = undefined;
    setCapabilitiesEnabled(message.capabilitiesEnabled);
  }
  function updateProviders(message) {
    if (!Array.isArray(message.providers)) return;
    for (const option of $('provider').options) option.disabled = Boolean(option.value) && !message.providers.includes(option.value);
    closeNames();
    if (!$('provider').selectedOptions[0]?.disabled) return;
    $('provider').value = '';
    selectedSession = undefined;
    nameCaption('session', '');
    offset = 0;
    query();
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'state': applyState(message); break;
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
