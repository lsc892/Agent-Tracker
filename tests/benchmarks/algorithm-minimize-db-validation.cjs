// 승인된 알고리즘 최소화 A/B를 합성 입력·기존 독립 집계 helper·변경 경계로 대조한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { dirname, join, resolve } = require('node:path');
const { verifyAggregates } = require('./transaction-batch-validation.cjs');

const options = {};
for (const argument of process.argv.slice(2)) {
  const match = /^--(before|after|output)=(.+)$/.exec(argument);
  assert.ok(match, 'Expected --before/after/output'); options[match[1]] = resolve(match[2]);
}
assert.ok(options.before && options.after && options.output);
assert.ok(!fs.existsSync(options.output), 'Never overwrite validation reports');
const hash = value => createHash('sha256').update(value).digest('hex');
const normalize = value => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => key !== 'recorded_at').map(key => [key, normalize(value[key])]));
  return typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(12)) : value;
};
const canonical = value => JSON.stringify(normalize(value));
const equal = (actual, expected, label) => assert.equal(canonical(actual), canonical(expected), label);
const load = directory => ({ directory,
  Database: require(join(directory, 'dist/src/summary/db')).SummaryDatabase,
  raw: require(join(directory, 'dist/src/summary/db/queries')).buildUsageQuery,
  pricingVersion: require(join(directory, 'dist/src/summary/models/pricing')).PRICING_VERSION,
});
const apis = { A: load(options.before), B: load(options.after) };
const zone = 'Asia/Seoul', first = Date.UTC(2026, 9, 30, 14), categories = ['skill', 'subagent', 'plugin', 'model'];
const groups = ['total', 'day', 'month', 'project', 'session', 'turn'];
const sortKeys = ['model', 'period', 'input', 'output', 'cacheWrite', 'cacheRead', 'tokens',
  'requests', 'averageTokens', 'averageDuration', 'cost'];

function fixture(index, extra = {}) {
  const provider = index % 2 ? 'codex' : 'claude', input = index % 9 ? 30 + index % 5 * 6 : 0;
  const output = input ? (index % 5 + 1) * 3 : 0;
  const cache = index % 4 ? 0 : null;
  const known = provider === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.4';
  let models;
  if (index % 6) {
    models = [{ model: index % 7 ? known : '', input_tokens: input, output_tokens: output,
      cache_write_input_tokens: cache, cache_read_input_tokens: cache }];
    if (index % 3 === 0) {
      models[0].input_tokens = input / 3; models[0].output_tokens = output / 3;
      models.push({ ...models[0], model: index % 5 ? 'synthetic-unpriced' :
        provider === 'claude' ? 'claude-haiku-4-5' : 'gpt-5.2', input_tokens: input * 2 / 3, output_tokens: output * 2 / 3 });
    }
  }
  return { provider, session_id: `session-${index % 12}`, project_key: `/fixture/project-${index % 7}`,
    project_name: index % 5 ? `Project ${index % 7}` : '같은 이름', session_name: index % 11 ? `Session ${index % 12}` : null,
    root_turn_id: `request-${String(index).padStart(3, '0')}`, request_title: `Synthetic request ${index}`,
    started_at_ms: index % 13 ? first + index % 10 * 86400000 + index * 170000 : null,
    completed_at_ms: index % 13 ? first + index % 10 * 86400000 + index * 170000 + 1000 + index : null,
    input_tokens: input, output_tokens: output, total_tokens: input + output,
    cache_write_input_tokens: cache, cache_read_input_tokens: cache,
    duration_ms: index % 4 ? 1000 + index : null,
    duration_quality: ['missing', 'exact', 'derived', 'approximate'][index % 4],
    status: ['completed', 'in_progress', 'failed'][index % 3],
    quality_flags: index % 17 ? null : '["synthetic-quality"]', last_error: index % 19 ? null : 'synthetic-error',
    updated_at: '2026-11-11T00:00:00.000Z', billing: ['api', 'subscription', 'unknown'][index % 3], model_usage: models,
    capability_usage: categories.map((category, offset) => ({ category, name: index % 14 ? `${category}-${(index + offset) % 9}` : '',
      usage_count: index % 5 + 1 })), ...extra };
}

