// 합성 입력으로 파싱·JSONL·파일 경계·계보 최소화의 A/B 동등성과 독립 기대값을 검증한다.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { existsSync, truncateSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { dirname, join, resolve, sep } = require('node:path');
const { constants, zstdCompressSync } = require('node:zlib');

const options = {};
for (const argument of process.argv.slice(2)) {
  const match = /^--(before|after|output)=(.+)$/.exec(argument);
  assert.ok(match, 'Expected --before/after/output');
  options[match[1]] = resolve(match[2]);
}
assert.ok(options.before && options.after && options.output);
assert.ok(!existsSync(options.output), 'Never overwrite validation reports');
const load = directory => {
  const moduleAt = name => require(join(directory, 'dist/src/summary', name));
  return { ...moduleAt('parsers/common'), ...moduleAt('parsers'), ...moduleAt('parsers/capabilities'),
    ...moduleAt('jsonl'), ...moduleAt('aggregation/parentGroups'),
    ...moduleAt('scanner/sourceReader'), ...moduleAt('scanner/sourceFingerprint') };
};
const apis = [load(options.before), load(options.after)];
const counts = {};
const digest = createHash('sha256');
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const record = (area, value) => {
  counts[area] = (counts[area] ?? 0) + 1;
  digest.update(JSON.stringify([area, value]) ?? 'undefined');
};
function same(area, actual, expected, label) {
  assert.deepEqual(actual[0], actual[1], `${area}: ${label}: A/B`);
  if (arguments.length >= 3) {
    for (const value of actual) assert.deepEqual(value, expected, `${area}: ${label}: independent expectation`);
  }
  record(area, actual[0]);
}
function differential(area, actual, label) {
  assert.deepEqual(actual[0], actual[1], `${area}: ${label}: A/B`);
  record(area, actual[0]);
}
const initialSeed = 0x5112026;
let seed = initialSeed;
const random = limit => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % limit;
};
const vector = (input, output = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0) =>
  ({ input, output, cacheRead, cacheWrite, reasoning });
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

function titleChecks() {
  const cases = [
    [undefined, undefined], [null, undefined], [42, undefined], ['', undefined], ['\r\n  \t', undefined],
    ['Title\nBody', 'Title'], ['# Context\n<metadata>\n  Actual\t title \nBody', 'Actual title'],
    ['#\n# Heading\n<skip>\nNext', 'Next'], ['## Keep heading', '## Keep heading'],
    ['Before\n## My request:\nActual\nBody', 'Actual'],
    ['## My request:One\n## My request:Two', 'Two'],
    ['## My request:\n## My request:Adjacent', '## My request:Adjacent'],
    ['Context\n## My request:\r\n \t\r\n', undefined],
    ['Context\r## My request:No LF', 'Context'],
    ['\u0000\u0001\u007f\nNext', undefined],
    ['\ufeff  한글 😀\t title\nBody', '한글 😀 title'],
    ['x'.repeat(80), 'x'.repeat(80)], ['x'.repeat(81), 'x'.repeat(79) + '…'],
    [[{ type: 'image', text: 'Ignored' }, { type: 'text', text: 'Title\nBody' }], 'Title'],
    [[null, [], { type: 'text', text: '' }, { type: 'input_text', text: ' Input title ' }], 'Input title'],
    [[{ type: 'tool_result', text: 'Ignored' }], undefined],
    [[{ type: 'text', text: 42 }, { type: 'input_text', text: 'Next' }], 'Next'],
  ];
  cases.forEach(([input, expected], index) => same('titles', apis.map(api => api.requestTitle(input)), expected, `fixed-${index}`));
  for (let index = 0; index < 160; index++) {
    const title = `Synthetic ${index} 한글 ${'x'.repeat(random(120))}`;
    const expected = title.length > 80 ? title.slice(0, 79) + '…' : title;
    const prefix = random(2) ? '# Context\n<metadata>\n## My request:\n' : '';
    const text = `${prefix} \t${title}\r\n${'body\n'.repeat(random(80))}`;
    const input = random(2) ? text : [{ type: 'image', data: 'ignored' }, { type: 'text', text }];
    same('titlesSeeded', apis.map(api => api.requestTitle(input)), expected, `seed-${index}`);
  }
}

