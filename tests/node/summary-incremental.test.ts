// 큰 세션 snapshot의 일별 교체, 쓰기 범위와 롤백을 검증한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SummaryDatabase, type TurnSummaryInput } from '../../src/summary/db';

function row(id: string, date: string | null, tokens = 10): TurnSummaryInput {
  return { provider: 'codex', session_id: 's', project_key: 'p', project_name: 'Project', root_turn_id: id,
    started_at_ms: date === null ? null : Date.parse(date), input_tokens: tokens, output_tokens: 0, total_tokens: tokens,
    duration_ms: 1, duration_quality: 'exact', status: 'completed',
    model_usage: [{ model: 'gpt-5.6-sol', input_tokens: tokens, output_tokens: 0, cache_write_input_tokens: 0, cache_read_input_tokens: 0 }],
    capability_usage: [{ category: 'skill', name: 'test', usage_count: 1 }] };
}

const sessions = [{ provider: 'codex' as const, session_id: 's' }];
function replace(db: SummaryDatabase, summaries: Iterable<TurnSummaryInput>): void {
  db.replaceMemory({sessions, files: [], summaries });
}


test('large replacements update only changed daily rows and delete obsolete day keys', t => {
  const db = new SummaryDatabase(':memory:');
  t.after(() => db.close());
  const first = Array.from({length:600}, (_,i) => row(`first-${i}`, '2026-10-01T01:00:00Z'));
  const second = Array.from({length:400}, (_,i) => row(`second-${i}`, '2026-10-02T01:00:00Z'));
  replace(db, [...first,...second]);
  db.connection.exec(`CREATE TEMP TABLE daily_writes(day TEXT, action TEXT);
    CREATE TEMP TRIGGER audit_update AFTER UPDATE ON main.usage_request_daily
      BEGIN INSERT INTO daily_writes VALUES (NEW.local_day,'update'); END;
    CREATE TEMP TRIGGER audit_delete AFTER DELETE ON main.usage_request_daily
      BEGIN INSERT INTO daily_writes VALUES (OLD.local_day,'delete'); END;`);
  replace(db, [...first,...second]);
  assert.deepEqual(db.connection.prepare('SELECT * FROM daily_writes').all(), []);
  const extra = row('extra', '2026-10-01T01:00:00Z');
  replace(db, [...first,...second,extra]);
  assert.deepEqual(db.connection.prepare('SELECT day, action FROM daily_writes').all().map(r => [r.day,r.action]), [['2026-10-01','update']]);
  assert.deepEqual(db.queryUsage({},'day').map(r => [r.period,r.total_tokens,r.turn_count]), [
    ['2026-10-01',6010,601], ['2026-10-02',4000,400],
  ]);
  replace(db, [...first,extra]);
  assert.deepEqual(db.queryUsage({},'day').map(r => r.period), ['2026-10-01']);
  assert.deepEqual(db.connection.prepare("SELECT day FROM daily_writes WHERE action='delete'").all().map(r => r.day), ['2026-10-02']);
});

test('one-shot session replacement preserves Skill history and rolls back a later invalid model split', t => {
  const db = new SummaryDatabase(':memory:');
  t.after(() => db.close());
  const original = row('existing','2026-10-01T01:00:00Z');
  replace(db, [original]);
  db.setSessionBilling('codex','s','subscription');
  const before = db.queryUsage({includeCosts:true});
  const skill = db.queryCapabilities({},'skill');
  let consumed = 0;
  function* invalid(): IterableIterator<TurnSummaryInput> {
    consumed++; yield row('new','2026-10-02T01:00:00Z');
    consumed++; yield {...original, model_usage:[]};
  }
  assert.throws(() => replace(db, invalid()), /Model totals/);
  assert.equal(consumed,2);
  assert.deepEqual(db.queryUsage({includeCosts:true}),before);
  assert.deepEqual(db.queryCapabilities({},'skill'),skill);
  db.replaceMemory({sessions, files:[], summaries:[{...original,capability_usage:undefined}], preserveCapabilities:true});
  assert.equal(db.sessionBilling('codex','s'),'subscription');
  assert.deepEqual(db.queryUsage({includeCosts:true}),before);
  assert.deepEqual(db.queryCapabilities({},'skill'),skill);
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
});