function replacement(rows, extra = {}) {
  return { sessions: [...new Map(rows.map(item => [canonical([item.provider, item.session_id]),
    { provider: item.provider, session_id: item.session_id }])).values()],
  summaries: rows, files: [], scanId: 'algorithm-minimize-validation', ...extra };
}

function snapshot(db) {
  return canonical(db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => [name, db.connection.prepare(`SELECT * FROM ${name}`).all()
      .sort((a, b) => canonical(a).localeCompare(canonical(b)))]));
}

function integrity(db) {
  equal(db.connection.prepare('PRAGMA foreign_key_check').all(), [], 'foreign keys');
  assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
}

function paired(action) {
  const dbs = Object.fromEntries(Object.entries(apis).map(([name, api]) => [name, new api.Database(':memory:')]));
  try {
    const result = action(dbs);
    equal(snapshot(dbs.A), snapshot(dbs.B), 'A/B complete persistent tables including IDs');
    for (const db of Object.values(dbs)) integrity(db);
    return result;
  } finally { for (const db of Object.values(dbs)) db.close(); }
}

function noInternalMetadata(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!/^_(?:total|totalUses|maxUses)$/.test(key), `Internal metadata leaked: ${key}`);
    noInternalMetadata(child);
  }
}

function inMode(db, mode, action) {
  if (mode !== 'forced-raw') return action();
  return db.transaction(() => {
    const version = db.connection.prepare('SELECT format_version FROM usage_rollup_meta').get().format_version;
    db.connection.prepare('UPDATE usage_rollup_meta SET format_version=?').run(version + 100);
    try { return action(); }
    finally { db.connection.prepare('UPDATE usage_rollup_meta SET format_version=?').run(version); }
  });
}