function capabilityChecks() {
  const use = (category, name, index = 0) => ({ category, name, index });
  const cases = [
    ['Skill', { skill: 'review:check' }, [use('skill', 'review:check'), use('plugin', 'review')]],
    ['Agent', { agent_type: 'Explore' }, [use('subagent', 'Explore')]],
    ['tools.spawn_agent', '{}', [use('subagent', 'default')]],
    ['mcp__docs__search', {}, [use('plugin', 'docs')]],
    ['Read', { file_path: '/plugins/cache/market/review/1/skills/check/SKILL.md' },
      [use('skill', 'review:check'), use('plugin', 'review')]],
    ['exec_command', { cmd: "cat '/skills/alpha/SKILL.md' '/skills/alpha/SKILL.md' /skills/beta/SKILL.md" },
      [use('skill', 'alpha'), use('skill', 'beta')]],
    ['exec_command', { cmd: "echo 'cat /skills/ignored/SKILL.md'" }, []],
    ['exec_command', { cmd: "rg 'cat /skills/ignored/SKILL.md' src" }, []],
    ['exec', 'const ignored="tools.spawn_agent({})"; /* tools.Skill({skill:"ignored"}) */\n'
      + 'await tools.exec_command({cmd:"cat /skills/alpha/SKILL.md"});'
      + 'await tools.mcp__docs__search({});await tools.spawn_agent({agent_type:"Explore"});',
      [use('skill', 'alpha', 0), use('plugin', 'docs', 1), use('subagent', 'Explore', 2)]],
    ['exec', 'tools.exec_command({cmd: `cat ${path}/SKILL.md`})', []],
    ['exec', 'tools.exec_command({cmd: "cat /skills/ignored/SKILL.md" + suffix})', []],
    ['exec', 'tools.exec_command({cmd: "cat /skills/first/SKILL.md",cmd:"cat /skills/second/SKILL.md"})', [use('skill', 'first')]],
    ['exec', 'tools.exec_command({cmd: suffix,cmd:"cat /skills/second/SKILL.md"})', []],
    ['exec', 'tools.exec_command({command:"cat /skills/alpha/SKILL.md"})', [use('skill', 'alpha')]],
    ['exec', 'tools.read_file({path:"/skills/alpha/SKILL.md"})', [use('skill', 'alpha')]],
    ['exec', 'tools.Skill({skill:"review:check"})', [use('skill', 'review:check'), use('plugin', 'review')]],
    ['exec', 'tools.Agent({subagent_type:"Review"})', [use('subagent', 'Review')]],
    ['exec', 'tools.exec_command({cmd:"cat /skills/alph\\u0061/SKILL.md"})', [use('skill', 'alpha')]],
    ['exec', 'tools.exec_command({cmd:"cat /skills/alph\\x61/SKILL.md"})', [use('skill', 'alpha')]],
  ];
  cases.forEach(([name, input, expected], index) => same('capabilities', apis.map(api => [...api.toolCapabilities(name, input)]), expected, `fixed-${index}`));
  for (let index = 0; index < 120; index++) {
    const calls = [], expected = [];
    const total = 1 + random(7);
    for (let call = 0; call < total; call++) {
      const name = `synthetic-${index}-${call}`;
      switch (random(4)) {
        case 0:
          calls.push(`tools.exec_command({cmd: "cat /skills/${name}/SKILL.md /skills/${name}/SKILL.md"})`);
          expected.push(use('skill', name, call)); break;
        case 1:
          calls.push(`tools.spawn_agent({agent_type: '${name}'})`);
          expected.push(use('subagent', name, call)); break;
        case 2:
          calls.push(`tools.mcp__synthetic_${index}_${call}__lookup({query: 'ignored'})`);
          expected.push(use('plugin', `synthetic_${index}_${call}`, call)); break;
        case 3:
          calls.push('tools.exec_command({cmd: "cat /skills/ignored/SKILL.md" + dynamic})'); break;
      }
    }
    const code = '/* tools.spawn_agent({}) */\n' + calls.join(';\n');
    same('capabilitiesSeeded', apis.map(api => [...api.toolCapabilities('functions.exec', code)]), expected, `seed-${index}`);
  }
}

function parse(api, provider, rows, collectCapabilities = true) {
  const events = [], children = [], identities = [];
  const sink = { event: value => events.push(clone(value)), identity: value => identities.push(clone(value)),
    child: (reference, root) => children.push([reference, root]) };
  const Parser = provider === 'claude' ? api.ClaudeParserAdapter : api.CodexCurrentParserAdapter;
  const parser = new Parser({ provider, path: '/synthetic/session.jsonl', sourceRoot: '/synthetic', fileId: 1, collectCapabilities }, sink);
  let offset = 0, error;
  try {
    for (const row of rows) {
      parser.row(clone(row), offset);
      offset += Buffer.byteLength(JSON.stringify(row)) + 1;
    }
    parser.finish();
  } catch (value) { error = { code: value.code ?? value.name, offset: value.offset ?? 0 }; }
  return { events, children, identities, identity: clone(parser.getIdentity()), error };
}
const meta = (extra = {}) => ({ type: 'session_meta', payload: { id: 'thread', cwd: '/synthetic', ...extra } });
const lifecycle = (type, extra = {}) => ({ type: 'event_msg', timestamp: '2026-11-01T00:00:00.000Z', payload: { type, ...extra } });
const current = (root = 'root', extra = {}) => ({ type: 'token_usage_record', payload: {
  root_turn_id: root, turn_id: root, response_id: 'response', usage: { input_tokens: 12, output_tokens: 3 }, ...extra } });
