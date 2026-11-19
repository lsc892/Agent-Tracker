// 보존 DB의 별도 사본에서 일별 집계 계획·날짜 함수 호출 수를 A/B 대조한다. 시간 표본과 분리한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { dirname, join, resolve } = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

const options = {};
for (const argument of process.argv.slice(2)) {
  const match = /^--(before|after|db|workspace|output)=(.+)$/.exec(argument);
  assert.ok(match, 'Expected --before/after/db/workspace/output'); options[match[1]] = resolve(match[2]);
}
for (const name of ['before', 'after', 'db', 'workspace', 'output']) assert.ok(options[name]);
assert.ok(!fs.existsSync(options.output), 'Never overwrite reports');
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) =>
  typeof item === 'number' && !Number.isInteger(item) ? Number(item.toPrecision(12)) : item);

async function main() {
  fs.mkdirSync(options.workspace, { recursive: true });
  const variants = {};
  for (const [variant, product] of [['A', options.before], ['B', options.after]]) {
    const targetPath = join(options.workspace, `${variant}.sqlite`);
    assert.ok(!fs.existsSync(targetPath), 'Use a fresh diagnostic workspace');
    const source = new DatabaseSync(options.db, { readOnly: true });
    try { await backup(source, targetPath); } finally { source.close(); }
    const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
    const { aggregateUsageSource } = require(join(product, 'dist/src/summary/db/rollup-queries'));
    const { calendarPeriod } = require(join(product, 'dist/src/summary/db/timezone'));
    const db = new SummaryDatabase(targetPath);
    try {
      let calls = 0;
      db.connection.function('agent_tracker_period', { deterministic: true }, (timestamp, timezone, unit) => {
        calls++;
        return timestamp === null ? null : calendarPeriod(Number(timestamp), String(timezone), unit === 'month' ? 'month' : 'day');
      });
      const session = db.connection.prepare(`SELECT provider,session_id FROM turn_summary
        GROUP BY provider,session_id ORDER BY COUNT(*) DESC LIMIT 1`).get();
      const probes = [];
      for (const [scope, where, values] of [['all', '1 = 1', []],
        ['largest-session', 'provider = ? AND session_id = ?', [session.provider, session.session_id]]]) {
        for (const by of ['provider', 'model']) {
          const sql = aggregateUsageSource(by, where), args = ['Asia/Seoul', ...values];
          const plan = db.connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail);
          calls = 0;
          const rows = db.connection.prepare(sql).all(...args);
          probes.push({ scope, by, sql, plan, periodFunctionCalls: calls, resultRows: rows.length,
            rowsSha256: hash(canonical(rows)), correlatedSubqueryNodes: plan.filter(detail => /CORRELATED/.test(detail)).length });
        }
      }
      variants[variant] = { requests: db.connection.prepare('SELECT COUNT(*) n FROM turn_summary').get().n, probes };
    } finally { db.close(); }
  }
  assert.deepEqual(variants.A.probes.map(probe => [probe.scope, probe.by, probe.rowsSha256]),
    variants.B.probes.map(probe => [probe.scope, probe.by, probe.rowsSha256]), 'Exact aggregate outputs');
  const report = { dateSeoul: '2026-11-10', runnerSha256: hash(fs.readFileSync(__filename)),
    scope: 'Separate backup copies; real SQLite query plans and period UDF calls; no timing conclusions or personal keys', variants };
  fs.mkdirSync(dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log('A/B SQL plans and function counts recorded; aggregate hashes match.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
