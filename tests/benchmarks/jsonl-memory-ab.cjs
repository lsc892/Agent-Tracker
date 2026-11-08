// 기존 SQL TEMP와 파일 DTO 재사용·메모리 최종 집계·직접 영속 저장을 같은 고정 입력에서 비교한다.
const { summaryPath } = require('./summary-paths.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdir, mkdtemp, copyFile, writeFile, appendFile, truncate, utimes, unlink, cp } = require('node:fs/promises');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { join, resolve, dirname, basename, relative, sep } = require('node:path');
const { cpus } = require('node:os');
const { performance } = require('node:perf_hooks');
const helpers = require('./incremental-refresh.cjs');
const { allUsage, independentCheck, canonical, stats, fingerprints } = require('./temp-batch-ab.cjs');

const root = resolve(__dirname, '../..'), groups = ['day', 'month', 'session', 'project'];
const scenarios = ['initial', 'unchanged', 'claude-1', 'codex-1', 'codex-100', 'codex-1000'];
const equalityKeys = ['requests', 'tokens', 'failed', 'factsSha256', 'aggregatesSha256', 'independent'];
const sha = value => createHash('sha256').update(value).digest('hex');
const seoul = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const optional = (product, name) => {
  const file = summaryPath(product, `dist/src/summary/${name}.js`);
  return fs.existsSync(file) ? require(file) : undefined;
};

function instrument(product, db, profile) {
  const reader=require(join(product,'dist/src/summary/jsonl'));
  const Staging=require(join(product,'dist/src/summary/staging')).SummaryStaging;
  const aggregate=optional(product,'memoryAggregate');
  const read=reader.readJsonl,prepare=Staging.prototype.prepareSummaries,store=db.replaceSessions,memoryStore=db.replaceMemory;
  const merge=aggregate?.aggregateMemory,exec=db.connection.exec,sqlPrepare=db.connection.prepare;
  const Session=require(join(product,'dist/src/summary/db/connection')).SqliteSession;
  const statement=Session.prototype.statement, wrappedRuns=new Map();
  const counters={parseAndStageMs:0,readerMs:0,prepareMs:0,storeMs:0,memoryAggregateMs:0,rows:0,
    aggregateInputFiles:0,aggregateInputDtos:0,aggregateOutputRequests:0,tempStatements:0,eventInsertRows:0,sqlInsertRuns:0,sqlUpdateRuns:0,sqlDeleteRuns:0,
    sampledRssBytes:0,sampledHeapBytes:0};
  const sample=()=>{const m=process.memoryUsage();counters.sampledRssBytes=Math.max(counters.sampledRssBytes,m.rss);
    counters.sampledHeapBytes=Math.max(counters.sampledHeapBytes,m.heapUsed);};
  reader.readJsonl=async function(path,size,onRow,options={}){const start=performance.now();
    try{return await read(path,size,(row,offset)=>{counters.rows++;return onRow(row,offset);},{...options,processBatch:parse=>{
      const began=performance.now();try{if(options.processBatch)options.processBatch(parse);else parse();}
      finally{counters.parseAndStageMs+=performance.now()-began;if(profile)sample();}}});}
    finally{counters.readerMs+=performance.now()-start;}};
  Staging.prototype.prepareSummaries=function(...args){const start=performance.now();try{return prepare.apply(this,args);}
    finally{counters.prepareMs+=performance.now()-start;}};
  db.replaceSessions=function(...args){const start=performance.now();try{return store.apply(this,args);}
    finally{counters.storeMs+=performance.now()-start;}};
  if(memoryStore)db.replaceMemory=function(...args){const start=performance.now();try{return memoryStore.apply(this,args);}
    finally{counters.storeMs+=performance.now()-start;if(profile)sample();}};
  if(aggregate)aggregate.aggregateMemory=function(...args){const start=performance.now();
    counters.aggregateInputFiles+=args[0].length;counters.aggregateInputDtos+=args[0].reduce((n,f)=>n+f.events.length,0);
    try{const result=merge.apply(this,args);counters.aggregateOutputRequests+=result.summaries.length;return result;}
    finally{counters.memoryAggregateMs+=performance.now()-start;if(profile)sample();}};
  db.connection.exec=function(sql){if(/CREATE\s+(?:TEMP|TEMPORARY)\s+(?:TABLE|INDEX)/i.test(sql))counters.tempStatements++;
    return exec.call(this,sql);};
  db.connection.prepare=function(sql){const statement=sqlPrepare.call(this,sql);
    if(profile && /INSERT INTO events\(/.test(sql)){const run=statement.run;statement.run=function(...args){counters.eventInsertRows++;return run.apply(this,args);};}
    return statement;};
  if(profile)Session.prototype.statement=function(sql){const result=statement.call(this,sql);
    if(/^(?:INSERT|UPDATE|DELETE)\b/i.test(sql.trim())&&!wrappedRuns.has(result)){
      const action=sql.trim().split(/\s/)[0].toLowerCase(),run=result.run;
      const counter=action==='insert'?'sqlInsertRuns':action==='update'?'sqlUpdateRuns':'sqlDeleteRuns';
      wrappedRuns.set(result,run);result.run=function(...args){counters[counter]++;return run.apply(this,args);};
    }return result;};
  return{counters,close(){Session.prototype.statement=statement;for(const [prepared,run]of wrappedRuns)prepared.run=run;if(profile)sample();reader.readJsonl=read;Staging.prototype.prepareSummaries=prepare;
    db.replaceSessions=store;if(memoryStore)db.replaceMemory=memoryStore;if(aggregate)aggregate.aggregateMemory=merge;
    db.connection.exec=exec;db.connection.prepare=sqlPrepare;}};
}

// Restore persistent data using the same connection; DTO cache ownership and data_version remain unchanged.
function restoreMain(db, seed) {
  const c = db.connection, before = c.prepare('PRAGMA main.data_version').get().data_version;
  c.prepare('ATTACH DATABASE ? AS cache_baseline').run(seed);
  c.exec('PRAGMA foreign_keys=OFF');
  try {
    const tables = c.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    c.exec('BEGIN IMMEDIATE');
    try {
      for (const {name} of tables) c.exec(`DELETE FROM main."${name.replaceAll('"', '""')}"`);
      for (const {name} of tables) {
        const table = `"${name.replaceAll('"', '""')}"`;
        c.exec(`INSERT INTO main.${table} SELECT * FROM cache_baseline.${table}`);
      }
      c.exec('COMMIT');
    } catch (error) { c.exec('ROLLBACK'); throw error; }
  } finally { c.exec('PRAGMA foreign_keys=ON'); c.exec('DETACH DATABASE cache_baseline'); }
  assert.equal(c.prepare('PRAGMA main.data_version').get().data_version, before, 'Same-connection restore must preserve data_version');
  assert.deepEqual(c.prepare('PRAGMA foreign_key_check').all(), []);
}

async function worker(configPath, variant, pair, work, profileText) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')), product = config.products[variant], profile = profileText === 'profile';
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const { buildUsageQuery } = require(join(product, 'dist/src/summary/db/queries'));
  await mkdir(work, { recursive: true });
  const path = join(work, 'summary.sqlite'), seed = join(work, 'baseline.sqlite'), samples = [], reads = {};
  if(variant==='M')await copyFile(config.seed,path);
  let db = new SummaryDatabase(path), coldReopen;
  const measure = async (scenario, cold = false) => {
    let target, added = 0, appendedBytes = 0;
    try {
      if (scenario.includes('-')) {
        const [provider, count] = scenario.split('-'); added = Number(count);
        target = helpers.chooseTarget(db, provider, config.directory);
        const originalStat=fs.statSync(target.path);
        target.originalAtimeMs=originalStat.atimeMs;target.originalMtimeMs=originalStat.mtimeMs;
        if (provider === 'codex') await helpers.inspectCodexTarget(target, product);
        const project = db.connection.prepare('SELECT project_key FROM turn_summary WHERE provider=? AND session_id=? LIMIT 1')
          .get(provider, target.session_id).project_key, rows = [];
        for (let index = 0; index < added; index++) {
          const key = `benchmark-jsonl-${scenario}-${index}`;
          if (provider === 'codex') rows.push(...helpers.codexAppendRows(target, key, key + '-response'));
          else { const request = helpers.claudeRows(target.session_id); request[0].cwd = project;
            request[0].promptId = request[1].promptId = key; request[1].message.id = key + '-message';
            request[1].requestId = key + '-response'; rows.push(...request); }
        }
        await helpers.appendRows(target, rows, config.directory, 1);
        appendedBytes = fs.statSync(target.path).size - target.originalBytes;
      }
      const probe = instrument(product, db, profile), memoryBefore = process.memoryUsage(), start = performance.now();
      let refreshed, refreshMs;
      try { refreshed = await refreshSummary(db, { dbPath: path, roots: config.roots }); refreshMs = performance.now() - start; }
      finally { probe.close(); }
      const memoryAfter = process.memoryUsage(), processHighWaterRssBytes = process.resourceUsage().maxRSS * 1024;
      assert.equal(refreshed.interrupted, false); assert.equal(refreshed.error, undefined); assert.equal(refreshed.failed, config.seedFailures);
      const totals = db.connection.prepare('SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens FROM turn_summary').get();
      assert.deepEqual([totals.requests, totals.tokens], [config.requests + added, config.tokens + added * 130]);
      if (scenario === 'unchanged') assert.equal(refreshed.bodyBytes, 0);
      if (target) assert.ok(refreshed.bodyBytes >= target.originalBytes, 'Changed file must still be read from its start');
      const checked = helpers.verify(db, buildUsageQuery), independent = {};
      for (const group of groups) independent[group] = independentCheck(db, config.filter, group, allUsage(db, group, config.filter));
      const metadataSha256 = sha(JSON.stringify(db.connection.prepare(`SELECT provider,session_id,root_id,signature
        FROM turn_metadata ORDER BY provider,session_id,root_id`).all()));
      const dependencySha256 = sha(JSON.stringify(db.connection.prepare(`SELECT * FROM turn_metadata_dependencies
        ORDER BY provider,session_id,root_id,dependency`).all()));
      if(variant!=='A')assert.equal(probe.counters.tempStatements,0,'Memory refresh must not create TEMP staging');
      const sample = { scenario, refreshMs, ...probe.counters, ...totals, parsed: refreshed.parsed, failed: refreshed.failed,
        bodyBytes: refreshed.bodyBytes, targetBytesBefore: target?.originalBytes, targetRequestsBefore: target?.requests, appendedBytes,
        memoryBefore, memoryAfter, processHighWaterRssBytes, ...checked, metadataSha256, dependencySha256, independent };
      process.send({ kind: 'progress', variant, pair, profile, cold, scenario, ms: refreshMs, parsed: refreshed.parsed,
        aggregateDtos: probe.counters.aggregateInputDtos });
      return sample;
    } finally {
      if (target) { await truncate(target.path, target.originalBytes); await utimes(target.path, target.originalAtimeMs/1000, target.originalMtimeMs/1000); }
    }
  };
  try {
    for (const scenario of scenarios) {
      if (scenario !== 'initial') {
        const restored=await refreshSummary(db,{dbPath:path,roots:config.roots});
        assert.equal(restored.failed,config.seedFailures);assert.equal(restored.interrupted,false);
        restoreMain(db, seed);
      }
      samples.push(await measure(scenario));
      if (scenario === 'initial') {
        if (!profile) for (const group of groups) {
          for (let n = 0; n < 3; n++) allUsage(db, group, config.filter);
          const times = [];
          for (let n = 0; n < 10; n++) { const began = performance.now(); allUsage(db, group, config.filter); times.push(performance.now() - began); }
          reads[group] = stats(times);
        }
        db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)'); await copyFile(path, seed);
      }
    }
    const restored=await refreshSummary(db,{dbPath:path,roots:config.roots});assert.equal(restored.failed,config.seedFailures);
    restoreMain(db, seed); db.close(); db = new SummaryDatabase(path);
    coldReopen = await measure('codex-1', true);
    const warm = samples.find(sample => sample.scenario === 'codex-1');
    for (const key of equalityKeys) assert.equal(canonical(coldReopen[key]), canonical(warm[key]), `Cold/warm ${key}`);
  } finally { db.close(); }
  process.send({ kind: 'result', samples, reads, coldReopen });
}