function pagesAndQueries() {
  return paired(dbs => {
    const rows = Array.from({ length: 96 }, (_, index) => fixture(index));
    for (const db of Object.values(dbs)) db.replaceMemory(replacement(rows));
    let independentAggregateChecks = 0, pageComparisons = 0, fullComparisons = 0, sortComparisons = 0, cursorComparisons = 0;
    const filters = [{}, { provider: 'claude' }, { providers: ['codex'] }, { providers: [] },
      { projectKey: '/fixture/project-1' }, { sessionId: 'session-3' }, { projectName: '같은', sessionName: 'Session' },
      { fromMs: first + 1234567, toMs: first + 3 * 86400000 + 7654321, unknownTime: 'include', excludeEmptyUsage: true },
      { fromMs: first, toMs: first + 5 * 86400000, unknownTime: 'exclude' }, { unknownTime: 'only' },
      { fromMs: first + 100, toMs: first + 100, unknownTime: 'exclude' }];
    for (const timezone of [zone, 'America/New_York']) {
      for (const [variant, db] of Object.entries(dbs)) independentAggregateChecks += verifyAggregates(db, apis[variant], rows, timezone);
      for (const mode of ['rollup', 'forced-raw', 'costs']) for (const by of ['provider', 'model']) {
        for (const group of groups) for (const filter of filters) {
          for (const order of [{}, { sortBy: 'averageTokens' }, { tableSort: { key: 'tokens', direction: 'desc' } }]) {
            const selectedFilter = { ...filter, includeCosts: mode === 'costs' };
            const full = Object.fromEntries(Object.entries(dbs).map(([variant, db]) => [variant,
              inMode(db, mode, () => db.queryUsagePage(selectedFilter, group, timezone, { limit: 1000, ...order }, by))]));
            equal(full.A, full.B, `${mode}/${timezone}/${by}/${group}/full`); fullComparisons++;
            noInternalMetadata(full.B); assert.equal(full.B.total, full.B.rows.length);
            const offsets = [...new Set([0, 1, Math.floor(full.B.total / 2), Math.max(0, full.B.total - 2), full.B.total + 5])];
            for (const offset of offsets) {
              const pages = Object.fromEntries(Object.entries(dbs).map(([variant, db]) => [variant,
                inMode(db, mode, () => db.queryUsagePage(selectedFilter, group, timezone, { limit: 3, offset, ...order }, by))]));
              equal(pages.A, pages.B, `${mode}/${timezone}/${by}/${group}/${offset}`);
              equal(pages.B.rows, full.B.rows.slice(offset, offset + 3), 'page equals independently requested full result slice');
              assert.equal(pages.B.total, full.B.total, 'total includes omitted and out-of-range rows');
              noInternalMetadata(pages.B); pageComparisons++;
            }
          }
        }
      }
    }
    for (const mode of ['rollup', 'forced-raw', 'costs']) for (const by of ['provider', 'model']) for (const group of groups) {
      for (const key of sortKeys) for (const direction of ['asc', 'desc']) {
        const pages = Object.fromEntries(Object.entries(dbs).map(([variant, db]) => [variant,
          inMode(db, mode, () => db.queryUsagePage({ includeCosts: mode === 'costs' }, group, zone,
            { limit: 7, offset: 1, tableSort: { key, direction } }, by))]));
        equal(pages.A, pages.B, `${mode}/${by}/${group}/${key}/${direction}`); noInternalMetadata(pages.B); sortComparisons++;
      }
    }
    for (const by of ['provider', 'model']) for (const afterId of [0, 1, 20, 95, 10000]) {
      const pages = Object.fromEntries(Object.entries(dbs).map(([variant, db]) => [variant,
        db.queryUsagePage({}, 'turn', zone, { afterId, limit: 7 }, by)]));
      equal(pages.A, pages.B, 'request cursor rows with full-filter total'); cursorComparisons++;
      assert.equal(pages.B.total, dbs.B.queryTurnsCount({}, by));
    }
    return { requests: rows.length, fixedSeed: 'index-0..95', independentAggregateChecks, fullComparisons,
      pageComparisons, sortComparisons, cursorComparisons, modes: ['rollup', 'forced-raw', 'costs'],
      timezones: [zone, 'America/New_York'], internalMetadataNeverExposed: true };
  });
}

function selected(row, filter) {
  if (filter.provider && filter.provider !== row.provider) return false;
  if (filter.providers && !filter.providers.includes(row.provider)) return false;
  if (filter.projectKey && filter.projectKey !== row.project_key) return false;
  if (filter.sessionId && filter.sessionId !== row.session_id) return false;
  if (filter.unknownTime === 'only') return row.started_at_ms === null;
  if (row.started_at_ms === null) return filter.unknownTime === 'include' ||
    filter.fromMs === undefined && filter.toMs === undefined && filter.unknownTime !== 'exclude';
  return (filter.fromMs === undefined || row.started_at_ms >= filter.fromMs) &&
    (filter.toMs === undefined || row.started_at_ms < filter.toMs);
}

