import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SummaryDatabase } from '../../src/summary/db';
import { SummaryStaging } from '../../src/summary/staging';
import type { Provider } from '../../src/summary/types';

export type TitleVariant = 'partial-index' | 'combined-aggregate';
export type TitleScenario = 'long-session' | 'mixed-sessions';
export const TITLE_CASES = [
  'main-title', 'no-title', 'subagent-only', 'subagent-before-main', 'null-before-title',
  'first-not-alphabetical', 'unicode', 'identical-titles', 'multiple-main-files', 'ignored-files',
] as const;
const START = Date.UTC(2026, 9, 8);

interface ExpectedRequest {
  provider: Provider;
  session: string;
  root: string;
  title: string | null;
  started: number;
  category: typeof TITLE_CASES[number];
}
export interface TitleFixture {
  database: SummaryDatabase;
  staging: SummaryStaging;
  expected: ExpectedRequest[];
  eventCount: number;
  originalSql: string;
}

/** Capture the actual production SQL without copying the rest of its aggregation logic. */
function captureSql(staging: SummaryStaging): string {
  const connection = staging.connection;
  const original = connection.exec;
  const statements: string[] = [];
  connection.exec = sql => { statements.push(sql); };
  try { staging.prepareSummaries(); } finally { connection.exec = original; }
  assert.equal(statements.length, 1, 'prepareSummaries changed; update the benchmark adapter');
  return statements[0];
}

function replaceOnce(sql: string, before: string, after: string): string {
  assert.equal(sql.split(before).length, 2, 'Production SQL changed; update the title benchmark adapter');
  return sql.replace(before, after);
}

/** Reconstruct the pre-index SQL so later benchmarks retain an identical control. */
export function withoutTitleIndex(sql: string): string {
  const index = /\n      CREATE INDEX temp\.component_request_title ON component_events\(root_id,id\)\r?\n        WHERE is_main=1 AND request_title IS NOT NULL;/g;
  const matches = sql.match(index) ?? [];
  assert.ok(matches.length <= 1, 'Duplicate title index in production SQL');
  const result = sql.replace(index, '');
  assert.ok(!result.includes('component_request_title'), 'Title index changed; update the benchmark adapter');
  return result;
}

/** Test-only alternatives derived from the same production aggregation SQL. */
export function titleVariantSql(original: string, variant: TitleVariant): string {
  original = withoutTitleIndex(original);
  if (variant === 'partial-index') {
    const anchor = 'CREATE INDEX temp.component_events_turn ON component_events(kind,thread_id,turn_id,id);';
    return replaceOnce(original, anchor, `${anchor}
      CREATE INDEX temp.component_request_title ON component_events(root_id,id)
        WHERE is_main=1 AND request_title IS NOT NULL;`);
  }
  const titleLookup = `(SELECT e.request_title FROM component_events e JOIN scan_files sf ON sf.id=e.file_id
          WHERE sf.provider=r.provider AND sf.session_id=r.session_id AND e.root_id=r.root_id
            AND e.is_main=1 AND e.request_title IS NOT NULL ORDER BY e.id LIMIT 1) request_title,`;
  let sql = replaceOnce(original,
    'max(CASE WHEN f.is_main=1 THEN 1 ELSE 0 END) has_main',
    `max(CASE WHEN f.is_main=1 THEN 1 ELSE 0 END) has_main,
          min(CASE WHEN e.is_main=1 AND e.request_title IS NOT NULL THEN e.id END) title_event_id`);
  sql = replaceOnce(sql, titleLookup, 'title.request_title AS request_title,');
  return replaceOnce(sql, 'LEFT JOIN outcomes o ON',
    'LEFT JOIN events title ON title.id=r.title_event_id\n      LEFT JOIN outcomes o ON');
}