const legacy = (total, last) => ({ type: 'event_msg', payload: { type: 'token_count', info: {
  ...(total === undefined ? {} : { total_token_usage: total }), ...(last === undefined ? {} : { last_token_usage: last }) } } });

function parserChecks() {
  const claude = [
    { billing_mode: 'api' }, { type: 'custom-title', customTitle: 'Custom title' },
    { type: 'ai-title', aiTitle: 'Ignored AI title' },
    { type: 'user', sessionId: 'session', promptId: 'root', timestamp: 123,
      message: { content: [{ type: 'text', text: 'Request title\nBody' }] } },
    { type: 'assistant', promptId: 'root', timestamp: 200, message: { id: 'response', model: 'model', stop_reason: 'end_turn',
      content: [{ type: 'tool_use', id: 'tool', name: 'Skill', input: { skill: 'review:check' } }],
      usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 4 } } },
    { type: 'system', subtype: 'stop_hook_summary', preventedContinuation: true, timestamp: 250 },
    { type: 'system', subtype: 'turn_duration', durationMs: 999, timestamp: 300 },
    { type: 'system', subtype: 'stop_hook_summary', preventedContinuation: false, timestamp: 350 },
    { type: 'system', subtype: 'turn_duration', durationMs: 227, timestamp: 350 },
    { type: 'user', uuid: 'next', message: { content: 'Next request' } },
    { type: 'user', uuid: 'tool-result', message: { content: [{ type: 'tool_result', content: 'ignored' }] } },
    { type: 'user', uuid: 'meta', isMeta: true, message: { content: 'ignored' } },
    { type: 'user', uuid: 'sidechain', isSidechain: true, message: { content: 'ignored' } },
  ];
  const results = apis.map(api => parse(api, 'claude', claude));
  differential('parserEvents', results, 'Claude full lifecycle and event order');
  for (const result of results) {
    assert.equal(result.error, undefined);
    assert.deepEqual(result.events.slice(0, 5).map(value => value.kind), ['turn', 'capability', 'capability', 'usage', 'turn']);
    assert.deepEqual(result.events.filter(value => value.title).map(value => [value.rootId, value.title]), [['root', 'Request title'], ['next', 'Next request']]);
    assert.deepEqual(result.events.find(value => value.kind === 'usage').tokens, vector(16, 3, 2, 4));
    assert.equal(result.identity.sessionName, 'Custom title');
    assert.equal(result.events.filter(value => value.duration === 999).length, 0);
    assert.equal(result.events.filter(value => value.duration === 227).length, 1);
  }
  record('parserIndependent', 'Claude event order, tokens, title precedence, blocked duration');

  const codex = [meta({ billing_mode: 'api' }), { type: 'turn_context', payload: { turn_id: 'root', model: 'model' } },
    lifecycle('task_started', { turn_id: 'root', started_at: 1 }),
    lifecycle('user_message', { message: '# Context\n## My request:\nRequest title' }),
    { type: 'response_item', payload: { type: 'function_call', call_id: 'spawn', name: 'spawn_agent', arguments: '{"agent_type":"Explore"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'spawn', output: '{"agent_id":"child","task_name":"child-task"}' } },
    current('root', { thread_id: 'thread', session_id: 'session', turn_token_usage: { input_tokens: 12, output_tokens: 3 } }),
    lifecycle('task_completed', { completed_at: 2, duration_ms: 1000 }),
  ];
  const currentResults = apis.map(api => parse(api, 'codex', codex));
  differential('parserEvents', currentResults, 'Codex current lifecycle and child binding');
  for (const result of currentResults) {
    assert.equal(result.error, undefined);
    assert.deepEqual(result.children, [['child', 'root'], ['child-task', 'root']]);
    assert.equal(result.identity.sessionId, 'session');
    assert.deepEqual(result.events.map(value => value.kind), ['turn', 'turn', 'capability', 'usage', 'check', 'turn']);
    assert.deepEqual(result.events.find(value => value.kind === 'usage').tokens, vector(12, 3));
    assert.equal(result.events[0].startedAt, 1000); assert.equal(result.events.at(-1).completedAt, 2000);
  }
  record('parserIndependent', 'Codex current IDs, order, child binding and Unix seconds');

  const legacyRows = [meta({ forked_from_id: 'ancestor' }), { type: 'turn_context', payload: { turn_id: 'root' } },
    legacy({ input_tokens: 10, output_tokens: 2 }), legacy({ input_tokens: 10, output_tokens: 2 }),
    legacy({ input_tokens: 6, output_tokens: 1 }), legacy({ input_tokens: 15, output_tokens: 4 }),
    legacy(undefined, { input_tokens: 3, output_tokens: 1 }),
    legacy({ input_tokens: 16, output_tokens: 5 }, { input_tokens: 1, output_tokens: 1, cached_input_tokens: 9 }),
  ];
  const legacyResults = apis.map(api => parse(api, 'codex', legacyRows));
  differential('parserEvents', legacyResults, 'legacy regression, duplicate signature, last-only and flags');
  for (const result of legacyResults) {
    const usage = result.events.filter(value => value.kind === 'usage');
    assert.deepEqual(usage.map(value => [value.tokens.input, value.tokens.output]), [[10, 2], [0, 0], [5, 2], [3, 1], [1, 1]]);
    assert.deepEqual(usage.map(value => value.flags), [['missing-parent'], ['missing-parent', 'counter-regression'],
      ['missing-parent'], ['missing-parent'], ['missing-parent', 'component-clamped']]);
  }
  record('parserIndependent', 'legacy high-water, no duplicate, flag order and component overflow');

  const boundaries = [
    ['codex', [current()], 'missing-session-id'],
    ['codex', [meta(), current('', { turn_id: '' })], 'missing-root-turn'],
    ['codex', [meta(), current('root', { response_id: '' })], 'missing-response-id'],
    ['codex', [meta(), current('root', { usage: {} })], 'unsupported-token-schema'],
    ['claude', [{ type: 'assistant', message: { id: 'r', usage: { input_tokens: 1 } } }], 'missing-root-turn'],
    ['claude', [{ type: 'user', promptId: 'r' }, { type: 'assistant', message: { usage: { input_tokens: 1 } } }], 'missing-response-id'],
  ];
  for (const [provider, rows, code] of boundaries) {
    const actual = apis.map(api => parse(api, provider, rows));
    differential('parserFailures', actual, code);
    for (const result of actual) assert.equal(result.error.code, code);
  }
  const special = [
    [meta({ parent_thread_id: 'parent' }), legacy(undefined, { input_tokens: 3, output_tokens: 1 })],
    [meta({ id: 'child', parent_thread_id: 'parent', forked_from_id: 'parent' }), meta({ id: 'parent', cwd: '/ignored' }),
      { type: 'turn_context', payload: { root_turn_id: 'parent-root', turn_id: 'child-turn' } }, current('parent-root', { turn_id: 'child-turn' })],
    [meta(), { type: 'turn_context', payload: { turn_id: 'root' } }, legacy({ input_tokens: 3, output_tokens: 1 }), current(),
      legacy({ input_tokens: 99, output_tokens: 99 })],
  ];
  special.forEach((rows, index) => differential('parserLineage', apis.map(api => parse(api, 'codex', rows)), `lineage-${index}`));
  for (let index = 0; index < 80; index++) {
    const input = 1 + random(200), output = random(50), cache = random(30), provider = index % 2 ? 'codex' : 'claude';
    const rows = provider === 'codex' ? [meta(), lifecycle('task_started', { turn_id: 'root', started_at: random(20000) }),
      current('root', { usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cache } }),
      lifecycle(index % 3 ? 'task_complete' : 'turn_aborted', { completed_at: random(20000), duration_ms: random(10000) })]
      : [{ type: 'user', promptId: 'root', message: { content: `Title ${index}` } },
        { type: 'assistant', promptId: 'root', message: { id: 'response', model: index % 3 ? 'model' : '<synthetic>',
          content: [{ type: 'text', text: 'body' }], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cache } } }];
    const actual = apis.map(api => parse(api, provider, rows, index % 3 !== 0));
    differential('parserSeeded', actual, `seed-${index}`);
    for (const result of actual) {
      assert.equal(result.error, undefined);
      const usage = result.events.find(value => value.kind === 'usage');
      assert.deepEqual(usage.tokens, vector(input + (provider === 'claude' ? cache : 0), output, cache));
      assert.equal(usage.rootId, 'root');
    }
    record('parserIndependentSeeded', index);
  }
  for (const raw of [{}, { unknown: 1 }, { input_tokens: '1' }, { input_tokens: -1 }, { input_tokens: 0.5 }, { input_tokens: Infinity }]) {
    for (const method of ['codexTokens', 'claudeTokens']) {
      const actual = apis.map(api => { try { api[method](raw); return 'accepted'; } catch (error) { return error.code; } });
      same('tokenSchema', actual, 'unsupported-token-schema', method);
    }
  }
}