function namesCapabilitiesAndCoverage() {
  return paired(dbs => {
    const rows = Array.from({ length: 96 }, (_, index) => fixture(index));
    for (const db of Object.values(dbs)) db.replaceMemory(replacement(rows));
    let nameComparisons = 0, capabilityComparisons = 0, coverageComparisons = 0;
    for (const kind of ['project', 'session']) for (const scope of [{}, { provider: 'claude' }, { providers: [] },
      { providers: ['codex'], projectKey: '/fixture/project-1' }]) {
      const full = dbs.B.queryNames({ kind, ...scope, limit: 1000 });
      const expectedIdentities = new Set(rows.filter(row => selected(row, {
        ...scope, projectKey: kind === 'session' ? scope.projectKey : undefined,
      })).map(row => kind === 'session' ? canonical([row.provider, row.project_key, row.session_id]) : row.project_key));
      assert.equal(full.total, expectedIdentities.size, 'names cover all stored identities independently of dates');
      for (const offset of [0, 1, Math.max(full.total - 1, 0), full.total + 5]) {
        const query = { kind, ...scope, limit: 3, offset, fromMs: first + 99 * 86400000, toMs: first + 100 * 86400000 };
        const pages = { A: dbs.A.queryNames(query), B: dbs.B.queryNames(query) };
        equal(pages.A, pages.B, 'names A/B'); noInternalMetadata(pages.B);
        equal(pages.B.rows, full.rows.slice(offset, offset + 3), 'name page ordering'); assert.equal(pages.B.total, full.total);
        nameComparisons++;
      }
    }
    for (const filter of [{}, { provider: 'codex' }, { providers: [] }, { projectKey: '/fixture/project-1' },
      { sessionId: 'session-3' }, { fromMs: first, toMs: first + 3 * 86400000 }, { unknownTime: 'only' }]) {
      for (const category of categories) {
        const sums = new Map();
        for (const row of rows.filter(row => selected(row, filter))) for (const usage of row.capability_usage) {
          if (usage.category !== category) continue;
          const key = canonical([row.provider, usage.name]); sums.set(key, (sums.get(key) ?? 0) + usage.usage_count);
        }
        const totalUses = [...sums.values()].reduce((sum, count) => sum + count, 0), maxUses = Math.max(0, ...sums.values());
        const full = dbs.B.queryCapabilities(filter, category, 0, 1000);
        for (const offset of [0, 1, Math.max(0, full.total - 1), full.total + 5]) {
          const a = dbs.A.queryCapabilities(filter, category, offset, 3), b = dbs.B.queryCapabilities(filter, category, offset, 3);
          equal(a, b, 'capability page A/B'); equal(b.rows, full.rows.slice(offset, offset + 3), 'capability ordering');
          equal({ total: b.total, totalUses: b.totalUses, maxUses: b.maxUses }, { total: sums.size, totalUses, maxUses }, 'JS denominator/max');
          for (const row of b.rows) assert.equal(row.percentage, row.usage_count / totalUses * 100);
          noInternalMetadata(b); capabilityComparisons++;
        }
      }
    }
    for (const providers of [undefined, [], ['claude'], ['codex'], ['claude', 'codex']]) {
      equal(dbs.B.diagnosticCounts(providers), dbs.A.diagnostics({ providers, limit: 1 }).counts, 'coverage without lists A/B');
      equal(dbs.B.diagnosticCounts(providers), dbs.B.diagnostics({ providers, limit: 1 }).counts, 'coverage and diagnostics agree');
      coverageComparisons++;
    }
    return { nameComparisons, capabilityComparisons, coverageComparisons, independentIdentityCounts: true,
      independentCapabilityTotalsAndPercentages: true, nameDatesIgnored: true };
  });
}

// JS oracle reads model estimates as data and independently implements session cost reduction, including no models.
function expectedCosts(db, mode, pricingVersion) {
  const models = new Map();
  for (const row of db.connection.prepare('SELECT turn_id,estimated_cost_usd FROM turn_model_usage').all()) {
    if (!models.has(row.turn_id)) models.set(row.turn_id, []); models.get(row.turn_id).push(row.estimated_cost_usd);
  }
  return db.connection.prepare('SELECT id FROM turn_summary ORDER BY id').all().map(({ id }) => {
    const values = models.get(id) ?? [], known = values.filter(value => value !== null);
    return { turn_id: id, billing_mode: mode, pricing_version: pricingVersion,
      cost_usd: mode === 'subscription' ? 0 : mode === 'api' && known.length ? known.reduce((sum, value) => sum + value, 0) : null,
      unknown_costs: mode === 'subscription' ? 0 : mode === 'api' ? Math.max(1, values.length) - known.length : Math.max(1, values.length) };
  });
}

