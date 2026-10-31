// 월 경계만 보정한 추가 조회 실험. 최초 수집·증분 표본은 재사용하지 않는다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { join, resolve, dirname, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { DatabaseSync, backup } = require('node:sqlite');
const Module = require('node:module');
const { openDatabase } = require('./index-only-candidate.cjs');
const { sessionText, sha } = require('./index-only-fixtures.cjs');
const { SummaryStaging } = require('../../dist/src/summary/staging');
const { ClaudeParserAdapter, CodexCurrentParserAdapter } = require('../../dist/src/summary/parsers');
const sourcePath = join(__dirname, 'index-only.cjs'), source = fs.readFileSync(sourcePath, 'utf8');
const patch = "monthEnd = require('../../dist/src/summary/db/timezone').periodBounds(month, timezone).toMs";
assert.ok(source.includes('monthEnd = next.getTime()'));
const corrected = source.replace('monthEnd = next.getTime()', patch)
  .replace('[...specs(dbs.A), ...extraSpecs]', "[...specs(dbs.A).filter(s => s.period === 'month'), ...extraSpecs]");
const loaded = new Module(sourcePath, module); loaded.filename = sourcePath; loaded.paths = Module._nodeModulePaths(__dirname);
loaded._compile(corrected + '\nObject.assign(module.exports,{readBench,inventory,integrity,oracleFacts,specs});', sourcePath);
const h = loaded.exports;

function loadSynthetic(db, projects, perProject, longTurns) {
  const c = db.connection, staging = new SummaryStaging(c), sessions = projects * perProject;
  const insert = c.prepare('INSERT INTO manifest(provider,source_root,path,recorded_at) VALUES(?,?,?,?)');
  try {
    db.transaction(() => {
      for (let ordinal = 0; ordinal < sessions; ordinal++) {
        const p = Math.floor(ordinal / perProject), s = ordinal % perProject, provider = (p + s) % 2 ? 'codex' : 'claude';
        const root = `/fixture/${provider}`, path = `${root}/${ordinal}.jsonl`;
        const record = { provider, session: `fixture-${p}-${s}`, project: `/benchmark/project-${p}`, ordinal };
        const text = sessionText(record, ordinal ? 1 : longTurns).text;
        const id = Number(insert.run(provider, root, path, '2026-10-31T00:00:00Z').lastInsertRowid);
        staging.addFile({ id, provider, source_root: root, path, session_id: null, size_bytes: Buffer.byteLength(text),
          mtime_ms: 1790812800000, dev: null, inode: null, parser_version: 14, capabilities_collected: 1 }, null, true);
        const sink = { identity: value => staging.identity(id, value), event: value => staging.event(id, value) };
        const Parser = provider === 'claude' ? ClaudeParserAdapter : CodexCurrentParserAdapter;
        const parser = new Parser({ provider, path, sourceRoot: root, fileId: id, collectCapabilities: true }, sink);
        let offset = 0;
        for (const line of text.trimEnd().split('\n')) {
          const row = JSON.parse(line), root = value => typeof value === 'string' && value.startsWith('request-') ? `${record.session}:${value}` : value;
          // 일괄 정규화에서 다른 세션의 동명 root를 찾지 않도록 일대일로 재명명한다.
          if (row.promptId) row.promptId = root(row.promptId);
          if (row.payload?.turn_id) row.payload.turn_id = root(row.payload.turn_id);
          if (row.payload?.root_turn_id) row.payload.root_turn_id = root(row.payload.root_turn_id);
          parser.row(row, offset); offset += Buffer.byteLength(line) + 1;
        }
        parser.finish();
      }
      c.exec('INSERT INTO component SELECT DISTINCT provider,session_id FROM scan_files');
      staging.prepareSummaries();
    });
    db.replaceSessions({ sessions: staging.componentSessions(), summaries: staging.summaries(), files: staging.files('1=1') });
  } finally { staging.close(); }
}

module.exports = { loadSynthetic };

