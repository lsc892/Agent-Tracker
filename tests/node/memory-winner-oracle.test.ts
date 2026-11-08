// DTO 보관 결과를 원본 전체 비교와 이전 SQL winner 규칙에 각각 대조한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MemoryEvents, type MemoryEvent, type MemoryFile, type RawMemoryEvent } from '../../src/summary/staging/memoryEvents';
import type { ParseEvent, UsageEvent } from '../../src/summary/types';

const file = (id: number, provider: MemoryFile['provider'] = 'claude', session: string | null = 'session'): MemoryFile => ({
  id, provider, session_id: session, parsed: 1, failed: 0, removed: 0,
  thread_id: `thread-${id}`, parent_thread_id: null, forked_from_id: null,
});
const usage = (responseId: string, input: number, extra: Partial<UsageEvent> = {}): UsageEvent => ({
  kind: 'usage', rootId: 'root', responseId, requestId: null, threadId: 'thread', turnId: 'turn', schema: 'current',
  tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, offset: 0, ...extra,
});
type Candidate = RawMemoryEvent & { event: UsageEvent; file: MemoryFile; request: string | null };
const score = (row: Candidate): bigint => BigInt(row.event.tokens.input) + BigInt(row.event.tokens.output);

// This oracle compares every raw candidate with every competitor; it never drops an intermediate candidate.
function oracle(raw: RawMemoryEvent[], files: MemoryFile[]): {rows: MemoryEvent[]; canonical: [number, string | null][]} {
  const active = raw.filter(row => files.some(f => f.id === row.fileId && !f.removed && !f.failed && f.session_id !== null));
  const candidates: Candidate[] = active.filter((row): row is RawMemoryEvent & {event: UsageEvent} => row.event.kind === 'usage')
    .map(row => {
      const source = files.find(f => f.id === row.fileId)!;
      let request = row.event.requestId;
      if (source.provider === 'claude' && request === null) {
        const requests = new Set(active.filter(other => {
          const otherFile = files.find(f => f.id === other.fileId)!;
          return other.event.kind === 'usage' && otherFile.provider === source.provider
            && otherFile.session_id === source.session_id && other.event.responseId === row.event.responseId;
        }).flatMap(other => other.event.kind === 'usage' && other.event.requestId !== null ? [other.event.requestId] : []));
        request = requests.size === 1 ? [...requests][0] : null;
      }
      return {...row, file: source, request};
    });
  const sameGroup = (a: Candidate, b: Candidate): boolean => a.file.provider === b.file.provider
    && a.file.session_id === b.file.session_id && a.event.responseId === b.event.responseId
    && (a.file.provider === 'claude' ? (a.request ?? 'no-req') === (b.request ?? 'no-req')
      : a.event.threadId === b.event.threadId && a.event.turnId === b.event.turnId);
  const winners = candidates.filter(row => !candidates.some(other => sameGroup(row, other)
    && (score(other) > score(row) || score(other) === score(row) && other.id > row.id)));
  const rows: MemoryEvent[] = [];
  const lost: RawMemoryEvent[] = [];
  const previousCapabilities: unknown[][] = [];
  for (const row of active) {
    let retained = row.event.kind !== 'usage' || winners.some(winner => winner.id === row.id);
    if (row.event.kind === 'capability') {
      const source = files.find(f => f.id === row.fileId)!;
      const key = [source.provider, source.session_id, row.event.rootId, row.event.threadId,
        row.event.eventId, row.event.category, row.event.name];
      retained = !previousCapabilities.some(previous => previous.every((value, index) => value === key[index]));
      previousCapabilities.push(key);
    }
    if (retained) rows.push(row); else lost.push(row);
  }
  for (const row of lost) {
    if (lost.some(previous => previous.fileId === row.fileId && previous.event.rootId === row.event.rootId && previous.id < row.id)) continue;
    rows.push({id: row.id, fileId: row.fileId, event: {kind: 'anchor', rootId: row.event.rootId,
      offset: Math.min(...lost.filter(other => other.fileId === row.fileId && other.event.rootId === row.event.rootId).map(other => other.event.offset))}});
  }
  return {rows: rows.sort((a, b) => a.id - b.id), canonical: winners.map(row => [row.id, row.request])};
}

