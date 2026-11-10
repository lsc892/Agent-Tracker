// 본 A/B 타이밍이 끝난 DB 사본에서 실제 rollup SQL의 집합 선택 계획만 별도로 기록한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { dirname, join, resolve } = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

const root = resolve(__dirname, '../..');
const sha = value => createHash('sha256').update(value).digest('hex');

async function inspect(product, input, directory, variant) {
  const copy = join(directory, `${variant}.sqlite`);
  const source = new DatabaseSync(input, { readOnly: true });
  try { await backup(source, copy); } finally { source.close(); }
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const db = new SummaryDatabase(copy), sqlite = db.sqlite;
  const original = sqlite.statement;
  let captured;
  sqlite.statement = function(sql) {
    const statement = Reflect.apply(original, this, [sql]);
    if (!/^\s*(DELETE FROM|INSERT INTO) usage_(request|model)_daily\b/.test(sql)) return statement;
    return { run(...values) {
      captured.push({ sql, values });
      return statement.run(...values);
    } };
  };
  try {
    const sessions = db.connection.prepare(`SELECT provider,session_id FROM turn_summary
      GROUP BY provider,session_id ORDER BY provider,session_id LIMIT 16`).all().map(row => ({ ...row }));
    const metadata = db.connection.prepare('SELECT timezone,format_version FROM usage_rollup_meta').get();
    assert.ok(metadata, 'The measured database must have active rollups');
    const inventory = db.connection.prepare(`SELECT count(*) requests,count(DISTINCT provider||':'||session_id) sessions,
      count(DISTINCT project_key) projects FROM turn_summary`).get();
    const cases = [];
    for (const size of [1, 2, 16]) {
      const selected = sessions.slice(0, size);
      assert.equal(selected.length, size);
      captured = [];
      db.connection.exec('BEGIN IMMEDIATE');
      try {
        if (typeof sqlite.rollups.refreshSessions === 'function') sqlite.rollups.refreshSessions(selected);
        else for (const session of selected) sqlite.rollups.refreshSession(session.provider, session.session_id);
        const statements = new Map();
        for (const operation of captured) {
          let entry = statements.get(operation.sql);
          if (!entry) {
            entry = { kind: operation.sql.trim().startsWith('DELETE') ? 'delete' : 'insert',
              sql: operation.sql, calls: 0, firstBindPayloadSha256: sha(JSON.stringify(operation.values)),
              plan: db.connection.prepare(`EXPLAIN QUERY PLAN ${operation.sql}`).all(...operation.values)
                .map(row => ({ ...row })) };
            statements.set(operation.sql, entry);
          }
          entry.calls++;
        }
        cases.push({ selectedSessions: selected.length,
          selectedTuplePayloadSha256: sha(JSON.stringify(selected.map(row => [row.provider, row.session_id]))),
          totalWriteStatements: captured.length, statements: [...statements.values()] });
      } finally { db.connection.exec('ROLLBACK'); }
    }
    return { inventory: { ...inventory }, rollupMetadata: { ...metadata }, cases };
  } finally { sqlite.statement = original; db.close(); }
}

async function main() {
  const options = { before: '', after: '', report: '', output: '' };
  for (const argument of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.+)$/.exec(argument);
    assert.ok(match && Object.hasOwn(options, match[1]), 'Unknown or incomplete option');
    options[match[1]] = resolve(match[2]);
  }
  assert.ok(Object.values(options).every(Boolean));
  assert.equal(fs.existsSync(options.output), false, 'Never overwrite diagnostics');
  const report = JSON.parse(fs.readFileSync(options.report, 'utf8'));
  assert.equal(report.experiment, 'rollup-batch');
  const workspace = dirname(options.report);
  const directory = await fsp.mkdtemp(join(workspace, 'plan-copies-'));
  try {
    const result = { dateSeoul: '2026-11-10', node: process.version, sqlite: process.versions.sqlite,
      runnerSha256: sha(fs.readFileSync(__filename)), abReportSha256: sha(fs.readFileSync(options.report)),
      products: report.products,
      scope: 'Separate post-timing diagnostic; copies of completed trial-0 post-append databases, actual product refresh methods inside transactions that are always rolled back. No elapsed times are interpreted as benchmark samples. SQL and plan details contain placeholders only; selected private keys and bound values are omitted.', datasets: [] };
    for (const dataset of report.datasets) {
      const variants = {};
      for (const variant of ['A', 'B']) variants[variant] = await inspect(
        options[variant === 'A' ? 'before' : 'after'],
        resolve(root, report.trialWorkspace, dataset.name, 'pair-0', variant, 'summary.sqlite'), directory, variant);
      assert.deepEqual(variants.A.inventory, variants.B.inventory);
      result.datasets.push({ name: dataset.name, variants });
    }
    await fsp.mkdir(dirname(options.output), { recursive: true });
    await fsp.writeFile(options.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(`Saved ${options.output}`);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(workspace));
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
