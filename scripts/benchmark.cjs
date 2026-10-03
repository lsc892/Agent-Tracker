const { mkdtemp, mkdir, open, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { SummaryClient } = require('../dist/src/summary/client');

const files = Math.max(1, Math.min(10000, Number(process.env.BENCHMARK_FILES) || 300));
const turns = Math.max(1, Math.min(100000, Number(process.env.BENCHMARK_TURNS) || 2000));
const rows = (session, index) => {
  const timestamp = new Date(Date.UTC(2026, 0, 1) + index * 2000).toISOString();
  return JSON.stringify({ type: 'user', sessionId: session, promptId: `${session}-${index}`, timestamp, cwd: '/fixture/project', message: { content: 'synthetic' } }) + '\n' +
    JSON.stringify({ type: 'assistant', sessionId: session, timestamp, requestId: `request-${index}`, message: { id: `message-${index}`, stop_reason: 'end_turn', usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 50 } } }) + '\n';
};

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-benchmark-'));
  const source = join(directory, 'source');
  await mkdir(source);
  let client;
  let sample;
  let peakRss = process.memoryUsage().rss;
  const results = [];
  try {
    for (let index = 0; index < files; index++) await writeFile(join(source, `small-${index}.jsonl`), rows(`small-${index}`, 0));
    const handle = await open(join(source, 'large.jsonl'), 'w');
    try { for (let index = 0; index < turns; index++) await handle.write(rows('large', index)); }
    finally { await handle.close(); }
    client = new SummaryClient({ dbPath: join(directory, 'benchmark.sqlite'), roots: [{ provider: 'claude', path: source }], timezone: 'Asia/Seoul' });
    let phase;
    client.subscribe(progress => {
      if (progress.phase !== phase) { phase = progress.phase; console.log(`${phase}: ${progress.discovered} files, ${progress.parsed} parsed`); }
    });
    sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
    await client.initialize();
    for (const scenario of ['initial', 'unchanged', 'append']) {
      if (scenario === 'append') { const file = await open(join(source, 'large.jsonl'), 'a'); try { await file.write(rows('large', turns)); } finally { await file.close(); } }
      const start = performance.now();
      const result = await client.refresh();
      const elapsedMs = performance.now() - start;
      const query = await client.query({ groupBy: 'all' });
      const expected = (files + turns + (scenario === 'append' ? 1 : 0)) * 350;
      if (result.failed || query.rows[0]?.total_tokens !== expected) throw new Error(`Benchmark accuracy failed: ${scenario}`);
      if (scenario === 'unchanged' && result.bodyBytes !== 0) throw new Error('Unchanged refresh read transcript bodies');
      results.push({ scenario, elapsedMs, ...result, totalTokens: query.rows[0].total_tokens });
    }
    const report = { node: process.version, platform: process.platform, fileCount: files + 1, largeSessionTurns: turns, combinedHostWorkerPeakRssBytes: peakRss, sampledEveryMs: 10, results };
    const output = resolve(__dirname, '..', 'benchmark-results');
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'summary.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (sample) clearInterval(sample);
    await client?.dispose();
    // directory is the exact mkdtemp result, never a configured source directory.
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