async function run(configPath, variant, pair, work, profile = false) {
  assert.ok(resolve(work).toLowerCase().startsWith(dirname(resolve(configPath)).toLowerCase() + sep), 'Trial must stay inside the frozen dataset');
  try { return await new Promise((done, fail) => {
    const child = fork(__filename, ['--worker', configPath, variant, String(pair), work, profile ? 'profile' : 'timed'],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let result, error = '';
    child.stderr.on('data', value => { error += value; });
    child.on('message', message => {
      if (message.kind === 'result') result = message;
      else if (message.kind === 'failure') error += message.message;
      else if (message.kind === 'progress') console.log(`${message.cold ? 'cold' : profile ? 'profile' : pair < 0 ? 'warmup' : 'pair'} ${pair}/${variant}/${message.scenario}: ${message.ms.toFixed(2)}ms, parsed=${message.parsed}, DTOs=${message.aggregateDtos}`);
    });
    child.on('error', fail);
    child.on('exit', code => code === 0 && result ? done(result) : fail(new Error(error.slice(-2500) || `Worker failed ${code}`)));
  }); } finally { await fs.promises.rm(work, { recursive: true, force: true }); }
}

async function copyCurrentSnapshot(directory, manifest) {
  const source=JSON.parse(fs.readFileSync(manifest,'utf8')),homes=new Map(),roots=[];
  for(const [index,root]of source.roots.entries()){
    const target=join(directory,'snapshot',`root-${index}`);
    await cp(root.path,target,{recursive:true,preserveTimestamps:true});
    let dataHome;
    if(root.dataHome){
      if(!homes.has(root.dataHome)){
        const home=join(directory,'snapshot',`home-${index}`);
        await cp(root.dataHome,home,{recursive:true,preserveTimestamps:true});homes.set(root.dataHome,home);
      }
      dataHome=homes.get(root.dataHome);
    }
    roots.push({provider:root.provider,path:target,...(dataHome?{dataHome}:{})});
  }
  const files=source.files.map(file=>{
    const index=source.roots.findIndex(root=>resolve(file.path).toLowerCase().startsWith(resolve(root.path).toLowerCase()+sep));
    assert(index>=0,'Frozen source file must belong to a snapshot root');
    const target=join(roots[index].path,relative(source.roots[index].path,file.path));
    assert.equal(sha(fs.readFileSync(target)),file.sha256);assert.equal(fs.statSync(target).size,file.bytes);
    return{...file,path:target};
  });
  return{roots,inventory:source.inventory,files,sha256:source.sha256,expected:source.expected};
}

async function prepare(directory, spec, before, currentSnapshot) {
  await mkdir(directory, { recursive: true });
  const snapshot = spec.real && currentSnapshot ? await copyCurrentSnapshot(directory,currentSnapshot) : await helpers.makeSnapshot(directory, { ...spec, after: before });
  const { SummaryDatabase } = require(join(before, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(before, 'dist/src/summary/scanner'));
  if (spec.multiSource) {
    const builder = join(directory, 'multi-source-builder.sqlite'), db = new SummaryDatabase(builder);
    let target;
    try { const result = await refreshSummary(db, { dbPath: builder, roots: snapshot.roots });
      assert.equal(result.failed, 0); target = helpers.chooseTarget(db, 'codex', directory); }
    finally { db.close(); }
    assert.ok(!target.path.endsWith('.zst'), 'Synthetic sibling uses plain JSONL');
    const sibling = join(dirname(target.path), 'zz-cache-sibling-' + basename(target.path));
    await copyFile(target.path, sibling);
    const row = JSON.stringify({ type: 'benchmark_progress', payload: { padding: 'x'.repeat(1024) } }) + '\n';
    await appendFile(sibling, row.repeat(Math.ceil(16 * 1024 * 1024 / Buffer.byteLength(row))));
    const bytes = fs.readFileSync(sibling);
    snapshot.files.push({ path: sibling, bytes: bytes.length, sha256: sha(bytes) });
    const inventory = snapshot.inventory.find(entry => entry.provider === 'codex'); inventory.files++; inventory.bytes += bytes.length;
    snapshot.sha256 = sha(JSON.stringify(snapshot.files.map(file => [relative(directory, file.path).replaceAll('\\', '/'), file.bytes, file.sha256])));
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(builder + suffix)) await unlink(builder + suffix);
  }
  const seed = join(directory, 'seed.sqlite'), db = new SummaryDatabase(seed);
  try {
    const result = await refreshSummary(db, { dbPath: seed, roots: snapshot.roots });
    assert.equal(result.interrupted, false); assert.equal(result.error, undefined);
    const totals = db.connection.prepare('SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens FROM turn_summary').get();
    if (snapshot.expected) assert.deepEqual([totals.requests, totals.tokens], [snapshot.expected.requests, snapshot.expected.tokens]);
    const bounds = db.connection.prepare('SELECT min(started_at_ms) lo,max(started_at_ms) hi FROM turn_summary').get();
    db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { ...snapshot, ...totals, seed, seedFailures: result.failed,
      filter: { fromMs: Math.floor(bounds.lo / 86400000) * 86400000 - 86400000,
        toMs: Math.ceil(bounds.hi / 86400000) * 86400000 + 86400000, unknownTime: 'include', excludeEmptyUsage: true } };
  } finally { db.close(); }
}

function compare(a, b, label) {
  for (const scenario of scenarios) {
    const left = a.samples.find(sample => sample.scenario === scenario), right = b.samples.find(sample => sample.scenario === scenario);
    for (const key of equalityKeys) assert.equal(canonical(left[key]), canonical(right[key]), `${label}/${scenario}/${key}`);
  }
  for (const key of equalityKeys) assert.equal(canonical(a.coldReopen[key]), canonical(b.coldReopen[key]), `${label}/cold-reopen/${key}`);
}

async function main() {
  const options = { before: '', after: '', output: '', workspace: '', currentSnapshot: '', smoke: false, syntheticOnly: false, currentOnly: false, multiSource: false };
  for (const arg of process.argv.slice(2)) {
    const match = /^--(before|after|output|workspace|current-snapshot)=(.+)$/.exec(arg);
    if (match) options[match[1]==='current-snapshot'?'currentSnapshot':match[1]] = resolve(match[2]);
    else if (arg === '--smoke') options.smoke = true;
    else if (arg === '--synthetic-only') options.syntheticOnly = true;
    else if (arg === '--current-only') options.currentOnly = true;
    else if (arg === '--multi-source') options.multiSource = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  assert.ok(options.before && options.after && options.output); assert.ok(!fs.existsSync(options.output));
  const cache = join(root, 'tests/.cache'); await mkdir(cache, { recursive: true });
  const directory = options.workspace || await mkdtemp(join(cache, 'memory-refresh-')); await mkdir(directory, { recursive: true });
  const products = { A: options.before, B: options.after, M: options.after }, warmups = options.smoke ? 0 : 3, pairs = options.smoke ? 1 : 10;
  const report = { startedAtSeoul: seoul(), pairs, warmups, runnerSha256: sha(fs.readFileSync(__filename)), helperSha256:Object.fromEntries(['incremental-refresh.cjs','temp-batch-ab.cjs'].map(name=>[name,sha(fs.readFileSync(join(__dirname,name)))])),
    environment: { node: process.version, cpu: cpus()[0]?.model, platform: process.platform, timezone: 'Asia/Seoul' },
    sources: Object.fromEntries(Object.entries(products).map(([variant, product]) => [variant, fingerprints(product, 'src')])),
    builds: Object.fromEntries(Object.entries(products).map(([variant, product]) => [variant, fingerprints(product, 'dist/src')])),
    method: {
      order: 'Three warmup pairs excluded, then ten AB/BA alternating pairs; smoke uses one pair without warmup',
      lifecycle: 'One DB connection per variant/pair: cold initial fill, then same-connection unchanged and independent append samples',
      restoration: 'After initial fill, checkpoint and copy DB seed; source tail/mtime restored after each sample; before next scenario an unmeasured refresh accepts restored DTO state, then persistent main tables restored from ATTACH seed on same connection; all restoration excluded from timing',
      cache: 'A is frozen original SQL TEMP; B retains per-file source DTO snapshots on its DB connection. File-level incremental: changed files reread from start, unchanged related sources reuse accepted DTOs; cold reopen rebuilds required sources; OS cache warm, no forced GC',
      refresh: 'refreshSummary including required session COMMIT, excludes DB open, source preparation, restore and correctness checks',
      nestedClocks: 'reader includes processBatch; SQL prepare and memory aggregation are alternative paths, final store follows; do not add nested reader/parse clocks',
      counters: 'Actual read rows/bytes and aggregate input DTO references; TEMP schema statements counted during refresh, B must be zero; retained cache heap sampled only in diagnostic runs',
      memory: 'memoryAfter includes retained source cache; process high-water includes earlier scenarios, query validation and restore; diagnostic batch samples can miss transient peaks',
      queries: 'All pages of day/month/session/project APIs after initial fill, three warmups plus ten timed calls per sample; completed-request average denominator unchanged',
      migration: 'One separate M run of B on the original SQL seed; initial label is an unchanged seed acceptance check, then five independent updates plus cold reopen; strict facts/aggregate checks, excluded from timing summaries',
      coldReopen: 'One extra codex-1 refresh per variant/pair after seed restore and DB close/reopen; correctness and cold-cache diagnostic, excluded from warm timing summaries',
      inputs: 'Only frozen snapshot copies are appended; raw source paths/content excluded from published report; full file hashes checked before/after dataset',
    }, datasets: [] };
  const specs = options.multiSource ? [{ name: 'synthetic-10000-multi-source', requests: 10000, 'turns-per-session': 100, multiSource: true }]
    : options.currentOnly ? [{ name: 'current', real: true }]
      : options.smoke ? [{ name: 'synthetic-100', requests: 100, 'turns-per-session': 10 }]
        : [...(options.syntheticOnly ? [] : [{ name: 'current', real: true }]),
          { name: 'synthetic-10000', requests: 10000, 'turns-per-session': 100 }, { name: 'synthetic-100', requests: 100, 'turns-per-session': 10 }];
  for (const spec of specs) {
    const data = join(directory, spec.name), manifest = join(data, 'snapshot.json');
    const snapshot = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : await prepare(data, spec, products.A, options.currentSnapshot);
    if (!fs.existsSync(manifest)) await writeFile(manifest, JSON.stringify(snapshot));
    snapshot.filter.fromMs = Math.min(snapshot.filter.fromMs, Date.UTC(2026, 9, 27));
    snapshot.filter.toMs = Math.max(snapshot.filter.toMs, Date.UTC(2026, 9, 30));
    for (const file of snapshot.files) assert.equal(sha(fs.readFileSync(file.path)), file.sha256);
    const configPath = join(data, 'memory-config.json'); await writeFile(configPath, JSON.stringify({ ...snapshot, products, directory }));
    const entry = { name: spec.name, requests: snapshot.requests, tokens: snapshot.tokens, seedFailures: snapshot.seedFailures,
      inventory: snapshot.inventory, inputSha256: snapshot.sha256, expected: snapshot.expected, filter: snapshot.filter,
      generator: spec.real ? undefined : 'ordinal-v1; alternating providers; ten projects; fourteen days; fixed requests per session',
      ...(spec.multiSource ? { multiSource: 'One Codex source duplicated under lexically later sibling path plus 16 MiB ignored progress rows; same 10,000 logical requests; append chooses original source' } : {}), trials: [] };
    console.log(`${spec.name}: ${snapshot.requests} requests, ${snapshot.files.length} files, ${snapshot.inventory.reduce((sum, item) => sum + item.bytes, 0)} bytes`);
    for (let pair = -warmups; pair < pairs; pair++) {
      const both = {}, order = Math.abs(pair) % 2 ? ['B', 'A'] : ['A', 'B'];
      for (const variant of order) both[variant] = await run(configPath, variant, pair, join(data, `source-cache-run-${Date.now()}-${pair}-${variant}`));
      compare(both.A, both.B, `${spec.name}/${pair}`);
      if (pair >= 0) entry.trials.push(...order.map(variant => ({ variant, pair, ...both[variant] })));
    }
    entry.profiles = {};
    if (!options.smoke) {
      for (const variant of ['A', 'B']) entry.profiles[variant] = await run(configPath, variant, 'diagnostic', join(data, `source-cache-profile-${Date.now()}-${variant}`), true);
      compare(entry.profiles.A, entry.profiles.B, `${spec.name}/diagnostic`);
    }
    entry.verification={M:await run(configPath,'M','migration',join(data,`memory-migration-${Date.now()}`))};
    compare(entry.trials.find(t=>t.variant==='A'),entry.verification.M,`${spec.name}/SQLseed-migration`);
    compare(entry.trials.find(t=>t.variant==='B'),entry.verification.M,`${spec.name}/Bseed-migration`);
    entry.summary = Object.fromEntries(scenarios.map(scenario => [scenario, Object.fromEntries(['A', 'B'].map(variant => {
      const rows = entry.trials.filter(trial => trial.variant === variant).flatMap(trial => trial.samples).filter(row => row.scenario === scenario);
      return [variant, Object.fromEntries(['refreshMs', 'parseAndStageMs', 'readerMs', 'prepareMs', 'storeMs', 'memoryAggregateMs', 'bodyBytes', 'parsed', 'aggregateInputFiles', 'aggregateInputDtos', 'aggregateOutputRequests', 'tempStatements', 'sqlInsertRuns', 'sqlUpdateRuns', 'sqlDeleteRuns', 'processHighWaterRssBytes']
        .map(key => [key, stats(rows.map(row => row[key]))]))];
    }))]));
    entry.readSummary = Object.fromEntries(groups.map(group => [group, Object.fromEntries(['A', 'B'].map(variant =>
      [variant, stats(entry.trials.filter(trial => trial.variant === variant).flatMap(trial => trial.reads[group].samplesMs))]))]));
    for (const file of snapshot.files) assert.equal(sha(fs.readFileSync(file.path)), file.sha256);
    entry.correctness = 'A/B requests, tokens, complete normalized facts, aggregate pages, independent JS group averages, cold/warm reopen, raw/rollup queries, FK/integrity and restored input hashes passed. Literal metadata/dependency hashes recorded but excluded: B recomputes complete affected aggregates instead of metadata dependency pruning.';
    report.datasets.push(entry); await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output + '.partial', JSON.stringify(report, null, 2) + '\n');
  }
  for(const [variant,product]of Object.entries(products)){
    assert.deepEqual(fingerprints(product,'src'),report.sources[variant],'Frozen source changed');
    assert.deepEqual(fingerprints(product,'dist/src'),report.builds[variant],'Frozen build changed');
  }
  report.completedAtSeoul = seoul(); await writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await unlink(options.output + '.partial'); console.log(`Saved ${options.output}`);
}

if (process.argv[2] === '--worker') worker(...process.argv.slice(3)).then(() => process.disconnect(), error => {
  process.send({ kind: 'failure', message: String(error.stack).slice(0, 2200) }); process.exitCode = 1; process.disconnect();
});
else main().catch(error => { console.error(error.stack); process.exitCode = 1; });
