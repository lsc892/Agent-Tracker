// 실험 전용: 사전 집계와 저장용 TEMP 없이 인덱스 조회·세션 일괄 교체를 비교한다.
const assert = require('node:assert/strict');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const { SessionStore } = require('../../dist/src/summary/db/sessions');
const { TURN_COLUMNS } = require('../../dist/src/summary/db/sessionChanges');
const { buildUsageQuery, buildUsageCountQuery } = require('../../dist/src/summary/db/queries');
const { nonnegative } = require('../../dist/src/summary/db/validation');

// websiteId = project_key; eventName은 대응 컬럼이 없어 status를 사용한다.
// 모델은 별도 사실 테이블에 있으므로 요청 테이블의 복합 인덱스에 넣지 않는다.
const INDEX_SQL = `
DROP INDEX IF EXISTS idx_summary_period;
DROP INDEX IF EXISTS idx_summary_project_period;
CREATE INDEX IF NOT EXISTS bench_created ON turn_summary(started_at_ms);
CREATE INDEX IF NOT EXISTS bench_session ON turn_summary(provider,session_id);
CREATE INDEX IF NOT EXISTS bench_project ON turn_summary(project_key);
CREATE INDEX IF NOT EXISTS bench_project_created ON turn_summary(project_key,started_at_ms);
CREATE INDEX IF NOT EXISTS bench_project_created_status ON turn_summary(project_key,started_at_ms,status);
CREATE INDEX IF NOT EXISTS bench_project_session_created ON turn_summary(project_key,provider,session_id,started_at_ms);
DROP TABLE IF EXISTS usage_request_daily;
DROP TABLE IF EXISTS usage_model_daily;
DROP TABLE IF EXISTS usage_rollup_meta;`;

function turnValues(row, now) {
  for (const name of ['input_tokens', 'output_tokens', 'total_tokens', 'duration_ms',
    'cache_write_input_tokens', 'cache_read_input_tokens']) {
    if (row[name] != null) nonnegative(row[name], name);
  }
  if ((row.cache_write_input_tokens ?? 0) + (row.cache_read_input_tokens ?? 0) > row.input_tokens) {
    throw new RangeError('Cache components cannot exceed input tokens');
  }
  return TURN_COLUMNS.map(name => {
    if (name === 'updated_at') return row[name] ?? now;
    if (name.startsWith('cache_') && row[name] === undefined) return 0;
    return row[name] ?? null;
  });
}

