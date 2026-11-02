// 날짜 선두 WITHOUT ROWID PK와 OR 계획의 결과 누락을 제품 코드 없이 재현한다.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { mkdir, writeFile } = require('node:fs/promises');
const { dirname, resolve } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const tableSql = `CREATE TABLE t (
  provider TEXT NOT NULL, project_key TEXT NOT NULL, session_id TEXT NOT NULL,
  local_day TEXT NOT NULL, turn_count INTEGER NOT NULL,
  PRIMARY KEY(local_day,provider,session_id,project_key)
) WITHOUT ROWID;
CREATE INDEX project_day ON t(provider,project_key,local_day);
CREATE INDEX session_idx ON t(provider,session_id);`;
const conditions = "provider IN (?,?) AND ((local_day<>'' AND local_day>=? AND local_day<?) OR local_day='')";
const values = ['claude', 'codex', '2026-09-22', '2026-09-28'];
const orSql = `SELECT provider,local_day,SUM(turn_count) AS turns FROM t WHERE ${conditions} GROUP BY provider,local_day ORDER BY provider,local_day`;
const unionSql = `SELECT provider,local_day,SUM(turn_count) AS turns FROM (
  SELECT * FROM t WHERE provider IN (?,?) AND local_day<>'' AND local_day>=? AND local_day<?
  UNION ALL SELECT * FROM t WHERE provider IN (?,?) AND local_day=''
) GROUP BY provider,local_day ORDER BY provider,local_day`;
const canonical = rows => JSON.stringify(rows.map(({ provider, local_day, turns }) => ({ provider, local_day, turns })));
const digest = rows => createHash('sha256').update(canonical(rows)).digest('hex');

function reproduce() {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(tableSql);
    const rawFacts = [], grouped = new Map();
    // Independently materialize the same session/day cardinality as the performance fixture.
    for (let i = 0; i < 1000; i++) {
      const sid = Math.floor(i / 10), provider = sid % 2 ? 'codex' : 'claude';
      const project_key = `/fixture/project-${Math.floor(sid / 2) % 20}`, session_id = `session-${sid}`;
      const local_day = i % 101 === 0 ? '' : new Date(Date.UTC(2026, 6, 1) + (sid * 17 % 90) * 86400000).toISOString().slice(0, 10);
      const fact = { provider, project_key, session_id, local_day };
      rawFacts.push(fact);
      const key = JSON.stringify(fact), existing = grouped.get(key);
      if (existing) existing.turn_count++;
      else grouped.set(key, { ...fact, turn_count: 1 });
    }
    const insert = db.prepare('INSERT INTO t VALUES(?,?,?,?,?)');
    db.exec('BEGIN');
    for (const row of grouped.values()) insert.run(row.provider, row.project_key, row.session_id, row.local_day, row.turn_count);
    db.exec('COMMIT; ANALYZE;');
    const expectedGroups = new Map();
    for (const row of rawFacts) {
      if (row.local_day !== '' && !(row.local_day >= values[2] && row.local_day < values[3])) continue;
      const key = `${row.provider}\0${row.local_day}`, previous = expectedGroups.get(key);
      if (previous) previous.turns++;
      else expectedGroups.set(key, { provider: row.provider, local_day: row.local_day, turns: 1 });
    }
    const expected = [...expectedGroups.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.local_day.localeCompare(b.local_day));
    const results = {
      orPrimaryPlan: db.prepare(orSql).all(...values),
      forcedSecondary: db.prepare(orSql.replace('FROM t WHERE', 'FROM t INDEXED BY project_day WHERE')).all(...values),
      disjointUnion: db.prepare(unionSql).all(...values, 'claude', 'codex'),
    };
    assert.equal(canonical(results.forcedSecondary), canonical(expected), 'Secondary-index control differs from independent JS raw-fact oracle');
    assert.equal(canonical(results.disjointUnion), canonical(expected), 'Disjoint UNION differs from independent JS raw-fact oracle');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    assert.equal(integrity[0].integrity_check, 'ok');
    return { environment: { node: process.version, sqlite: db.prepare('SELECT sqlite_version() v').get().v, platform: process.platform, arch: process.arch },
      rawFacts: rawFacts.length, storedSessionDayRows: grouped.size, integrity,
      mismatchObserved: canonical(results.orPrimaryPlan) !== canonical(expected),
      expected, results, expectedSha256: digest(expected),
      plans: { or: db.prepare(`EXPLAIN QUERY PLAN ${orSql}`).all(...values).map(v => v.detail),
        forcedSecondary: db.prepare(`EXPLAIN QUERY PLAN ${orSql.replace('FROM t WHERE', 'FROM t INDEXED BY project_day WHERE')}`).all(...values).map(v => v.detail),
        disjointUnion: db.prepare(`EXPLAIN QUERY PLAN ${unionSql}`).all(...values, 'claude', 'codex').map(v => v.detail) },
      reproduction: { tableSql, orSql, values, unionSql, unionValues: [...values, 'claude', 'codex'] },
      conclusion: 'Observed result difference is a query-planner/runtime-specific correctness finding, not a performance improvement. It reproduces in a fresh in-memory table without product queries, caches, migrations, or private data. No upstream root-cause claim.',
      references: ['https://www.sqlite.org/withoutrowid.html', 'https://www.sqlite.org/queryplanner.html#or_connected_terms_in_the_where_clause'] };
  } finally { db.close(); }
}

async function main() {
  const result = reproduce();
  result.sourceSha256 = createHash('sha256').update(readFileSync(__filename)).digest('hex');
  const arg = process.argv.slice(2).find(v => v.startsWith('--output='));
  if (arg) {
    const output = resolve(arg.slice(9));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ output, environment: result.environment, mismatchObserved: result.mismatchObserved,
      expectedGroups: result.expected.length, actualGroups: result.results.orPrimaryPlan.length }));
  } else console.log(JSON.stringify(result, null, 2));
}

module.exports = { reproduce };
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