function storageAndBilling() {
  return paired(dbs => {
    const seed = Array.from({ length: 14 }, (_, index) => fixture(index, { provider: 'claude', session_id: 'billing-session',
      model_usage: index % 4 === 0 ? undefined : [{ model: index % 4 === 1 ? 'claude-sonnet-4-6' : 'synthetic-unpriced',
        input_tokens: 12, output_tokens: 3, cache_write_input_tokens: 0, cache_read_input_tokens: 0 },
      { model: index % 4 === 2 ? 'claude-haiku-4-5' : 'synthetic-other', input_tokens: 18, output_tokens: 3,
        cache_write_input_tokens: index % 4 === 3 ? null : 0, cache_read_input_tokens: 0 }],
      input_tokens: 30, output_tokens: 6, total_tokens: 36, cache_write_input_tokens: 0, cache_read_input_tokens: 0 }));
    for (const db of Object.values(dbs)) { db.replaceMemory(replacement(seed)); db.queryUsagePage({}, 'day', zone); }
    let independentCostChecks = 0, rollbackChecks = 0, preservedCapabilityChecks = 0;
    for (const mode of ['api', 'subscription', 'unknown', 'api']) {
      for (const [variant, db] of Object.entries(dbs)) {
        db.setSessionBilling('claude', 'billing-session', mode);
        equal(db.connection.prepare('SELECT * FROM turn_costs ORDER BY turn_id').all(), expectedCosts(db, mode, apis[variant].pricingVersion), 'independent JS session cost reduction');
        independentCostChecks++; assert.equal(db.sessionBilling('claude', 'billing-session'), mode);
      }
      equal(snapshot(dbs.A), snapshot(dbs.B), 'session billing persisted A/B');
    }
    for (const db of Object.values(dbs)) {
      const before = snapshot(db), rejectId = db.connection.prepare('SELECT id FROM turn_summary ORDER BY id LIMIT 1 OFFSET 5').get().id;
      db.connection.exec(`CREATE TEMP TRIGGER reject_cost BEFORE INSERT ON turn_costs WHEN NEW.turn_id=${rejectId}
        BEGIN SELECT RAISE(ABORT,'synthetic billing failure'); END;`);
      assert.throws(() => db.setSessionBilling('claude', 'billing-session', 'subscription'), /synthetic billing failure/);
      assert.equal(snapshot(db), before, 'failed grouped costs roll back both selection and every prior replaced cost'); rollbackChecks++;
      db.connection.exec('DROP TRIGGER reject_cost');
      const oldCapabilities = db.connection.prepare('SELECT * FROM turn_capability_usage ORDER BY turn_id,category,name').all();
      const changed = seed.map((row, index) => ({ ...row, request_title: `changed-${index}`, capability_usage: undefined }));
      const fresh = fixture(100, { provider: 'claude', session_id: 'billing-session' });
      db.replaceMemory(replacement([...changed, fresh], { preserveCapabilities: true }));
      const previousIds = new Set(db.connection.prepare("SELECT id FROM turn_summary WHERE root_turn_id <> ?").all(fresh.root_turn_id).map(row => row.id));
      equal(db.connection.prepare('SELECT * FROM turn_capability_usage ORDER BY turn_id,category,name').all().filter(row => previousIds.has(row.turn_id)),
        oldCapabilities, 'capabilities preserved for existing facts update'); preservedCapabilityChecks++;
      const freshId = db.connection.prepare('SELECT id FROM turn_summary WHERE root_turn_id=?').get(fresh.root_turn_id).id;
      assert.equal(db.connection.prepare('SELECT count(*) n FROM turn_capability_usage WHERE turn_id=?').get(freshId).n, 4, 'new request still saves capabilities');
      db.connection.prepare('DELETE FROM turn_costs WHERE turn_id=?').run(freshId);
      db.connection.prepare("UPDATE turn_costs SET pricing_version='stale-synthetic' WHERE turn_id=?").run(rejectId);
      db.replaceMemory(replacement([...changed, fresh], { preserveCapabilities: true }));
      equal(db.connection.prepare('SELECT * FROM turn_costs ORDER BY turn_id').all(), expectedCosts(db, 'api', apis.B.pricingVersion), 'missing cost and stale version rebuilt');
      const beforeChild = snapshot(db);
      db.connection.exec(`CREATE TEMP TRIGGER reject_model BEFORE INSERT ON turn_model_usage WHEN NEW.model='synthetic-reject'
        BEGIN SELECT RAISE(ABORT,'synthetic child failure'); END;`);
      const failing = { ...changed[0], model_usage: [{ model: 'synthetic-reject', input_tokens: 30, output_tokens: 6,
        cache_write_input_tokens: 0, cache_read_input_tokens: 0 }] };
      assert.throws(() => db.replaceMemory(replacement([failing, ...changed.slice(1), fresh], { preserveCapabilities: true })), /synthetic child failure/);
      assert.equal(snapshot(db), beforeChild, 'failed child replacement restores facts, names, children, costs and rollups'); rollbackChecks++;
      db.connection.exec('DROP TRIGGER reject_model');
    }
    return { requestsBefore: seed.length, requestsAfter: seed.length + 1, independentCostChecks, rollbackChecks,
      preservedCapabilityChecks, modelCounts: [0, 2], knownAndNullEstimates: true, pricingVersionAndMissingCostRepair: true };
  });
}

