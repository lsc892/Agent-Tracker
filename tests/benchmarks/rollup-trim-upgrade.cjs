// 완료된 1회 A/B의 구버전 DB 사본에서 스키마 전환과 첫 집계 재구축 비용을 분리한다.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const { normalized } = require('./incremental-refresh.cjs');

const [reportPath, afterPath, outputPath] = process.argv.slice(2).map(path => resolve(path));
assert.ok(reportPath && afterPath && outputPath, 'Expected A/B JSON, B product root and new output JSON');
assert.equal(fs.existsSync(outputPath), false, 'Never overwrite measurements');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const { SummaryDatabase } = require(join(afterPath, 'dist/src/summary/db'));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function facts(connection) {
  const names = connection.prepare(`SELECT name FROM sqlite_schema WHERE type='table'
    AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'usage_%' ORDER BY name`).all();
  return names.map(({ name }) => [name, hash(connection.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
    .map(row => JSON.stringify(row)).sort())]);
}
function usage(row) {
  const result = normalized(row);
  for (const field of report.omittedUsageFields) delete result[field];
  return result;
}
const results = [];
for (const dataset of report.datasets) {
  const directory = resolve(report.trialWorkspace, dataset.name, 'pair-0');
  const source = join(directory, 'A/summary.sqlite'), target = join(directory, 'upgrade/summary.sqlite');
  fs.mkdirSync(dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  if (fs.existsSync(source + '-wal')) fs.copyFileSync(source + '-wal', target + '-wal', fs.constants.COPYFILE_EXCL);
  const before = new DatabaseSync(target, { readOnly: true });
  const sourceFacts = facts(before), oldVersion = before.prepare('PRAGMA user_version').get().user_version;
  before.close();
  const started = performance.now(), db = new SummaryDatabase(target), openAndMigrationMs = performance.now() - started;
  try {
    assert.deepEqual(facts(db.connection), sourceFacts);
    assert.equal(db.connection.prepare('SELECT count(*) n FROM usage_rollup_meta').get().n, 0);
    const queryStarted = performance.now();
    db.queryUsagePage(report.filter, 'day', report.timezone, { limit: 1000 });
    const firstAggregateWithRebuildMs = performance.now() - queryStarted;
    for (const by of ['provider', 'model']) for (const group of ['day', 'month', 'session', 'project']) {
      const rows = []; let total;
      for (let offset = 0; ; offset += 1000) {
        const page = db.queryUsagePage(report.filter, group, report.timezone, { limit: 1000, offset }, by);
        total ??= page.total; rows.push(...page.rows);
        if (rows.length >= total) break;
      }
      const expected = dataset.trials[0].A.samples.find(sample => sample.scenario === 'unchanged').queries[`${group}/${by}`];
      assert.equal(rows.length, expected.groups);
      assert.equal(hash(rows.map(usage)), expected.rowsSha256);
    }
    assert.deepEqual(facts(db.connection), sourceFacts);
    assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    results.push({ dataset: dataset.name, sourceRequests: dataset.distribution.requests + 1, oldVersion,
      newVersion: db.connection.prepare('PRAGMA user_version').get().user_version, openAndMigrationMs,
      firstAggregateWithRebuildMs, factsUnchanged: true, retainedQueriesEqual: true, integrity: true });
  } finally { db.close(); }
}
fs.mkdirSync(dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify({ dateSeoul: report.dateSeoul, repetitions: 1,
  conditions: 'Closed trial DB copies; open includes connection setup/migration/optimize. First day query includes both daily table rebuilds and result return. Copy, fact hashes, all other query comparisons and integrity checks excluded.', results }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(results));
