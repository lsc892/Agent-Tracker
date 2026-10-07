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
  let cumulativeBy = 'provider';
  let cumulativeOffset = 0;
  let latestUsage;
  let selectedProject;
  let selectedSession;
  let openNameKind;
  let nameRequestId = 0;
  const namePages = { project: { loaded: 0, total: 0 }, session: { loaded: 0, total: 0 } };
  const saved = vscode.getState();
  if (saved && ['day', 'month', 'project', 'session', 'turn', 'all'].includes(saved.group)) $('group').value = saved.group;
  if (saved && Object.hasOwn(chartMetrics, saved.chartMetric)) $('chart-metric').value = saved.chartMetric;
  if (saved?.cumulativeBy === 'model') cumulativeBy = 'model';
  $('show-costs').checked = saved?.showCosts === true;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function query() {
    const request = { groupBy: $('group').value, offset, cumulativeBy, cumulativeOffset, includeCosts: $('show-costs').checked === true };
    const metric = $('chart-metric').value || 'tokens';
    request.chartMetric = request.groupBy === 'turn' && metric !== 'averageDuration' ? 'tokens' : metric;
    $('chart-metric').value = request.chartMetric;
    if ($('provider').value) request.provider = $('provider').value;
    if (selectedProject) request.projectKey = selectedProject;
    if (selectedSession) request.sessionId = selectedSession;
    if ($('from-day').value) request.fromDay = $('from-day').value;
    if ($('to-day').value) request.toDay = $('to-day').value;
    send({ type: 'queryUsage', query: request });
    vscode.setState({ group: request.groupBy, chartMetric: request.chartMetric, cumulativeBy, showCosts: request.includeCosts });
    $('cost-note').hidden = !request.includeCosts;
    $('billing-control').hidden = !request.includeCosts || !selectedSession || !$('provider').value;
    $('billing-mode').disabled = true;
    for (const by of ['provider', 'model']) $(`cumulative-${by}`).setAttribute('aria-pressed', String(cumulativeBy === by));
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
    closeNames(true); offset = 0; cumulativeOffset = 0; query();
  }
  function chooseSession(row) {
    selectedSession = row?.session_id;
    if (row) {
      selectedProject = row.project_key;
      nameCaption('project', row.project_name || '이름 없는 프로젝트', row.project_key);
      $('provider').value = row.provider;
    }
    nameCaption('session', row ? row.session_name || '이름 없는 세션' : '', row ? `세션 ID: ${row.session_id}` : '');
    closeNames(true); offset = 0; cumulativeOffset = 0; query();
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
  function projectLabel(row) {
    const node = element('button', row.project_name || '이름 없는 프로젝트', 'name-filter');
    node.type = 'button';
    node.title = row.project_key || '';
    node.addEventListener('click', () => chooseProject(row));
    return node;
  }
  function sessionLabel(row, request = false) {
    const node = element('button', `${request ? `${row.root_turn_id} / ` : `${row.project_name || '이름 없는 프로젝트'} / `}${row.session_name || '이름 없는 세션'}`, 'name-filter');
    node.type = 'button';
    node.title = `${row.project_key || ''}\n세션 ID: ${row.session_id}`;
    if (!request) node.append(element('span', date(row.session_started_at_ms), 'muted session-start'));
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
  const compact = value => value == null ? '—' : new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const compactDuration = value => value == null || value < 1000 ? duration(value) : `${compact(value / 1000)}초`;
  function chartValue(row, metric, turn) {
    if (turn) return metric === 'averageDuration' ? row.duration_ms : row.total_tokens;
    return row[({ tokens: 'total_tokens', requests: 'turn_count', averageTokens: 'avg_tokens_per_turn', averageDuration: 'avg_duration_ms' })[metric]];
  }
  function chartLabel(row, mode) {
    const provider = providerLabel(row.provider);
    if (mode === 'turn') return `${provider} · ${date(row.started_at_ms)} · ${row.session_name || '이름 없는 세션'} · 요청 ${row.turn_index} (${row.root_turn_id})`;
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
    return detail;
  }
  function renderChart(result) {
    const chart = result.chart;
    const plot = $('usage-chart');
    plot.replaceChildren();
    $('chart-legend').replaceChildren();
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
    const combined = chart.mode === 'calendar' && rows.some(row => row.period_count > 1);
    $('chart-scope').textContent = chart.mode === 'ranking' ? `상위 ${number(rows.length)} / 전체 ${number(chart.total)}개 · ${title} 순`
      : turn ? `${chart.total > rows.length ? '최근 ' : ''}${number(rows.length)} / 전체 ${number(chart.total)}개 요청 · 시작 시각순`
      : `선택한 전체 조회 범위${combined ? ' · 긴 기간은 최대 30개 구간으로 합산' : ''} · 표 페이지와 독립`;
    if (!rows.length) { plot.append(element('p', '표시할 기록이 없습니다.', 'empty')); return; }
    if (metric === 'tokens') {
      const legendItems = tokenHeaders.map((header, index) => ({ label: header.label, className: `chart-series-${index}` }));
      if (rows.some(row => row.cache_write_input_tokens == null || row.cache_read_input_tokens == null)) legendItems.push({ label: '구성 미확인', className: 'chart-unknown' });
      for (const item of legendItems) {
        const label = element('span', undefined, 'chart-legend-item');
        const swatch = svgElement('svg', { width: 12, height: 12, 'aria-hidden': 'true' });
        swatch.append(svgElement('rect', { width: 12, height: 12, rx: 2, class: item.className }));
        label.append(swatch, element('span', item.label));
        $('chart-legend').append(label);
      }
    }
    const vertical = chart.mode === 'calendar' || turn;
    const categories = vertical ? [...new Set(rows.map((row, index) => turn ? String(index) : row.period))] : [];
    const width = Math.max(plot.clientWidth || 736, 736, vertical ? 86 + categories.length * (turn ? 86 : 128) : 0);
    const height = vertical ? 340 : 62 + rows.length * 62;
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
        const label = turn ? `요청 ${rows[index].turn_index}` : category || '시각 미상';
        const parts = label.split(' ~ ');
        svg.append(svgElement('text', { x, y: 292, 'text-anchor': 'middle', class: 'chart-axis-label' }, parts[0]));
        if (parts[1]) svg.append(svgElement('text', { x, y: 308, 'text-anchor': 'middle', class: 'chart-axis-label' }, `~ ${parts[1]}`));
        if (turn) svg.append(svgElement('text', { x, y: 308, 'text-anchor': 'middle', class: 'chart-axis-label' }, rows[index].started_at_ms == null ? '시각 미상'
          : new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone }).format(new Date(rows[index].started_at_ms))));
      });
    }
    rows.forEach((row, index) => {
      const value = chartValue(row, metric, turn);
      const description = chartDescription(row, chart);
      const group = svgElement('g', { class: 'chart-bar', tabindex: 0, role: 'img', 'aria-label': description });
      group.append(svgElement('title', {}, description));
      const peers = vertical && !turn ? rows.filter(peer => peer.period === row.period) : [row];
      const categoryIndex = turn ? index : categories.indexOf(row.period);
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
      if (vertical) group.append(svgElement('text', { x: x + barSize / 2, y: 274, 'text-anchor': 'middle', class: 'chart-provider' }, providerLabel(row.provider)));
      else {
        const label = chartLabel(row, chart.mode);
        group.append(svgElement('text', { x, y: y - 6, class: 'chart-label' }, label.length > 48 ? `${label.slice(0, 47)}…` : label));
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
    renderChart(result);
    const showCosts = $('show-costs').checked === true;
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
    if (result.cumulative) {
      const cumulative = result.cumulative;
      table($('cumulative-table'), ['제공자', ...(cumulative.by === 'model' ? ['모델'] : []), ...tokenHeaders, '총 토큰', ...costHeaders],
        cumulative.rows.map(row => [providerLabel(row.provider), ...(cumulative.by === 'model' ? [row.model || '모델 미상'] : []), ...tokenValues(row), number(row.total_tokens), ...cost(row)]));
      $('cumulative-previous').disabled = cumulativeOffset === 0;
      $('cumulative-next').disabled = cumulativeOffset + cumulative.rows.length >= cumulative.total;
      $('cumulative-page').textContent = cumulative.total ? `${number(cumulativeOffset + 1)}–${number(cumulativeOffset + cumulative.rows.length)} / ${number(cumulative.total)}` : '0개';
    }
    const turn = result.groupBy === 'turn';
    const rows = result.rows;
    if (turn) {
      table($('usage-table'), ['제공자 / 프로젝트', '요청 / 세션', '시작 시각', ...tokenHeaders, '총 토큰', '소요 시간', '상태 / 품질', ...costHeaders], rows.map(row => [
        `${row.provider} / ${row.project_name}`, sessionLabel(row, true), date(row.started_at_ms), ...tokenValues(row), number(row.total_tokens), duration(row.duration_ms), `${row.status === 'completed' ? '완료' : row.status === 'failed' ? '실패' : '진행 중'} · ${row.duration_quality}${row.quality_flags ? ` · ${row.quality_flags}` : ''}${row.last_error ? ` · 이전 값: ${row.last_error}` : ''}`, ...cost(row),
      ]));
    } else {
      table($('usage-table'), ['제공자', '기간 / 프로젝트 / 세션', ...tokenHeaders, '총 토큰', '완료 / 전체 요청', '평균 토큰', '평균 시간 / 표본', ...costHeaders], rows.map(row => [
        row.provider, row.period ?? (row.session_id ? sessionLabel(row) : row.project_key ? projectLabel(row) : ['day', 'month'].includes(result.groupBy) ? '시각 미상' : '전체'), ...tokenValues(row), number(row.total_tokens), `${number(row.completed_turns)} / ${number(row.turn_count)}`, number(row.avg_tokens_per_turn), `${duration(row.avg_duration_ms)} / ${number(row.turns_with_duration)}개`, ...cost(row),
      ]));
    }
    $('previous').disabled = offset === 0;
    $('next').disabled = offset + rows.length >= result.total;
    $('page-label').textContent = result.total ? `${number(offset + 1)}–${number(offset + rows.length)} / ${number(result.total)}` : '0개';
    const coverage = result.coverage;
    const durationCoverage = turn ? '' : ` · 시간 품질(현재 페이지) 정확 ${number(rows.reduce((n, r) => n + (r.exact_duration_turns ?? 0), 0))} / 계산 ${number(rows.reduce((n, r) => n + (r.derived_duration_turns ?? 0), 0))} / 근사 ${number(rows.reduce((n, r) => n + (r.approximate_duration_turns ?? 0), 0))} / 미상 ${number(rows.reduce((n, r) => n + (r.missing_duration_turns ?? 0), 0))}`;
    $('coverage').textContent = `파일 ${number(coverage.files)} · 정상 ${number(coverage.done)} · 오류 ${number(coverage.error)} · 중단 ${number(coverage.interrupted)} · 이전 수치 유지 요청 ${number(coverage.stale_summaries)}${durationCoverage}`;
  }
  $('open-diagnostics').addEventListener('click', event => { event.preventDefault(); send({ type: 'openDiagnostics' }); });
  $('settings').addEventListener('click', () => send({ type: 'settings' }));
  $('cancel-usage').addEventListener('click', () => send({ type: 'cancelUsage' }));
  $('usage-filters').addEventListener('submit', event => { event.preventDefault(); offset = 0; cumulativeOffset = 0; query(); });
  $('reset-filters').addEventListener('click', () => {
    closeNames(); selectedProject = undefined; selectedSession = undefined;
    for (const id of ['provider', 'from-day', 'to-day']) $(id).value = '';
    $('group').value = 'day'; $('chart-metric').value = 'tokens';
    nameCaption('project', ''); nameCaption('session', '');
    offset = 0; cumulativeOffset = 0; cumulativeBy = 'provider'; query();
  });
  $('show-costs').addEventListener('change', query);
  $('billing-mode').addEventListener('change', () => {
    if (!selectedSession || !$('provider').value) return;
    $('billing-mode').disabled = true;
    send({ type: 'setSessionBilling', provider: $('provider').value, sessionId: selectedSession, mode: $('billing-mode').value });
  });
  for (const by of ['provider', 'model']) $(`cumulative-${by}`).addEventListener('click', () => {
    cumulativeBy = by; cumulativeOffset = 0; query();
  });
  $('cumulative-previous').addEventListener('click', () => { cumulativeOffset = Math.max(0, cumulativeOffset - 100); query(); });
  $('cumulative-next').addEventListener('click', () => { cumulativeOffset += 100; query(); });
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
  $('previous').addEventListener('click', () => { offset = Math.max(0, offset - 100); query(); });
  $('next').addEventListener('click', () => { offset += 100; query(); });
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'state':
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