export function createTitleFixture(directory: string, scenario: TitleScenario, count = 2000): TitleFixture {
  assert.ok(Number.isSafeInteger(count) && count >= 10 && count <= 100000);
  const database = new SummaryDatabase(join(directory, 'summary.sqlite'));
  let staging: SummaryStaging | undefined;
  try {
    staging = new SummaryStaging(database.connection);
    const active = staging;
    const files = new Map<string, number>();
    const expected: ExpectedRequest[] = [];
    const file = (provider: Provider, session: string, role: string): number => {
      const key = `${provider}/${session}/${role}`;
      const previous = files.get(key);
      if (previous !== undefined) return previous;
      const id = files.size + 1;
      files.set(key, id);
      active.addFile({ id, provider, source_root:directory, path:join(directory, `${id}.jsonl`), session_id:session,
        size_bytes:0, mtime_ms:0, dev:null, inode:null, parser_version:13 }, null, true, role === 'removed');
      active.identity(id, { sessionId:session, threadId:`${session}-${role}`, parentThreadId:null,
        projectKey:'/fixture/project', projectName:'Fixture', isMain:role !== 'subagent' });
      if (role === 'failed') database.connection.prepare('UPDATE scan_files SET failed=1 WHERE id=?').run(id);
      return id;
    };
    active.batchEvents(() => {
      for (let index = 0; index < count; index++) {
        const group = Math.floor(index / 100);
        const provider: Provider = scenario === 'long-session' || group % 2 ? 'codex' : 'claude';
        // Mixed data deliberately repeats both session IDs across providers and root IDs across sessions.
        const session = scenario === 'long-session' ? 'large' : `session-${Math.floor(group / 2)}`;
        const root = `request-${scenario === 'long-session' ? index : index % 100}`;
        const main = file(provider, session, 'main');
        const started = START + index * 2000;
        const offset = index * 1000;
        const category = TITLE_CASES[index % TITLE_CASES.length];
        const label = `요청 ${index}`;
        let title: string | null = label;
        const candidate = (role: string, value?: string): void => {
          active.event(file(provider, session, role), { kind:'turn', rootId:root, isMain:role !== 'subagent', title:value, offset });
        };
        active.event(main, { kind:'turn', rootId:root, isMain:true, startedAt:started, offset });
        switch (category) {
          case 'main-title': candidate('main', label); break;
          case 'no-title': candidate('main'); title = null; break;
          case 'subagent-only': candidate('subagent', label); title = null; break;
          case 'subagent-before-main': candidate('subagent', 'Wrong subagent title'); candidate('main', label); break;
          case 'null-before-title': candidate('main'); candidate('main', label); break;
          case 'first-not-alphabetical': title = `Z first ${index}`; candidate('main', title); candidate('main', `A later ${index}`); break;
          case 'unicode': title = `한글 🐳 café ${index}`; candidate('main', title); break;
          case 'identical-titles': title = '같은 제목'; candidate('main', title); break;
          case 'multiple-main-files': candidate('main-copy', label); candidate('main', 'Wrong later title'); break;
          case 'ignored-files': candidate('removed', 'Wrong removed title'); candidate('failed', 'Wrong failed title'); candidate('main', label); break;
        }
        active.event(main, { kind:'usage', rootId:root, responseId:`response-${index}`, requestId:`usage-${index}`,
          threadId:session, turnId:root, model:'fixture-model', billingMode:'subscription', schema:'current',
          tokens:{ input:100, output:50, cacheRead:20, cacheWrite:10, reasoning:0 }, offset:offset + 100 });
        active.event(main, { kind:'turn', rootId:root, isMain:true, completed:true, completedAt:started + 500,
          duration:500, durationQuality:'exact', status:'completed', statusAt:started + 500, offset:offset + 200 });
        expected.push({ provider, session, root, title, started, category });
      }
      database.connection.exec(`INSERT OR IGNORE INTO component
        SELECT provider,session_id FROM scan_files WHERE failed=0 AND removed=0;`);
    });
    const eventCount = (database.connection.prepare('SELECT count(*) count FROM events').get() as {count:number}).count;
    return { database, staging:active, expected, eventCount, originalSql:captureSql(active) };
  } catch (error) { staging?.close(); database.close(); throw error; }
}

export function titleRows(fixture: TitleFixture): Record<string, unknown>[] {
  return fixture.database.connection.prepare('SELECT * FROM prepared_turns ORDER BY provider,session_id,root_id').all()
    .map(raw => {
      const row: Record<string, unknown> = { ...raw };
      delete row.title_event_id; // B's internal aggregate key is not a user-visible result.
      return row;
    });
}

export function verifyTitleRows(fixture: TitleFixture, rows: Record<string, unknown>[]): void {
  assert.equal(rows.length, fixture.expected.length);
  const byKey = new Map(rows.map(row => [`${row.provider}/${row.session_id}/${row.root_id}`, row]));
  assert.equal(byKey.size, fixture.expected.length);
  for (const item of fixture.expected) {
    const row = byKey.get(`${item.provider}/${item.session}/${item.root}`);
    assert.ok(row, `Missing request: ${item.provider}/${item.session}/${item.root}`);
    assert.equal(row.request_title, item.title, `${item.category}: ${item.provider}/${item.session}/${item.root}`);
    assert.equal(row.input_tokens, 100);
    assert.equal(row.output_tokens, 50);
    assert.equal(row.cache_read_input_tokens, 20);
    assert.equal(row.cache_write_input_tokens, 10);
    assert.equal(row.started, item.started);
    assert.equal(row.completed_at, item.started + 500);
    assert.equal(row.latest_status, 'completed');
    assert.equal(row.billing, 'subscription');
  }
}

export function titleTempSpace(fixture: TitleFixture): {
  liveBytes: number; allocatedBytes: number; freeBytes: number; objects: {name:string;bytes:number}[];
} {
  const connection = fixture.database.connection;
  const objects = connection.prepare("SELECT name,sum(pgsize) bytes FROM dbstat('temp') GROUP BY name ORDER BY name")
    .all() as unknown as {name:string;bytes:number}[];
  const pageSize = (connection.prepare('PRAGMA temp.page_size').get() as {page_size:number}).page_size;
  const pages = (connection.prepare('PRAGMA temp.page_count').get() as {page_count:number}).page_count;
  const free = (connection.prepare('PRAGMA temp.freelist_count').get() as {freelist_count:number}).freelist_count;
  return { liveBytes:objects.reduce((sum, row) => sum + row.bytes, 0), allocatedBytes:pages * pageSize,
    freeBytes:free * pageSize, objects };
}

export function closeTitleFixture(fixture: TitleFixture): void {
  try { fixture.staging.close(); } finally { fixture.database.close(); }
}