async function main() {
  const options = { result: '', workspace: '', output: '', smoke: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--smoke') options.smoke = true;
    else {
      const match = /^--(result|workspace|output)=(.+)$/.exec(arg);
      assert.ok(match, 'Unknown option'); options[match[1]] = resolve(match[2]);
    }
  }
  assert.ok(options.output && !fs.existsSync(options.output), 'Use a new output path');
  const original = options.result ? JSON.parse(fs.readFileSync(options.result, 'utf8')) : null;
  assert.ok(options.smoke || original?.completedSeoul, 'Finish the focused experiment first');
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-index-month-'));
  const report = { originalReport: original ? basename(options.result) : null,
    originalReportSha256: original ? sha(fs.readFileSync(options.result)) : null, sourceSha256: sha(source),
    runnerSha256: sha(fs.readFileSync(__filename)), sourcePatch: patch,
    method: 'Correct full calendar month via product periodBounds. Actual old real/small A snapshot copied read-only; synthetic large/long parser output normalized in one batch for query-only replay. Synthetic root IDs bijectively prefixed with session ID to avoid cross-session title scans during bulk preparation; queried provider/session/model/time/token values unchanged. This preparation is not product W1. Same fact snapshot copied to A/B; correctness oracle and 9 query batches as before.', datasets: [] };
  try {
    const definitions = options.smoke ? [['smoke', 3, 10, 1], ['smoke-long', 3, 10, 1000]] : [
      ['real-365'], ['small-300'], ['small-500'], ['large-100x100', 100, 100, 1],
      ['small-long-1000', 10, 30, 1000], ['large-long-1000', 100, 100, 1000],
    ];
    for (const [name, projects, perProject, longTurns] of definitions) {
      const aPath = join(directory, `${name}-A.sqlite`), bPath = join(directory, `${name}-B.sqlite`);
      let a, b;
      try {
      if (projects === undefined) {
        const input = new DatabaseSync(join(options.workspace, `${name}-A.sqlite`), { readOnly: true });
        try { await backup(input, aPath); } finally { input.close(); }
        a = openDatabase(aPath, 'A');
      } else { a = openDatabase(aPath, 'A'); loadSynthetic(a, projects, perProject, longTurns); }
      a.queryUsagePage({}, 'month', 'Asia/Seoul', { limit: 100 }, 'model');
      await backup(a.connection, bPath); b = openDatabase(bPath, 'B');
        const counts = h.inventory(a), old = original?.datasets.find(d => d.name === name);
        if (old) for (const key of ['requests', 'sessions', 'projects', 'models', 'tokens']) assert.equal(counts[key], old.counts[key], `${name}/${key}`);
        if (old) {
          const facts = h.oracleFacts(a);
          for (const spec of h.specs(a).filter(s => s.period === 'all')) {
            const rows = h.oracle(facts, spec), prior = old.reads.find(q => q.id === spec.id && q.period === 'all');
            assert.equal(rows.length, prior.groups);
            assert.equal(rows.reduce((n, r) => n + r.total_tokens, 0), prior.correctnessTotals.tokensAllStatuses);
          }
        }
        h.integrity(a); h.integrity(b);
        const reads = h.readBench({ A: a, B: b }, { readSamples: options.smoke ? 3 : 9 });
        assert.equal(reads.length, 3); report.datasets.push({ name, preparation: projects === undefined ? 'read-only SQLite backup of frozen original A' : 'actual synthetic parsers + one normalization/replacement batch; query-only replay', counts, reads });
        console.log(`Correct full month passed: ${name}`);
      } finally { a?.close(); b?.close(); }
    }
    const edge = {};
    for (const v of ['A', 'B']) {
      edge[v] = openDatabase(join(directory, `boundary-${v}.sqlite`), v);
      const rows = ['claude', 'codex'].flatMap(provider => [Date.parse('2025-12-31T14:59:59.999Z'),
        Date.parse('2025-12-31T15:00:00Z'), Date.parse('2026-01-31T15:00:00Z'), null, Date.parse('2026-01-15T03:00:00Z')].map((started, i) => {
        const input = [20, 30, 40, 0, 5][i], output = [2, 3, 4, 0, 0][i];
        const model = (name, input, output) => ({ model: name, input_tokens: input, output_tokens: output, cache_read_input_tokens: i ? 0 : null, cache_write_input_tokens: 0 });
        return { provider, project_key: '/edge', project_name: 'edge', session_id: 'shared-session', root_turn_id: `root-${i}`,
          started_at_ms: started, completed_at_ms: started == null ? null : started + 1000, duration_ms: i < 3 ? 1000 : null,
          duration_quality: i < 3 ? 'exact' : 'missing', input_tokens: input, output_tokens: output, total_tokens: input + output,
          cache_read_input_tokens: i ? 0 : null, cache_write_input_tokens: 0, status: i === 3 ? 'failed' : i === 4 ? 'in_progress' : 'completed',
          model_usage: i === 1 ? [model('shared-model', 20, 2), model('other-model', 10, 1)] : i === 3 ? [] : [model(i === 4 ? '' : 'shared-model', input, output)] };
      }));
      edge[v].replaceSessions({ sessions: ['claude', 'codex'].map(provider => ({ provider, session_id: 'shared-session' })), summaries: rows, files: [] });
      edge[v].queryUsagePage({}, 'month', 'Asia/Seoul', { limit: 100 }, 'model');
    }
    try {
      const start = Date.parse('2025-12-31T15:00:00Z'), end = Date.parse('2026-01-31T15:00:00Z');
      const extra = ['Q1', 'Q2', 'Q3'].flatMap(id => [
        { id, group: id === 'Q1' ? 'day' : 'month', period: 'exact-year-start', filter: { fromMs: start, toMs: start + 1, unknownTime: 'exclude', excludeEmptyUsage: true, ...(id === 'Q1' ? {} : { projectKey: '/edge' }) } },
        { id, group: id === 'Q1' ? 'day' : 'month', period: 'exact-calendar-month', filter: { fromMs: start, toMs: end, unknownTime: 'exclude', excludeEmptyUsage: true, ...(id === 'Q1' ? {} : { projectKey: '/edge' }) } },
        { id, group: id === 'Q1' ? 'day' : 'month', period: 'empty-project', filter: { projectKey: '/missing-project', excludeEmptyUsage: true, unknownTime: 'exclude' } },
      ]);
      h.integrity(edge.A); h.integrity(edge.B);
      report.boundaryFixture = { counts: h.inventory(edge.A), cases: 'Same session and model names across providers, two models/request, Dec/Jan boundary, exact inclusive start/exclusive end, NULL cache/time, empty project, completed/in-progress/failed.',
        reads: h.readBench(edge, { readSamples: options.smoke ? 3 : 9 }, extra) };
      assert.equal(report.boundaryFixture.counts.requests, 10); assert.equal(report.boundaryFixture.counts.tokens, 208);
      for (const read of report.boundaryFixture.reads) {
        if (read.period === 'month') { assert.equal(read.groups, 2); assert.equal(read.correctnessTotals.tokensAllStatuses, 44); }
        if (read.period === 'exact-year-start') { assert.equal(read.groups, 4); assert.equal(read.correctnessTotals.tokensAllStatuses, 66); }
        if (read.period === 'exact-calendar-month') { assert.equal(read.groups, 6); assert.equal(read.correctnessTotals.tokensAllStatuses, 76); assert.equal(read.correctnessTotals.completedModelRequestDenominator, 4); }
      }
    } finally { edge.A.close(); edge.B.close(); }
    await writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('agent-tracker-index-month-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
