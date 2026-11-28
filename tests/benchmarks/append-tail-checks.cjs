'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const readLimit = 1000;
const groups = ['day', 'month', 'session', 'project'];
const categories = ['skill', 'subagent', 'plugin', 'model'];
const storageTables = ['usage_request_daily', 'usage_model_daily', 'usage_capability_daily', 'usage_rollup_meta', 'projects', 'sessions', 'source_file'];
const sourceColumns = new Set([
  'provider', 'source_root', 'path', 'session_id', 'mtime_ms', 'parser_version', 'capabilities_collected',
  'thread_id', 'thread_usage', 'source_missing', 'processing_status', 'processing_position', 'last_error',
]);

function encode(value) {
  return JSON.stringify(value, (_, item) => {
    if (typeof item === 'bigint') return { integer: item.toString() };
    if (item instanceof Uint8Array) return { blob: Buffer.from(item).toString('hex') };
    return item;
  });
}

function fingerprint(rows, columnNames = []) {
  const hash = createHash('sha256');
  hash.update(encode(columnNames) + '\n');
  let count = 0;
  for (const row of rows) {
    hash.update(encode(row) + '\n');
    count++;
  }
  return { count, sha256: hash.digest('hex') };
}

function quote(name) {
  return '"' + name.replaceAll('"', '""') + '"';
}