function retentionAndReconnection() {
  return paired(dbs => {
    const file = (id, session) => ({ id, provider: 'claude', session_id: session, source_root: '/fixture/logs',
      path: `/fixture/logs/${id}.jsonl`, size_bytes: 100, mtime_ms: 1, dev: null, inode: null, parser_version: 17 });
    const base = fixture(1, { provider: 'claude', session_id: 'shared-missing', input_tokens: 30, output_tokens: 3, total_tokens: 33,
      cache_write_input_tokens: 0, cache_read_input_tokens: 0,
      model_usage: [{ model: 'claude-sonnet-4-6', input_tokens: 30, output_tokens: 3, cache_write_input_tokens: 0, cache_read_input_tokens: 0 }] });
    const kept = { ...base, root_turn_id: 'retained', diagnostic_file_id: 101 };
    const empty = { ...base, root_turn_id: 'empty', diagnostic_file_id: 102, input_tokens: 0, output_tokens: 0, total_tokens: 0, model_usage: undefined };
    for (const db of Object.values(dbs)) {
      db.replaceMemory(replacement([kept, empty], { files: [file(101, 'shared-missing'), file(102, 'shared-missing')] }));
      db.queryUsagePage({}, 'day', zone);
      db.replaceMemory(replacement([], { sessions: [{ provider: 'claude', session_id: 'shared-missing' }], removedFileIds: [101, 102], retainDeletedSourceUsage: true }));
      assert.equal(db.queryTurnsCount(), 1); assert.equal(db.findManifest('claude', file(101, '').path).source_missing, 1);
      assert.equal(db.findManifest('claude', file(102, '').path).source_missing, 1);
      db.replaceMemory(replacement([], { sessions: [{ provider: 'claude', session_id: 'shared-missing' }], files: [file(103, 'shared-missing')],
        removedFileIds: [101, 102], reconnectedFiles: [{ old_id: 101, new_id: 103 }], retainDeletedSourceUsage: true }));
      assert.equal(db.queryTurnsCount(), 1); assert.equal(db.queryTurns()[0].diagnostic_file_id, 103);
      assert.equal(db.findManifest('claude', file(101, '').path), undefined);
      assert.equal(db.findManifest('claude', file(102, '').path).source_missing, 1);
      assert.equal(db.findManifest('claude', file(103, '').path).source_missing, 0);
    }
    return { sameSessionMissingFiles: 2, eligibleRequestRetained: true, emptyRequestRemoved: true,
      reconnectSkippedBeforeSessionDeduplication: true, diagnosticReferenceMovedToNewFile: true };
  });
}