function lineageOracle(items) {
  const ids = [...new Set(items.map(item => item.id))], resolved = new Map();
  for (const id of ids) {
    const visited = new Set();
    let current = id, root = null;
    while (!visited.has(current)) {
      visited.add(current);
      const own = items.filter(item => item.id === current), parents = [...new Set(own.map(item => item.parentId))];
      if (parents.length !== 1) break;
      if (parents[0] === null) { root = current; break; }
      current = parents[0];
    }
    resolved.set(id, root);
  }
  const entries = ids.map(id => {
    const root = resolved.get(id);
    const members = ids.filter(other => root === null ? other === id : resolved.get(other) === root)
      .sort().map(other => [other, items.filter(item => item.id === other).map(item => item.value)]);
    return [id, { rootId: root ?? id, unresolved: root === null, members }];
  });
  return entries.sort(([a], [b]) => a.localeCompare(b));
}
function lineageSnapshot(result, expected) {
  const snapshots = [...result.groups].map(([id, group]) => [id, { rootId: group.rootId,
    unresolved: result.unresolved.has(id), members: [...group.members].sort(([a], [b]) => a.localeCompare(b)) }])
    .sort(([a], [b]) => a.localeCompare(b));
  const representatives = new Map();
  for (const [id, value] of expected) {
    if (value.unresolved) continue;
    if (representatives.has(value.rootId)) assert.equal(result.groups.get(id), representatives.get(value.rootId), 'Resolved members share a group object');
    else representatives.set(value.rootId, result.groups.get(id));
  }
  return snapshots;
}
function lineageChecks() {
  const item = (id, parentId, value = id) => ({ id, parentId, value });
  const cases = [[], [item('root', null)], [item('child', 'root'), item('root', null), item('peer', 'root')],
    [item('leaf', 'child'), item('child', 'root'), item('root', null), item('leaf', 'child', 'duplicate')],
    [item('missing', 'absent'), item('dependent', 'missing'), item('root', null)],
    [item('conflict', null), item('conflict', 'root'), item('root', null), item('dependent', 'conflict')],
    [item('a', 'b'), item('b', 'a'), item('dependent', 'a'), item('ok', null)], [item('self', 'self')],
    [item('', null), item('child', ''), item('child', '', { nested: ['duplicate', 1] })],
    Array.from({ length: 350 }, (_, index) => item(`deep-${index}`, index ? `deep-${index - 1}` : null)).reverse(),
  ];
  for (let index = 0; index < 160; index++) {
    const total = 2 + random(38), rows = [];
    for (let node = 0; node < total; node++) {
      const id = `node-${node}`, choice = random(total + 4);
      const parent = choice >= total ? choice === total ? null : `absent-${choice}` : `node-${choice}`;
      rows.push(item(id, parent, { node, occurrence: 0 }));
      if (random(4) === 0) rows.push(item(id, random(3) ? parent : null, { node, occurrence: 1 }));
    }
    for (let swap = rows.length - 1; swap > 0; swap--) { const other = random(swap + 1); [rows[swap], rows[other]] = [rows[other], rows[swap]]; }
    cases.push(rows);
  }
  cases.forEach((rows, index) => {
    const expected = lineageOracle(rows);
    same('parentGroups', apis.map(api => lineageSnapshot(api.groupParents(clone(rows)), expected)), expected, `graph-${index}`);
  });
}

