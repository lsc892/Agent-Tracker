// Collects refresh stage, worker memory, and SQLite sizes for the dashboard benchmark.
'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { statSync } = require('node:fs');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { parentPort, workerData } = require('node:worker_threads');

function fileBytes(path) {
  return statSync(path, { throwIfNoEntry: false })?.size ?? 0;
}

function diskSizes(path) {
  return { db: fileBytes(path), wal: fileBytes(path + '-wal'), shm: fileBytes(path + '-shm') };
}

function pageBytes(db) {
  const { connection } = db;
  return connection.prepare('PRAGMA page_count').get().page_count * connection.prepare('PRAGMA page_size').get().page_size;
}

function measureAverages(product, databasePath, timezone, { fromDay, toDay, fromMs, toMs }) {
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const db = new SummaryDatabase({ databasePath, timezone });
  try {
    const daily = db.connection.prepare('SELECT * FROM usage_request_daily WHERE local_day BETWEEN ? AND ?').all(fromDay, toDay);
    const totals = db.connection.prepare('SELECT sum(total_tokens) AS tokens, sum(turn_count) AS threads FROM usage_request_daily').get();
    const groups = {}, timingsMs = {};
    for (const group of ['day', 'month', 'session', 'project']) {
      const key = row => JSON.stringify([row.provider, row.project_key, row.session_id, row.period]);
      const expected = new Map();
      for (const row of daily) {
        const id = key({ provider: row.provider, project_key: ['project', 'session'].includes(group) ? row.project_key : null,
          session_id: group === 'session' ? row.session_id : null,
          period: group === 'day' ? row.local_day : group === 'month' ? row.local_day.slice(0, 7) : null });
        const totals = expected.get(id) ?? { tokens: 0, count: 0, completed: 0, completedTokens: 0 };
        totals.tokens += row.total_tokens;
        totals.count += row.turn_count;
        totals.completed += row.completed_turns;
        totals.completedTokens += row.c_total_tokens;
        expected.set(id, totals);
      }
      const rows = [];
      const filter = { fromMs, toMs, unknownTime: 'exclude', chartMetric: 'averageTokens', excludeEmptyUsage: false };
      const start = performance.now();
      for (let offset = 0; ; offset += 1000) {
        const page = db.queryUsagePage(filter, group, timezone, { limit: 1000, offset });
        rows.push(...page.rows);
        if (rows.length >= page.total || !page.rows.length) break;
      }
      timingsMs[group] = performance.now() - start;
      assert.equal(rows.length, expected.size, group);
      const digest = createHash('sha256');
      for (const row of rows) {
        const id = key(row), value = expected.get(id);
        assert.ok(value, group);
        assert.equal(row.total_tokens, value.tokens, group);
        assert.equal(row.turn_count, value.count, group);
        assert.equal(row.avg_tokens_per_turn, value.completed ? value.completedTokens / value.completed : null, group);
        digest.update(JSON.stringify([id, value]));
        expected.delete(id);
      }
      groups[group] = { rows: rows.length, digest: digest.digest('hex') };
    }
    return { ...totals, timingsMs, groups };
  } finally { db.close(); }
}

function startWorker() {
  const product = join(workerData.benchmarkProduct, 'dist/src/summary');
  const scanner = require(join(product, 'scanner/refresh'));
  const recent = require(join(product, 'db/recentSnapshot'));
  const { SummaryDatabase } = require(join(product, 'db'));
  const { StageProfiler } = require(join(product, 'profiling'));
  const originalRefresh = scanner.refreshSummary;
  const originalCopy = recent.copyRecentUsage;
  const originalPage = SummaryDatabase.prototype.queryUsagePage;
  const originalRecord = StageProfiler.prototype.record;
  let trace;
  let memoryDb;

  function sample(stage) {
    const { heapUsed, rss } = process.memoryUsage();
    trace.peak.heapUsed = Math.max(heapUsed, trace.peak.heapUsed);
    trace.peak.rss = Math.max(rss, trace.peak.rss);
    const mark = { ms: performance.now() - trace.started, epochMs: performance.timeOrigin + performance.now(), heapUsed, rss };
    if (stage) trace.marks[stage] = mark;
    return mark;
  }

  StageProfiler.prototype.record = function (stage, started) {
    originalRecord.call(this, stage, started);
    if (!trace) return;
    if (['names', 'parseChanged', 'expandRelated', 'aggregate', 'commitComponents', 'sourcePoolClose'].includes(stage)) {
      sample(`${trace.lane}.${stage}`);
      if (stage === 'commitComponents' && trace.lane === 'disk') trace.diskAfterWrite = diskSizes(workerData.dbPath);
    }
    if (['replace', 'commit'].includes(stage)) {
      // The scanner shares its profiler across preview and disk. Disk counters include preview totals.
      trace.storage[trace.lane][stage] = { ...this.timings[stage] };
      sample();
    }
  };

  recent.copyRecentUsage = (from, to, ...args) => {
    memoryDb = to;
    trace.lane = 'preview';
    sample('preview.copyStart');
    originalCopy(from, to, ...args);
    sample('preview.copyEnd');
  };

  SummaryDatabase.prototype.queryUsagePage = function (...args) {
    if (!trace) return originalPage.apply(this, args);
    const lane = this === memoryDb ? 'preview' : 'disk';
    sample(`${lane}.readStart`);
    const result = originalPage.apply(this, args);
    sample(`${lane}.readEnd`);
    if (lane === 'preview') trace.previewBytes = pageBytes(this);
    if (lane === 'disk') {
      trace.diskAfterRead = diskSizes(workerData.dbPath);
      parentPort.postMessage({ dashboardBenchmark: trace });
      trace = undefined;
      memoryDb = undefined;
    }
    return result;
  };

  scanner.refreshSummary = async (db, options, signal, progress, preview) => {
    trace = { started: performance.now(), lane: 'disk', marks: {}, peak: { heapUsed: 0, rss: 0 }, storage: { preview: {}, disk: {} } };
    sample('start');
    trace.diskBefore = diskSizes(workerData.dbPath);
    const timer = setInterval(sample, 5);
    const report = progress && (value => {
      if (trace.lane === 'preview' && trace.marks['preview.readEnd']) {
        sample('preview.publish');
        trace.lane = 'disk';
        memoryDb = undefined;
      }
      progress(value);
    });
    try {
      const result = await originalRefresh(db, options, signal, report, preview);
      sample('disk.refreshEnd');
      trace.timings = result.timings;
      return result;
    } finally { clearInterval(timer); }
  };

  require(join(product, 'client/worker'));
}

if (parentPort && workerData?.benchmarkProduct) startWorker();
module.exports = { diskSizes, measureAverages };