// Kept equivalent to commit 80fc586's full-event candidates/ranked SQL, including the literal no-req fallback.
const previousWinners = `WITH candidates AS (
  SELECT e.*,f.provider,f.session_id,
    CASE WHEN f.provider='claude' AND e.request_id IS NULL THEN
      (SELECT CASE WHEN count(DISTINCT e2.request_id)=1 THEN min(e2.request_id) ELSE NULL END
       FROM events e2 JOIN files f2 ON f2.id=e2.file_id
       WHERE f2.provider=f.provider AND f2.session_id=f.session_id AND e2.response_id=e.response_id
         AND f2.removed=0 AND f2.failed=0 AND f2.session_id IS NOT NULL)
      ELSE e.request_id END canonical_request
  FROM events e JOIN files f ON f.id=e.file_id WHERE f.removed=0 AND f.failed=0 AND f.session_id IS NOT NULL
), ranked AS (
  SELECT *,row_number() OVER(PARTITION BY provider,session_id,response_id,
    CASE WHEN provider='claude' THEN coalesce(canonical_request,'no-req') ELSE thread_id END,
    CASE WHEN provider='claude' THEN '' ELSE turn_id END ORDER BY input+output DESC,id DESC) rank FROM candidates
)`;

function sqlWinners(raw: RawMemoryEvent[], files: MemoryFile[]): {canonical: [number, string | null][]; totals: unknown[]} {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE files(id INTEGER,provider TEXT,session_id TEXT,removed INTEGER,failed INTEGER);
      CREATE TABLE events(id INTEGER,file_id INTEGER,root_id TEXT,response_id TEXT,request_id TEXT,thread_id TEXT,turn_id TEXT,
        input INTEGER,output INTEGER,cache_read INTEGER,cache_write INTEGER,reasoning INTEGER);`);
    const insertFile = db.prepare('INSERT INTO files VALUES(?,?,?,?,?)');
    for (const f of files) insertFile.run(f.id, f.provider, f.session_id, f.removed, f.failed);
    const insertEvent = db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const row of raw) if (row.event.kind === 'usage') {
      const e = row.event;
      insertEvent.run(row.id, row.fileId, e.rootId, e.responseId, e.requestId, e.threadId, e.turnId,
        e.tokens.input, e.tokens.output, e.tokens.cacheRead, e.tokens.cacheWrite, e.tokens.reasoning);
    }
    const canonical = db.prepare(`${previousWinners} SELECT id,canonical_request FROM ranked WHERE rank=1 ORDER BY id`).all()
      .map(row => [row.id as number, row.canonical_request as string | null] as [number, string | null]);
    const statement = db.prepare(`${previousWinners} SELECT provider,session_id,root_id,sum(input) input,sum(output) output,
      sum(cache_read) cache_read,sum(cache_write) cache_write,sum(reasoning) reasoning FROM ranked WHERE rank=1
      GROUP BY provider,session_id,root_id ORDER BY provider,session_id,root_id`);
    statement.setReadBigInts(true);
    return {canonical, totals: statement.all().map(row => [row.provider, row.session_id, row.root_id,
      row.input, row.output, row.cache_read, row.cache_write, row.reasoning])};
  } finally {db.close();}
}

function totals(rows: MemoryEvent[], files: MemoryFile[]): unknown[] {
  const groups = new Map<string, {key: string[]; sums: bigint[]}>();
  for (const row of rows) if (row.event.kind === 'usage') {
    const f = files.find(source => source.id === row.fileId)!;
    const key = [f.provider, f.session_id!, row.event.rootId];
    const group = groups.get(JSON.stringify(key)) ?? {key, sums: [0n, 0n, 0n, 0n, 0n]};
    const values = row.event.tokens;
    [values.input, values.output, values.cacheRead, values.cacheWrite, values.reasoning].forEach((value, index) => group.sums[index] += BigInt(value));
    groups.set(JSON.stringify(key), group);
  }
  return [...groups.values()].sort((a, b) => {
    for (let i = 0; i < 3; i++) if (a.key[i] !== b.key[i]) return a.key[i] < b.key[i] ? -1 : 1;
    return 0;
  }).map(group => [...group.key, ...group.sums]);
}

function verify(memory: MemoryEvents, raw: RawMemoryEvent[], files: MemoryFile[], label: string): void {
  const expected = oracle(raw, files), sql = sqlWinners(raw, files), actual = memory.deduplicate(files);
  assert.deepEqual(expected.canonical, sql.canonical, `${label}: full-event brute-force and previous SQL winners`);
  assert.deepEqual([...actual.canonical].sort((a, b) => a[0] - b[0]), sql.canonical, `${label}: DTO canonical winners`);
  assert.deepEqual([...actual.rows].sort((a, b) => a.id - b.id), expected.rows, `${label}: complete DTOs, controls and source anchors`);
  assert.deepEqual(totals(actual.rows, files), sql.totals, `${label}: all five token totals per provider/session/root`);
}

function recoverLegacy(memory:MemoryEvents,raw:RawMemoryEvent[]):void {
  for(const fileId of memory.recoveryFiles()) {
    let legacyIndex=0;
    for(const row of raw)if(row.fileId===fileId&&row.event.kind==='usage'&&row.event.schema==='legacy') {
      memory.recoverLegacy(fileId,row.event,legacyIndex++);
    }
    memory.finishRecovery(fileId);
  }
}

test('DTO candidates match full-event brute force and previous SQL totals over seeded streams', () => {
  let seed = 0x20261106;
  const random = (max: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  for (let trial = 0; trial < 80; trial++) {
    const files = [file(1), file(2), file(3, 'claude', 'other'), file(4, 'codex'), file(5, 'codex'), file(6, 'codex', 'other'),
      {...file(7), removed: 1}, {...file(8), failed: 1}, file(9, 'claude', null)];
    const memory = new MemoryEvents(), raw: RawMemoryEvent[] = [];
    for (let id = 1; id <= 90; id++) {
      const fileId = 1 + random(files.length), rootId = `root-${random(4)}`, offset = random(1000);
      let event: ParseEvent;
      const kind = random(10);
      if (kind < 7) {
        const requestId = [null, null, 'a', 'b', 'no-req'][random(5)];
        event = usage(`response-${random(5)}`, random(25) === 0 ? Number.MAX_SAFE_INTEGER : random(6), {
          rootId, requestId, threadId: `thread-${random(2)}`, turnId: `turn-${random(2)}`, offset,
          model: `model-${random(3)}`, schema: trial % 2 ? 'legacy' : random(3) ? 'current' : 'legacy',
        });
        event.tokens = {...event.tokens, output: random(6), cacheRead: random(20), cacheWrite: random(20), reasoning: random(20)};
      } else if (kind < 9) event = {kind: 'capability', rootId, threadId: `thread-${random(2)}`,
        eventId: `call-${random(3)}`, category: 'skill', name: `tool-${random(2)}`, offset};
      else event = {kind: 'turn', rootId, isMain: true, startedAt: random(100), offset};
      memory.add(fileId, event);
      raw.push({id, fileId, event});
    }
    const currentFiles = new Set(raw.filter(row => row.event.kind === 'usage' && row.event.schema === 'current').map(row => row.fileId));
    memory.excludeLegacy();
    memory.excludePrefixes(files);
    recoverLegacy(memory,raw);
    verify(memory, raw.filter(row => row.event.kind !== 'usage' || row.event.schema !== 'legacy' || !currentFiles.has(row.fileId)), files, `seed 0x20261106 trial ${trial}`);
  }
});

test('late request ambiguity preserves each original request winner and the historical no-req collision', () => {
  const memory = new MemoryEvents(), files = [file(1), file(2)], raw: RawMemoryEvent[] = [];
  const events = [usage('ambiguous', 150), usage('ambiguous', 120, {requestId: 'a'}),
    usage('ambiguous', 130, {requestId: 'b'}), usage('ambiguous', 151, {requestId: 'no-req'}),
    usage('unique', 100), usage('unique', 90, {requestId: 'a'}), usage('unique', 80, {requestId: 'a'})];
  events.forEach((event, index) => {const fileId = index % 2 + 1; memory.add(fileId, event); raw.push({id: index + 1, fileId, event});});
  verify(memory, raw, files, 'late ambiguity');
  assert.deepEqual([...memory.deduplicate(files).canonical.keys()].sort((a, b) => a - b), [2, 3, 4, 5]);
});

test('discarding a failed chunk leaves the accepted winner and original source positions intact', () => {
  const memory = new MemoryEvents(), files = [file(1)], original = usage('response', 10, {offset: 20});
  memory.add(1, original);
  memory.beginBatch();
  memory.add(1, usage('response', 100, {offset: 5}));
  memory.add(1, usage('other', 200));
  memory.rollbackBatch();
  verify(memory, [{id: 1, fileId: 1, event: original}], files, 'rollback overwritten winner');
  const accepted = usage('response', 10, {offset: 30, model: 'accepted-later-tie'});
  memory.beginBatch();
  memory.add(1, accepted);
  memory.commitBatch();
  verify(memory, [{id: 1, fileId: 1, event: original}, {id: 2, fileId: 1, event: accepted}], files, 'accepted after rollback');
});

test('legacy prefix removal reveals a lower-scoring later candidate rather than losing the response', () => {
  const memory = new MemoryEvents(), parent = file(1, 'codex'), child = {...file(2, 'codex'), forked_from_id: parent.thread_id};
  const ancestor = usage('response', 100, {schema: 'legacy', rootId: 'copied', threadId: parent.thread_id!});
  const inherited = {...ancestor, threadId: child.thread_id!};
  const correction = usage('response', 50, {schema: 'legacy', rootId: 'new', threadId: child.thread_id!, offset: 50});
  memory.add(1, ancestor); memory.add(2, inherited); memory.add(2, correction);
  assert.deepEqual(memory.excludePrefixes([parent, child]), [2]);
  verify(memory, [{id: 1, fileId: 1, event: ancestor}, {id: 3, fileId: 2, event: correction}], [parent, child], 'prefix lower-scoring fallback');
});

test('a dense stream stores only its provisional winner and preserves the full-event SQL result', () => {
  const memory = new MemoryEvents(), files = [file(1)], raw: RawMemoryEvent[] = [];
  for (let id = 1; id <= 400; id++) {
    const event = usage('dense-response', id % 2 ? 500 : 501, {
      model: `complete-dto-${id}`, offset: (id * 47) % 503,
    });
    event.tokens = {...event.tokens, output: id % 2 ? 1 : 0, cacheRead: id % 13, cacheWrite: id % 7};
    memory.add(1,event);raw.push({id,fileId:1,event});
  }
  assert.equal([...memory.rows()].filter(row=>row.event.kind==='usage').length,1,
    'one fixed provisional group keeps one usage DTO rather than its defeated candidates');
  verify(memory,raw,files,'dense max stream and equal-score latest full DTO');
  const retained=memory.deduplicate(files).rows.find(row=>row.event.kind==='usage')!;
  assert.equal(retained.id,400);
  assert.equal((retained.event as UsageEvent).model,'complete-dto-400');
});

test('a later winner replacement moves an existing source anchor back to the earliest defeated event',()=>{
  const memory=new MemoryEvents(),files=[file(1)],raw:RawMemoryEvent[]=[];
  [usage('same',100,{offset:8}),usage('same',50,{offset:4}),usage('same',200,{offset:12})].forEach((event,index)=>{
    memory.add(1,event);raw.push({id:index+1,fileId:1,event});
  });
  verify(memory,raw,files,'early winner replaced after a later loser made the first anchor');
  const anchor=memory.deduplicate(files).rows.find(row=>row.event.kind==='anchor')!;
  assert.equal(anchor.id,1);assert.equal(anchor.event.offset,4);
});

test('provisional groups preserve schema and original-root boundaries until validity is known', () => {
  const memory=new MemoryEvents(),files=[file(1,'codex')],raw:RawMemoryEvent[]=[];
  const events=[
    usage('same',100,{schema:'legacy',rootId:'first'}),
    usage('same',90,{schema:'current',rootId:'first'}),
    usage('same',80,{schema:'current',rootId:'second'}),
    usage('same',85,{schema:'current',rootId:'second',offset:7}),
  ];
  events.forEach((event,index)=>{memory.add(1,event);raw.push({id:index+1,fileId:1,event});});
  memory.excludeLegacy();
  verify(memory,raw.filter(row=>row.event.kind!=='usage'||row.event.schema!=='legacy'),files,'mixed-generation max groups');
});

test('prefix proof compares original legacy order even when a parent provisional group was reduced', () => {
  const memory=new MemoryEvents(),parent=file(1,'codex'),child={...file(2,'codex'),forked_from_id:parent.thread_id};
  const first=usage('shared',100,{schema:'legacy',rootId:'copied',threadId:parent.thread_id!,offset:1});
  const second=usage('shared',110,{schema:'legacy',rootId:'copied',threadId:parent.thread_id!,offset:2});
  const inherited={...first,threadId:child.thread_id!};
  const fresh=usage('fresh',20,{schema:'legacy',rootId:'fresh',threadId:child.thread_id!,offset:3});
  memory.add(1,first);memory.add(1,second);memory.add(2,inherited);memory.add(2,fresh);
  assert.deepEqual(memory.excludePrefixes([parent,child]),[2]);
  verify(memory,[{id:1,fileId:1,event:first},{id:2,fileId:1,event:second},{id:4,fileId:2,event:fresh}],
    [parent,child],'legacy prefix compares raw order rather than retained winners');
});

test('prefix invalidation reparses a lower valid legacy candidate instead of retaining defeated DTOs',()=>{
  const memory=new MemoryEvents(),parent=file(1,'codex'),child={...file(2,'codex'),forked_from_id:parent.thread_id};
  const original=usage('shared',100,{schema:'legacy',threadId:parent.thread_id!,offset:1});
  const copied={...original,threadId:child.thread_id!};
  const lower=usage('shared',50,{schema:'legacy',threadId:child.thread_id!,offset:3,model:'valid-lower'});
  const raw=[{id:1,fileId:1,event:original},{id:2,fileId:2,event:copied},{id:3,fileId:2,event:lower}];
  for(const row of raw)memory.add(row.fileId,row.event);
  assert.equal([...memory.rows()].filter(row=>row.fileId===2&&row.event.kind==='usage').length,1,
    'the defeated lower legacy DTO is not held before prefix validation');
  assert.deepEqual(memory.excludePrefixes([parent,child]),[2]);
  assert.deepEqual(memory.recoveryFiles(),[2],'a surviving evidence position requires a file reread');
  recoverLegacy(memory,raw);
  assert.deepEqual(memory.recoveryFiles(),[]);
  verify(memory,[raw[0],raw[2]],[parent,child],'source reread restores a post-prefix lower winner');
});

test('an unavailable recovery source does not block winners from an independent healthy source',()=>{
  const memory=new MemoryEvents(),parent=file(1,'codex'),child={...file(2,'codex'),forked_from_id:parent.thread_id};
  const healthy=file(3,'claude','independent');
  const ancestor=usage('shared',100,{schema:'legacy',threadId:parent.thread_id!,offset:1});
  const copied={...ancestor,threadId:child.thread_id!};
  const lower=usage('shared',50,{schema:'legacy',threadId:child.thread_id!,offset:2});
  const independent=usage('healthy',70);
  const raw=[{id:1,fileId:1,event:ancestor},{id:2,fileId:2,event:copied},
    {id:3,fileId:2,event:lower},{id:4,fileId:3,event:independent}];
  for(const row of raw)memory.add(row.fileId,row.event);
  memory.excludePrefixes([parent,child,healthy]);
  assert.deepEqual(memory.recoveryFiles(),[2]);
  assert.throws(()=>memory.recoverLegacy(2,{...lower,offset:99},1),/source changed/,
    'a changed source cannot supply a replacement for the accepted snapshot');
  verify(memory,[raw[0],raw[3]],[parent,{...child,failed:1},healthy],'failed recovery is isolated from healthy sources');
  memory.release([2]);
  assert.deepEqual(memory.recoveryFiles(),[],'settled failed sources release their recovery evidence');
});