async function observeJsonl(api, path, data, settings = {}) {
  await fs.writeFile(path, data);
  const rows = [], chunks = [], controller = new AbortController();
  let bytes = 0, batches = 0;
  try {
    const result = await api.readJsonl(path, settings.size ?? data.length, (row, offset) => {
      rows.push({ row, offset }); return rows.length < (settings.stopAfter ?? Infinity);
    }, { maxLineBytes: settings.budget, signal: controller.signal,
      onBytes: count => { bytes += count; if (settings.abort) controller.abort(); },
      onChunk: chunk => chunks.push(Buffer.from(chunk)), processBatch: run => {
        batches++; run(); if (settings.truncate && batches === 1) truncateSync(path, 64 * 1024);
      } });
    return { result, rows, bytes, batches, rawHash: hash(Buffer.concat(chunks)) };
  } catch (error) { return { error: { code: error.code ?? error.name, offset: error.offset ?? 0 }, rows, bytes, batches,
    rawHash: hash(Buffer.concat(chunks)) }; }
}
async function jsonlChecks(directory) {
  const cases = [];
  const add = (name, source, expectedRows, settings = {}, error) => cases.push({ name, data: Buffer.from(source), expectedRows, settings, error });
  add('ordinary-blank-crlf', ' \r\n{"value":"한글 😀"}\r\n{"next":true}\n',
    [{ row: { value: '한글 😀' }, offset: 3 }, { row: { next: true }, offset: Buffer.byteLength(' \r\n{"value":"한글 😀"}\r\n') }]);
  add('empty', '', []);
  add('partial-ordinary', '{"ok":true}\n{"pending":', [{ row: { ok: true }, offset: 0 }]);
  add('partial-image', '{"image":"data:image/png;base64,' + 'A'.repeat(70 * 1024), [], { budget: 100 });
  add('escaped-image-prefix', '{"image":"data:im\\u0061ge/png;base64,kept"}\n', [{ row: { image: 'data:image/png;base64,kept' }, offset: 0 }]);
  add('escaped-image-body', '{"image":"data:image/png;base64,AA\\u0041\\\"AA\\/"}\n', [{ row: { image: 'data:image/png;base64,' }, offset: 0 }]);
  for (const malformed of ['\\q', '\\u12x4', '\t', '\u0000']) add('invalid-image', '{"image":"data:image/png;base64,AA' + malformed + 'AA"}\n', [], {}, 'parse-error');
  for (const malformed of ['null\n', '[]\n', '1\n']) add('unsupported', malformed, [], {}, 'unsupported-schema');
  add('invalid-json', '{bad}\n', [], {}, 'parse-error');
  add('budget', '{"text":"' + 'x'.repeat(1000) + '"}\n', [], { budget: 128 }, 'line-byte-budget-exceeded');
  add('truncated-file', '{"ok":true}\n', [{ row: { ok: true }, offset: 0 }], { size: 100 }, 'file-truncated-during-read');
  add('abort', '{"text":"' + 'x'.repeat(128 * 1024) + '"}\n', [], { abort: true }, 'interrupted');
  add('truncate-next-chunk', '{"text":"' + 'x'.repeat(128 * 1024) + '"}\n', [], { truncate: true }, 'file-truncated-during-read');
  add('early-stop', '{"first":true}\n{"second":true}\n', [{ row: { first: true }, offset: 0 }], { stopAfter: 1 });
  const header = '{"image":"DaTa:ImAgE/png;BaSe64,';
  for (let boundary = 0; boundary <= header.length; boundary++) {
    const first = JSON.stringify({ padding: 'x'.repeat(64 * 1024 - boundary - 15) }) + '\n';
    const second = header + 'A'.repeat(70 * 1024) + '","value":"한글 😀"}\r\n';
    add(`image-boundary-${boundary}`, first + second,
      [{ row: JSON.parse(first), offset: 0 }, { row: { image: 'DaTa:ImAgE/png;BaSe64,', value: '한글 😀' }, offset: Buffer.byteLength(first) }], { budget: 128 * 1024 });
  }
  const first = '{"text":"' + 'x'.repeat(64 * 1024 - 10) + '한글 😀'.repeat(12000) + '"}\n';
  add('utf8-boundary', first, [{ row: JSON.parse(first), offset: 0 }]);
  const snapshotSource = '{"first":true}\n{"second":true}\n';
  add('snapshot-before-suffix', snapshotSource, [{ row: { first: true }, offset: 0 }], { size: Buffer.byteLength('{"first":true}\n') });
  for (let index = 0; index < 36; index++) {
    const rows = Array.from({ length: 1 + random(8) }, (_unused, row) => ({ row, text: `한글 ${index} ${'x'.repeat(random(200))}`, value: random(10000) }));
    const lines = rows.map(value => JSON.stringify(value) + (index % 2 ? '\r\n' : '\n'));
    let offset = 0;
    const expected = rows.map((row, position) => { const value = { row, offset }; offset += Buffer.byteLength(lines[position]); return value; });
    add(`seed-${index}`, lines.join('') + (index % 3 ? '{"partial":' : ''), expected);
  }
  for (const entry of cases) {
    const actual = [];
    for (const api of apis) actual.push(await observeJsonl(api, join(directory, 'jsonl.jsonl'), entry.data, entry.settings));
    differential('jsonl', actual, entry.name);
    for (const value of actual) {
      assert.deepEqual(value.rows, entry.expectedRows, `JSONL independent rows: ${entry.name}`);
      if (entry.error) assert.equal(value.error.code, entry.error, `JSONL error: ${entry.name}`);
      else {
        assert.equal(value.error, undefined, `JSONL success: ${entry.name}`);
        assert.equal(value.result.rows, entry.expectedRows.length);
        const observed = entry.settings.size ?? entry.data.length;
        assert.equal(value.rawHash, hash(entry.data.subarray(0, observed)));
      }
    }
    record('jsonlIndependent', entry.name);
  }
  const compress = source => zstdCompressSync(Buffer.from(source), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  const compressed = compress('{"first":true}\n{"image":"data:image/png;base64,' + 'A'.repeat(70 * 1024) + '"}\n');
  const firstFrame = compress('{"first":true}\n'), secondFrame = compress('{"second":true}\n{"partial":');
  const skip = Buffer.alloc(8); skip.writeUInt32LE(0x184d2a5f); skip.writeUInt32LE(16, 4);
  const zstdCases = [
    ['image-frame', compressed, undefined, 2, false],
    ['concatenated', Buffer.concat([firstFrame, secondFrame]), undefined, 2, true],
    ['frame-snapshot', Buffer.concat([firstFrame, secondFrame]), firstFrame.length, 1, false],
    ['skippable', Buffer.concat([skip, Buffer.alloc(16), firstFrame]), undefined, 1, false],
    ['empty-frame', compress(''), undefined, 0, false],
    ['short-frame', compressed.subarray(0, compressed.length - 1), undefined, undefined, undefined, 'decompression-error'],
    ['invalid-magic', Buffer.from('invalid synthetic frame'), undefined, undefined, undefined, 'decompression-error'],
  ];
  for (const [name, data, size, rows, partial, error] of zstdCases) {
    const actual = [];
    for (const api of apis) actual.push(await observeJsonl(api, join(directory, 'compressed.jsonl.zst'), data, { size, budget: 1024 }));
    differential('zstd', actual, name);
    for (const value of actual) {
      if (error) assert.equal(value.error.code, error);
      else { assert.equal(value.error, undefined); assert.equal(value.result.rows, rows); assert.equal(value.result.partialLine, partial); }
    }
    record('zstdIndependent', name);
  }
}

async function metadata(path, data) {
  const stat = await fs.lstat(path);
  return { id: 1, provider: 'codex', source_root: dirname(path), path, session_id: null,
    size_bytes: data.length, mtime_ms: stat.mtimeMs, dev: String(stat.dev), inode: String(stat.ino), parser_version: 1,
    content_hash: hash(data) };
}
async function sourceChecks(directory) {
  const path = join(directory, 'source.jsonl'), accepted = Buffer.from(jsonl([meta(), lifecycle('task_started', { turn_id: 'root' }), current()]));
  for (const kind of ['normal', 'appended', 'wrong-inode', 'wrong-time', 'partial', 'parser-error', 'directory']) {
    const actual = [];
    for (const api of apis) {
      const data = kind === 'partial' ? Buffer.concat([accepted, Buffer.from('{"partial":')])
        : kind === 'parser-error' ? Buffer.concat([accepted, Buffer.from('{bad}\n')]) : accepted;
      await fs.writeFile(path, data);
      let file = await metadata(path, data);
      if (kind === 'appended') await fs.appendFile(path, '{"unobserved":true}\n');
      if (kind === 'wrong-inode') file.inode = '-1';
      if (kind === 'wrong-time') file.mtime_ms -= 10000;
      if (kind === 'directory') file = { ...file, path: directory, size_bytes: 0 };
      const events = [], identities = [], children = [];
      let bytes = 0, result, error;
      try {
        result = await api.readSource(file, (value, index) => events.push([index, clone(value)]), {
          cancelled: () => false, collectCapabilities: true, onBytes: value => { bytes += value; },
          onIdentity: value => identities.push(clone(value)), onChild: (reference, root) => children.push([reference, root]) });
      } catch (value) { error = { code: value.code ?? value.name, offset: value.offset ?? 0 }; }
      actual.push({ result, error, events, identities, children, bytes });
    }
    differential('sourceReader', actual, kind);
    for (const value of actual) {
      if (['wrong-inode', 'directory'].includes(kind)) assert.equal(value.error.code, 'file-replaced-during-read');
      else if (kind === 'wrong-time') assert.equal(value.error.code, 'file-rewritten-during-read');
      else if (kind === 'parser-error') { assert.equal(value.error.code, 'parse-error'); assert.equal(value.identities.length, 1); }
      else {
        assert.equal(value.error, undefined);
        assert.equal(value.result.contentHash, hash(kind === 'partial' ? Buffer.concat([accepted, Buffer.from('{"partial":')]) : accepted));
        assert.equal(value.result.partialLine, kind === 'partial'); assert.equal(value.result.identity.threadId, 'thread');
        assert.deepEqual(value.events.map(([index]) => index), value.events.map((_entry, index) => index));
      }
    }
    record('sourceReaderIndependent', kind);
  }
  const whole = Buffer.concat([accepted, Buffer.from('{"extra":true}\n')]);
  for (const kind of ['prefix-match', 'same-size-match', 'prefix-mismatch', 'whole-hash-mismatch', 'missing-hash', 'previous-larger', 'empty-previous']) {
    const actual = [];
    for (const api of apis) {
      await fs.writeFile(path, whole);
      const currentFile = await metadata(path, whole), previous = { ...currentFile, size_bytes: accepted.length, content_hash: hash(accepted) };
      if (kind === 'same-size-match') previous.size_bytes = whole.length, previous.content_hash = hash(whole);
      if (kind === 'prefix-mismatch') previous.content_hash = hash('wrong prefix');
      if (kind === 'whole-hash-mismatch') currentFile.content_hash = hash('wrong whole');
      if (kind === 'missing-hash') currentFile.content_hash = null;
      if (kind === 'previous-larger') previous.size_bytes = whole.length + 1;
      if (kind === 'empty-previous') previous.size_bytes = 0;
      let result, error, bytes = 0;
      try { result = await api.includesSourceSnapshot(currentFile, previous, { check() {}, onBytes: count => { bytes += count; } }); }
      catch (value) { error = { code: value.code ?? value.name, offset: value.offset ?? 0 }; }
      actual.push({ result, error, bytes });
    }
    differential('sourceFingerprint', actual, kind);
    for (const value of actual) {
      if (kind === 'whole-hash-mismatch') assert.equal(value.error.code, 'file-rewritten-during-read');
      else { assert.equal(value.error, undefined); assert.equal(value.result, ['prefix-match', 'same-size-match'].includes(kind)); }
    }
    record('sourceFingerprintIndependent', kind);
  }
  const target = join(directory, 'symlink-target.jsonl'), link = join(directory, 'symlink.jsonl');
  await fs.writeFile(target, accepted);
  try {
    await fs.symlink(target, link, 'file');
    const file = await metadata(link, accepted), actual = [];
    for (const api of apis) {
      try { await api.readSource(file, () => {}, { cancelled: () => false, collectCapabilities: true, onBytes() {} }); actual.push('accepted'); }
      catch (error) { actual.push(error.code ?? error.name); }
    }
    same('sourceSymlink', actual, 'file-replaced-during-read', 'lstat rejects symbolic links');
    return { symbolicLink: 'passed' };
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return { symbolicLink: `unavailable-${error.code}` };
    throw error;
  }
}

async function main() {
  titleChecks(); capabilityChecks(); parserChecks(); lineageChecks();
  const directory = await fs.mkdtemp(join(tmpdir(), 'agent-tracker-algorithm-parsing-'));
  let filesystem;
  try { await jsonlChecks(directory); filesystem = await sourceChecks(directory); }
  finally {
    const absolute = resolve(directory), temporaryRoot = resolve(tmpdir());
    assert.ok(absolute.startsWith(temporaryRoot + sep) && absolute.slice(temporaryRoot.length + 1).startsWith('agent-tracker-algorithm-parsing-'));
    await fs.rm(absolute, { recursive: true, force: true });
  }
  const report = { schemaVersion: 1, date: '2026-11-11', timezone: 'Asia/Seoul', passed: true,
    scope: 'Synthetic parsing, capability extraction, JSONL, Zstd, file identity and parent lineage correctness',
    initialSeed, finalSeed: seed, checks: counts, totalChecks: Object.values(counts).reduce((sum, count) => sum + count, 0),
    filesystem, resultDigest: digest.digest('hex'), privacy: 'Synthetic inputs only; no raw records, paths, account identifiers or credentials in this report',
    limitations: ['No performance measurements in this validation', 'No private real-log parser oracle',
      'Parent-group Map key iteration order is excluded; per-root member arrays and shared group object identity are checked'] };
  await fs.mkdir(dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
