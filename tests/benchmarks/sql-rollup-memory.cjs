// 분리된 자식 프로세스에서 원본·롤업 쿼리의 RSS와 결과 일치를 비교한다.
// Fresh-process query memory observations, separate from full-result correctness runs.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFile, writeFile, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { backup } = require('node:sqlite');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const { buildUsageQuery, buildUsageCountQuery } = require('../../dist/src/summary/db/queries');
const { seed } = require('./sql-rollup.cjs');
const rollup = require('./sql-rollup-prototype.cjs');

const root = resolve(__dirname, '../..');
const variants = ['current', 'session-day-rollup'];
const workloads = [
  { name: 'total-provider', groupBy: 'total', by: 'provider' },
  { name: 'total-model', groupBy: 'total', by: 'model' },
  { name: 'month-provider', groupBy: 'month', by: 'provider' },
];
const sha = value => createHash('sha256').update(value).digest('hex');

function worker(path, variant, name) {
  const spec = workloads.find(value => value.name === name);
  assert.ok(spec && variants.includes(variant));
  const rssOnEntryBytes = process.memoryUsage().rss;
  const db = new SummaryDatabase(path);
  try {
    const filter = { providers: ['claude', 'codex'], excludeEmptyUsage: true };
    const sql = variant === 'current'
      ? { rows: buildUsageQuery(filter, spec.groupBy, rollup.TIMEZONE, spec.by),
        count: buildUsageCountQuery(filter, spec.groupBy, rollup.TIMEZONE, spec.by) }
      : rollup.build(filter, spec.groupBy, rollup.TIMEZONE, spec.by);
    const rows = db.connection.prepare(sql.rows.sql), count = db.connection.prepare(sql.count.sql);
    global.gc?.();
    const beforeRssBytes = process.memoryUsage().rss;
    const beforeLifetimePeakBytes = process.resourceUsage().maxRSS * 1024;
    let result;
    // One warmup and three repetitions, bounded to the real product page size.
    for (let i = 0; i < 4; i++) result = {
      rows: rows.all(...sql.rows.values, 100, 0), total: count.get(...sql.count.values).count,
    };
    const afterRssBytes = process.memoryUsage().rss;
    const lifetimePeakBytes = process.resourceUsage().maxRSS * 1024;
    const resultSha256 = sha(JSON.stringify(result, (_key, value) =>
      typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(12)) : value));
    return { rssOnEntryBytes, beforeRssBytes, afterRssBytes, beforeLifetimePeakBytes, lifetimePeakBytes,
      observedPeakGrowthBytes: Math.max(0, lifetimePeakBytes - beforeLifetimePeakBytes), resultSha256,
      returnedGroups: result.rows.length, totalGroups: result.total };
  } finally { db.close(); }
}

function runWorker(path, variant, name) {
  return new Promise((resolveWorker, reject) => {
    const child = fork(__filename, ['--worker', path, variant, name], {
      execArgv: ['--expose-gc'], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let message, errorText = '';
    child.on('message', value => { message = value; });
    child.stderr.on('data', value => { errorText += value; });
    child.stdout.resume();
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0 || !message) reject(new Error(`Memory worker ${variant}/${name} failed: ${errorText}`));
      else resolveWorker(message);
    });
  });
}

async function main() {
  const output = resolve(process.argv[2] || join(root, 'docs/benchmarks/SqlRollupABBenchmark-2026-10-15.json'));
  const report = JSON.parse(await readFile(output, 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-rollup-memory-'));
  const result = {
    method: 'A fresh child per variant/workload/size. Prepared product rows LIMIT 100 + COUNT, one warmup + three repetitions. Single process observation per case; not a repeated-process confidence interval.',
    scope: 'Fixture construction, rollup backfill, EXPLAIN and full-group validation run in the parent and are excluded from child memory. Child peak includes Node startup, SQLite opening/preparation, page caches, sorting and bounded result materialization. Peak is process lifetime high-water mark, not allocated bytes or exact query scratch.',
    options: { sizes: [280, 100000], turnsPerSession: 100, cacheKiB: 4096, tempStore: 'FILE', pageLimit: 100,
      gc: 'explicit GC once after statement preparation, outside observed query phase, identical for A/B',
      concurrency: 'all workers sequential; warm OS cache; each child owns one variant connection' },
    sourceSha256: {}, datasets: [],
  };
  try {
    for (const path of ['tests/benchmarks/sql-rollup-memory.cjs', 'tests/benchmarks/sql-rollup.cjs',
      'tests/benchmarks/sql-rollup-prototype.cjs', 'src/summary/db/queries.ts']) {
      result.sourceSha256[path] = sha(await readFile(join(root, path)));
    }
    for (const size of result.options.sizes) {
      const paths = variants.map(variant => join(directory, `${size}-${variant}.sqlite`));
      const base = new SummaryDatabase(paths[0]);
      try {
        seed(base, size, result.options.turnsPerSession);
        await backup(base.connection, paths[1]);
        base.connection.exec('ANALYZE; PRAGMA wal_checkpoint(TRUNCATE)');
      } finally { base.close(); }
      const candidate = new SummaryDatabase(paths[1]);
      try {
        rollup.install(candidate);
        candidate.transaction(() => rollup.refresh(candidate));
        candidate.connection.exec('ANALYZE; PRAGMA wal_checkpoint(TRUNCATE)');
      } finally { candidate.close(); }
      const data = { requestFacts: size, turnsPerSession: 100, workloads: [] };
      for (let index = 0; index < workloads.length; index++) {
        const spec = workloads[index], values = {};
        for (const variant of index % 2 ? [...variants].reverse() : variants) {
          values[variant] = await runWorker(paths[variants.indexOf(variant)], variant, spec.name);
        }
        assert.equal(values.current.resultSha256, values['session-day-rollup'].resultSha256,
          `Memory worker output changed: ${size}/${spec.name}`);
        data.workloads.push({ name: spec.name, variants: values });
        console.log(`Memory ${size}/${spec.name}: ${values.current.lifetimePeakBytes} / ${values['session-day-rollup'].lifetimePeakBytes} peak bytes`);
      }
      result.datasets.push(data);
    }
    report.isolatedMemory = result;
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('agent-tracker-rollup-memory-'));
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') {
  try { process.send(worker(...process.argv.slice(3))); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
} else main().catch(error => { console.error(error.stack); process.exitCode = 1; });