function sqlCalls() {
  const report = {};
  for (const [variant, api] of Object.entries(apis)) {
    const db = new api.Database(':memory:'), calls = [], prepare = db.connection.prepare;
    let active = false;
    db.connection.prepare = function(sql) {
      const statement = Reflect.apply(prepare, this, [sql]);
      for (const method of ['get', 'all', 'run']) {
        const invoke = statement[method];
        statement[method] = function(...args) { if (active) calls.push({ method, sql }); return Reflect.apply(invoke, this, args); };
      }
      return statement;
    };
    const measure = action => {
      calls.length = 0; active = true;
      try { action(); } finally { active = false; }
      return { statements: calls.length, ...Object.fromEntries(['get', 'all', 'run'].map(method => [method, calls.filter(call => call.method === method).length])),
        sqlShapes: [...new Set(calls.map(call => call.sql))].map(sql => ({ sha256: hash(sql), executions: calls.filter(call => call.sql === sql).length,
          prefix: sql.trim().replace(/\s+/g, ' ').slice(0, 125) })) };
    };
    try {
      const rows = Array.from({ length: 24 }, (_, index) => fixture(index, { provider: 'claude', session_id: 'sql-session' }));
      db.queryUsagePage({}, 'day', zone); db.replaceMemory(replacement(rows));
      report[variant] = {
        groupedPage: measure(() => db.queryUsagePage({}, 'day', zone, { limit: 3 })),
        emptyFirstPage: measure(() => db.queryUsagePage({ providers: [] }, 'day', zone, { limit: 3 })),
        beyondLastPage: measure(() => db.queryUsagePage({}, 'day', zone, { limit: 3, offset: 1000 })),
        names: measure(() => db.queryNames({ kind: 'session', limit: 3 })),
        fourCapabilities: measure(() => categories.forEach(category => db.queryCapabilities({}, category, 0, 3))),
        coverage: measure(() => variant === 'A' ? db.diagnostics({ limit: 1 }).counts : db.diagnosticCounts()),
        unchangedSave: measure(() => db.replaceMemory(replacement(rows))),
        preservedSave: measure(() => db.replaceMemory(replacement(rows.map(row => ({ ...row, capability_usage: undefined })), { preserveCapabilities: true }))),
        sessionBilling: measure(() => db.setSessionBilling('claude', 'sql-session', 'api')),
      };
    } finally { db.close(); }
  }
  assert.equal(report.A.names.statements - report.B.names.statements, 1);
  assert.equal(report.A.fourCapabilities.statements - report.B.fourCapabilities.statements, 4);
  assert.equal(report.A.coverage.statements, 3); assert.equal(report.B.coverage.statements, 1);
  return report;
}

const report = { dateSeoul: '2026-11-11', scope: 'Explicitly authorized synthetic A/B correctness validation; separate from performance timings',
  runnerSha256: hash(fs.readFileSync(__filename)), helperSha256: hash(fs.readFileSync(join(__dirname, 'transaction-batch-validation.cjs'))),
  products: Object.fromEntries(Object.entries(apis).map(([variant, api]) => [variant,
    Object.fromEntries(['src/summary/db/reader.ts', 'src/summary/db/memoryStore.ts', 'src/summary/db/billing.ts',
      'dist/src/summary/db/reader.js', 'dist/src/summary/db/memoryStore.js', 'dist/src/summary/db/billing.js']
      .map(file => [file, hash(fs.readFileSync(join(api.directory, file)))]))])),
  pages: pagesAndQueries(), namesCapabilitiesAndCoverage: namesCapabilitiesAndCoverage(),
  storageAndBilling: storageAndBilling(), retentionAndReconnection: retentionAndReconnection(), sqlCalls: sqlCalls(),
  limitations: ['Synthetic DTOs, not an independent JSONL parser oracle', 'No UI, quota, forced process termination, power loss or competing writer validation',
    'JS cost oracle independently reduces persisted model estimates; model pricing itself is not independently reimplemented',
    'Floating values are compared at 12 significant digits; recorded_at is excluded from cross-run persisted snapshots'] };
fs.mkdirSync(dirname(options.output), { recursive: true });
fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(`Database A/B validation passed: ${report.pages.pageComparisons} page comparisons, ${report.pages.independentAggregateChecks} independent aggregates.`);