function storageFingerprint(connection, table) {
  const columns = connection.prepare('PRAGMA table_info(' + quote(table) + ')').all()
    .filter(column => table !== 'source_file' || sourceColumns.has(column.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.ok(columns.length, 'missing persisted table ' + table);
  const keys = table === 'source_file' ? ['provider', 'path']
    : columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name);
  assert.ok(keys.length, 'missing persisted key in ' + table);
  const selection = columns.map(column => column.type === 'TEXT'
    ? 'CAST(' + quote(column.name) + ' AS BLOB)'
    : quote(column.name));
  const statement = connection.prepare('SELECT ' + selection.join(',') + ' FROM ' + quote(table)
    + ' ORDER BY ' + keys.map(key => 'CAST(' + quote(key) + ' AS BLOB)').join(','));
  statement.setReadBigInts(true);
  statement.setReturnArrays(true);
  return fingerprint(statement.iterate(), columns.map(column => column.name));
}

function allPages(getPage) {
  const rows = [];
  let total;
  do {
    const page = getPage(rows.length, readLimit);
    total ??= page.total;
    assert.equal(page.total, total);
    assert.ok(page.rows.length || rows.length === total, 'pagination stopped before total');
    rows.push(...page.rows);
    assert.ok(rows.length <= total, 'pagination exceeded total');
  } while (rows.length < total);
  return rows;
}

function usageKey(row, group, basis, stored) {
  const calendar = group === 'day' || group === 'month';
  const period = stored && calendar ? row.local_day.slice(0, group === 'day' ? 10 : 7) || null : row.period;
  return JSON.stringify([row.provider,
    basis === 'model' ? row.model : null,
    group === 'session' || group === 'project' ? row.project_key : null,
    group === 'session' ? row.session_id : null,
    calendar ? period : null]);
}

const integerStates = [
  'input_tokens', 'output_tokens', 'total_tokens', 'turn_count', 'completed_turns',
  'recorded_turns', 'recorded_completed_turns',
];
const states = [...integerStates, 'c_input_tokens', 'c_output_tokens', 'c_total_tokens'];

function assertIndependentUsage(dailyRows, actual, group, basis) {
  const expected = new Map();
  for (const row of dailyRows) {
    const key = usageKey(row, group, basis, true);
    let sums = expected.get(key);
    if (!sums) {
      sums = Object.fromEntries(states.map(field => [field, 0]));
      expected.set(key, sums);
    }
    for (const field of states) sums[field] += row[field];
  }
  assert.equal(actual.length, expected.size, group + '/' + basis + ' group count');
  for (const row of actual) {
    const key = usageKey(row, group, basis, false);
    const sums = expected.get(key);
    assert.ok(sums, group + '/' + basis + ' missing expected group');
    for (const field of integerStates) {
      assert.equal(row[field], sums[field], group + '/' + basis + '/' + field);
    }
    for (const [actualField, storedField] of [
      ['avg_tokens_per_turn', 'c_total_tokens'], ['avg_input_tokens', 'c_input_tokens'], ['avg_output_tokens', 'c_output_tokens'],
    ]) {
      assert.equal(row[actualField], sums.completed_turns ? sums[storedField] / sums.completed_turns : null,
        group + '/' + basis + '/' + actualField);
    }
    expected.delete(key);
  }
  assert.equal(expected.size, 0, group + '/' + basis + ' unmatched expected groups');
}

function providerTotals(connection) {
  const statement = connection.prepare('SELECT provider,SUM(turn_count) AS requests,SUM(input_tokens) AS input,'
    + 'SUM(output_tokens) AS output,SUM(total_tokens) AS tokens FROM usage_request_daily GROUP BY provider ORDER BY provider');
  return Object.fromEntries(statement.all().map(({ provider, ...row }) => [provider, row]));
}

function capture(database, { timezone = 'Asia/Seoul', includeSecondary = true } = {}) {
  const { connection } = database;
  const integrity = connection.prepare('PRAGMA integrity_check').all();
  assert.deepEqual(integrity.map(row => row.integrity_check), ['ok'], 'SQLite integrity_check');
  assert.equal(connection.prepare('PRAGMA foreign_key_check').all().length, 0, 'SQLite foreign_key_check');

  const tables = Object.fromEntries(storageTables.map(table => [table, storageFingerprint(connection, table)]));
  const queries = {};
  const filter = { unknownTime: 'include', excludeEmptyUsage: false, includeCosts: true };
  for (const [basis, table] of [['provider', 'usage_request_daily'], ['model', 'usage_model_daily']]) {
    const dailyRows = connection.prepare('SELECT * FROM ' + table).all();
    for (const group of groups) {
      const started = performance.now();
      const rows = allPages((offset, limit) => database.queryUsagePage(filter, group, timezone, { offset, limit }, basis));
      const ms = performance.now() - started;
      assertIndependentUsage(dailyRows, rows, group, basis);
      queries[basis + '/' + group] = { ms, ...fingerprint(rows) };
    }
  }

  const diagnostics = database.diagnosticCounts();
  const secondary = {};
  if (includeSecondary) {
    for (const kind of ['project', 'session']) {
      secondary['names/' + kind] = fingerprint(allPages((offset, limit) => database.queryNames({ offset, limit, kind })));
    }
    const batched = database.queryCapabilityPages({ limit: readLimit });
    for (const category of categories) {
      const firstPage = database.queryCapabilities(filter, category, 0, readLimit);
      assert.deepEqual({ ...batched[category] }, { ...firstPage }, 'batch/individual capabilities: ' + category);
      secondary['capabilities/' + category] = fingerprint(
        allPages((offset, limit) => database.queryCapabilities(filter, category, offset, limit)),
      );
    }
  }
  return { tables, totals: providerTotals(connection), queries, diagnostics, secondary, integrity: 'ok', foreignKeys: 0 };
}

function compare(left, right) {
  for (const field of ['totals', 'diagnostics', 'integrity', 'foreignKeys', 'secondary']) {
    assert.deepEqual(left[field], right[field], field + ' mismatch');
  }
  assert.deepEqual(Object.keys(left.tables), Object.keys(right.tables));
  for (const table of Object.keys(left.tables)) {
    assert.deepEqual(left.tables[table], right.tables[table], table + ' mismatch');
  }
  assert.deepEqual(Object.keys(left.queries), Object.keys(right.queries));
  for (const query of Object.keys(left.queries)) {
    const { ms: leftMs, ...leftResult } = left.queries[query];
    const { ms: rightMs, ...rightResult } = right.queries[query];
    assert.deepEqual(leftResult, rightResult, query + ' query mismatch');
  }
}

function appendExpectation(raw) {
  const rows = Array.isArray(raw) ? raw : raw.toString().trim().split(/\r?\n/).map(line => JSON.parse(line));
  const started = rows.filter(row => row.type === 'event_msg' && row.payload?.type === 'task_started');
  const finished = rows.filter(row => row.type === 'event_msg' && row.payload?.type === 'task_complete');
  const measurements = rows.flatMap(row => {
    if (row.type === 'token_usage_record') return [row.payload.usage];
    if (row.type === 'event_msg' && row.payload?.type === 'token_count') return [row.payload.info?.last_token_usage];
    return [];
  });
  assert.equal(started.length, 1, 'fixture appended request count');
  assert.equal(finished.length, 1, 'fixture completed request count');
  assert.equal(finished[0].payload.turn_id, started[0].payload.turn_id, 'fixture completed request identity');
  assert.equal(measurements.length, 1, 'fixture independent raw usage row count');
  const { input_tokens: input, output_tokens: output } = measurements[0];
  assert.ok(Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0);
  return { requests: 1, input, output, tokens: input + output };
}

function assertDelta(before, after, expected, provider = 'codex') {
  const zero = { requests: 0, input: 0, output: 0, tokens: 0 };
  const oldRow = before.totals[provider] ?? zero;
  const newRow = after.totals[provider] ?? zero;
  const delta = Object.fromEntries(Object.keys(zero).map(field => [field, newRow[field] - oldRow[field]]));
  assert.deepEqual(delta, expected, provider + ' request and token delta');
  for (const key of new Set([...Object.keys(before.totals), ...Object.keys(after.totals)])) {
    if (key !== provider) assert.deepEqual(after.totals[key], before.totals[key], key + ' totals unexpectedly changed');
  }
  return delta;
}

module.exports = { capture, compare, appendExpectation, assertDelta };