class IndexOnlySessionStore extends SessionStore {
  replaceSessions(replacement) {
    const d = this.database, c = d.connection, key = (p, s) => JSON.stringify([p, s]);
    d.transaction(() => {
      const sessions = [...replacement.sessions], keys = new Set(sessions.map(s => key(s.provider, s.session_id)));
      const requireSession = (p, s) => {
        if (s !== null && !keys.has(key(p, s))) throw new Error('Manifest file is outside the replacement session group');
      };
      const projects = new Set(), retained = new Set(), retainedRoots = new Set(), savedCaps = [];
      const removed = new Set(replacement.removedFileIds ?? []), links = new Map();
      const file = d.statement('SELECT provider,session_id FROM manifest WHERE id=?');
      for (const id of removed) {
        const previous = file.get(id);
        if (previous) requireSession(previous.provider, previous.session_id);
      }
      for (const link of replacement.reconnectedFiles ?? []) {
        const previous = file.get(link.old_id), current = file.get(link.new_id);
        if (link.old_id === link.new_id || !removed.has(link.old_id) || !previous || !current || previous.provider !== current.provider) {
          throw new Error('Invalid reconnected source');
        }
        requireSession(current.provider, current.session_id); links.set(link.old_id, link.new_id);
      }
      if (replacement.retainDeletedSourceUsage) for (const id of removed) {
        if (links.has(id)) continue;
        const previous = file.get(id);
        if (!previous) continue;
        for (const row of d.statement(`SELECT t.id,t.provider,t.root_turn_id FROM turn_summary t
          WHERE provider=? AND session_id=? AND trim(session_id)<>'' AND trim(root_turn_id)<>'' AND total_tokens>0
          AND EXISTS(SELECT 1 FROM turn_model_usage m WHERE m.turn_id=t.id AND trim(model)<>'' AND input_tokens+output_tokens>0)`)
          .all(previous.provider, previous.session_id)) {
          retained.add(row.id); retainedRoots.add(key(row.provider, row.root_turn_id));
        }
      }
      for (const s of sessions) {
        for (const row of d.statement('SELECT DISTINCT project_key FROM turn_summary WHERE provider=? AND session_id=?').all(s.provider, s.session_id)) projects.add(row.project_key);
        if (replacement.preserveCapabilities) for (const row of d.statement(`SELECT t.id,t.provider,t.session_id,t.root_turn_id,u.category,u.name,u.usage_count
          FROM turn_summary t JOIN turn_capability_usage u ON u.turn_id=t.id WHERE provider=? AND session_id=?`).all(s.provider, s.session_id)) {
          if (!retained.has(row.id)) savedCaps.push(row);
        }
      }
      const now = new Date().toISOString();
      const update = d.statement(`UPDATE manifest SET source_root=?,path=?,session_id=?,size_bytes=?,mtime_ms=?,dev=?,inode=?,parser_version=?,
        capabilities_collected=?,source_identity=?,content_hash=?,source_missing=0,processing_status='done',processing_position='committed',recorded_at=?,last_error=NULL
        WHERE id=? AND provider=?`);
      for (const f of replacement.files) {
        nonnegative(f.size_bytes, 'size_bytes');
        const previous = file.get(f.id);
        if (!previous || previous.provider !== f.provider) throw new Error('Replacement refers to an unknown manifest file');
        requireSession(previous.provider, previous.session_id); requireSession(f.provider, f.session_id);
        update.run(f.source_root, f.path, f.session_id, f.size_bytes, f.mtime_ms, f.dev, f.inode, f.parser_version,
          f.capabilities_collected ?? 1, f.source_identity ?? null, f.content_hash ?? null, now, f.id, f.provider);
      }
      for (const s of sessions) {
        if (!retained.size) d.statement('DELETE FROM turn_summary WHERE provider=? AND session_id=?').run(s.provider, s.session_id);
        else for (const row of d.statement('SELECT id FROM turn_summary WHERE provider=? AND session_id=?').all(s.provider, s.session_id)) {
          if (!retained.has(row.id)) d.statement('DELETE FROM turn_summary WHERE id=?').run(row.id);
        }
      }
      const insert = d.statement(`INSERT INTO turn_summary(${TURN_COLUMNS}) VALUES(${TURN_COLUMNS.map(() => '?')})`);
      for (const row of replacement.summaries) {
        requireSession(row.provider, row.session_id);
        if (retainedRoots.has(key(row.provider, row.root_turn_id))) continue;
        d.statement(`INSERT INTO projects VALUES(?,?) ON CONFLICT(project_key)
          DO UPDATE SET project_name=excluded.project_name WHERE project_name<>excluded.project_name`).run(row.project_key, row.project_name);
        d.statement(`INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(provider,session_id)
          DO UPDATE SET session_name=excluded.session_name WHERE excluded.session_name IS NOT NULL AND session_name IS NOT excluded.session_name`)
          .run(row.provider, row.session_id, row.session_name?.trim() || null);
        projects.add(row.project_key);
        const id = insert.run(...turnValues(row, now)).lastInsertRowid;
        this.insertCapabilityUsage(row, id); this.insertModelUsage(row, id); this.saveSummaryCost(row, id);
      }
      for (const row of savedCaps) {
        const current = d.statement('SELECT id FROM turn_summary WHERE provider=? AND session_id=? AND root_turn_id=?').get(row.provider, row.session_id, row.root_turn_id);
        if (current) d.statement('INSERT INTO turn_capability_usage VALUES(?,?,?,?)').run(current.id, row.category, row.name, row.usage_count);
      }
      for (const [oldId, newId] of links) {
        for (const s of sessions) d.statement('UPDATE turn_summary SET diagnostic_file_id=? WHERE provider=? AND session_id=? AND diagnostic_file_id=?')
          .run(newId, s.provider, s.session_id, oldId);
      }
      for (const id of removed) {
        const previous = file.get(id);
        const keep = previous && !links.has(id) && d.statement('SELECT id FROM turn_summary WHERE provider=? AND session_id=?').all(previous.provider, previous.session_id).some(row => retained.has(row.id));
        if (keep) d.statement('UPDATE manifest SET source_missing=1,recorded_at=? WHERE id=? AND source_missing=0').run(now, id);
        else d.statement('DELETE FROM manifest WHERE id=?').run(id);
      }
      for (const s of sessions) d.statement(`DELETE FROM sessions WHERE provider=? AND session_id=?
        AND NOT EXISTS(SELECT 1 FROM turn_summary t WHERE t.provider=sessions.provider AND t.session_id=sessions.session_id)`).run(s.provider, s.session_id);
      for (const project of projects) d.statement(`DELETE FROM projects WHERE project_key=?
        AND NOT EXISTS(SELECT 1 FROM turn_summary t WHERE t.project_key=projects.project_key)`).run(project);
    });
  }
}

function openDatabase(path, variant) {
  const db = new SummaryDatabase(path);
  try {
  if (variant === 'B') {
    // 실험 어댑터만 교체하며 제품 소스·빌드·설치 DB는 변경하지 않는다.
    db.connection.exec(INDEX_SQL);
    db.sqlite.rollups = { clear() {}, refreshSession() {}, refreshChangedSessions() {}, read(_tz, action) { return action(false); } };
    db.sessions = new IndexOnlySessionStore(db.sqlite, db.billing);
    db.reader.usageQueries = (filter, grouping, timezone, by, sort, action, tableSort) => action({
      rows: buildUsageQuery(filter, grouping, timezone, by, sort, tableSort),
      count: buildUsageCountQuery(filter, grouping, timezone, by),
    });
    assert.equal(db.connection.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'usage_%'").get().n, 0);
  }
  return db;
  } catch (error) { db.close(); throw error; }
}

module.exports = { openDatabase, INDEX_SQL };
