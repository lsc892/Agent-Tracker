// 설치 DB의 날짜 저장 구조를 읽기 전용으로 조사하고 내용 없는 집계 수치만 보존한다.
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function profile(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const scalar = sql => Object.values(db.prepare(sql).get())[0];
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name);
    const counts = {};
    for (const table of ['manifest', 'projects', 'sessions', 'turn_summary', 'turn_model_usage',
      'turn_capability_usage', 'usage_request_daily', 'usage_model_daily']) {
      if (tables.includes(table)) counts[table] = scalar(`SELECT count(*) FROM ${table}`);
    }
    return {
      observedAt: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date()),
      access: 'read-only connection, query_only, one read transaction; no migration or source logs',
      node: process.version, sqlite: scalar('SELECT sqlite_version()'),
      schemaVersion: scalar('PRAGMA user_version'), pageSize: scalar('PRAGMA page_size'),
      pages: scalar('PRAGMA page_count'), freePages: scalar('PRAGMA freelist_count'), counts,
      unknownTime: tables.includes('turn_summary') ? scalar('SELECT count(*) FROM turn_summary WHERE started_at_ms IS NULL') : null,
      allocated: db.prepare('SELECT name,sum(pgsize) AS bytes,count(*) AS pages FROM dbstat GROUP BY name ORDER BY name').all(),
      indexes: db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name").all(),
      scope: 'Page allocation and aggregate counts only. No paths, names, titles, prompts, responses, credentials or tokens are exported. WAL/TEMP/OS cache are excluded.',
    };
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  assert.ok(args.every(arg => arg.startsWith('--db=') || arg.startsWith('--output=')), 'Unknown option');
  const path = args.find(arg => arg.startsWith('--db='))?.slice(5)
    ?? join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'agenttracker.agent-tracker', 'agent-tracker.sqlite');
  const output = resolve(args.find(arg => arg.startsWith('--output='))?.slice(9)
    ?? 'docs/benchmarks/DateStorageProfile-2026-10-25.json');
  const result = profile(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`Read-only profile saved: ${output}\n`);
}

module.exports = { profile };
