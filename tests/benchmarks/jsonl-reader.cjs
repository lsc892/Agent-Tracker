const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFile, writeFile, mkdir, readdir, lstat, open } = require('node:fs/promises');
const { join, resolve, dirname, relative } = require('node:path');
const { performance } = require('node:perf_hooks');

const root = resolve(__dirname, '../..');
const cache = join(root, 'tests/.cache/jsonl-reader');
const manifestPath = join(cache, 'manifest.json');
const currentModule = join(root, 'dist/src/summary/jsonl.js');
const baselineModule = join(cache, 'baseline.cjs');
const sha = data => createHash('sha256').update(data).digest('hex');
const seoulTime = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium',
}).format(new Date());

async function* filesIn(directory) {
  const stat = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) yield* filesIn(path);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) yield path;
  }
}

async function freezeFile(source, target) {
  await mkdir(dirname(target), { recursive: true });
  const input = await open(source, 'r');
  let output;
  try {
    const before = await input.stat();
    output = await open(target, 'wx');
    const buffer = Buffer.allocUnsafe(64 * 1024), digest = createHash('sha256');
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      assert.ok(bytesRead > 0, 'Snapshot source truncated');
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, position + written);
        assert.ok(result.bytesWritten > 0); written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const after = await input.stat();
    assert.ok(after.size >= before.size && (after.size > before.size || after.mtimeMs === before.mtimeMs), 'Snapshot source rewritten');
    return { size: position, sha256: digest.digest('hex') };
  } finally { await output?.close(); await input.close(); }
}

function turn(session, index, padding) {
  const timestamp = new Date(Date.UTC(2026, 9, 9) + index * 2000).toISOString();
  return [
    { type: 'user', sessionId: session, promptId: `${session}-${index}`, timestamp, cwd: '/fixture/project', message: { content: '한글 😀 ' + 'x'.repeat(padding) } },
    { type: 'assistant', sessionId: session, promptId: `${session}-${index}`, timestamp, requestId: `request-${index}`, message: { id: `message-${index}`, model: 'claude-sonnet-4-6', stop_reason: 'end_turn', usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 50 } } },
  ].map(row => JSON.stringify(row) + '\n').join('');
}

async function synthetic(name, count, turns, padding, iterations = 1) {
  const directory = join(cache, name), files = [];
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < count; index++) {
    const path = join(directory, `session-${index}.jsonl`);
    const output = await open(path, 'wx'), digest = createHash('sha256');
    let size = 0;
    try {
      for (let row = 0; row < turns; row++) {
        const data = turn(`session-${index}`, row, padding);
        await output.write(data); digest.update(data); size += Buffer.byteLength(data);
      }
    } finally { await output.close(); }
    files.push({ path, size, sha256: digest.digest('hex'), provider: 'claude', sourceRoot: directory });
  }
  return { name, input: 'synthetic', files, iterations, expectedRows: count * turns * 2, expectedTokens: count * turns * 350 };
}

async function capture() {
  const ts = require('typescript');
  // Use a fresh directory; never overwrite a previous baseline or frozen input.
  await mkdir(dirname(cache), { recursive: true });
  await mkdir(cache, { recursive: false });
  const source = await readFile(join(root, 'src/summary/jsonl.ts'), 'utf8');
  await writeFile(join(cache, 'baseline.ts'), source);
  await writeFile(baselineModule, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText);
  const cases = [await synthetic('small', 2, 10, 256, 50), await synthetic('large', 200, 20, 4096)];
  const imageDirectory = join(cache, 'image');
  await mkdir(imageDirectory);
  const imagePath = join(imageDirectory, 'image.jsonl');
  const imageFile = await open(imagePath, 'wx'), imageHash = createHash('sha256');
  let imageSize = 0;
  try {
    for (const data of ['{"type":"user","image":"data:image/png;base64,', ...Array(512).fill('A'.repeat(64 * 1024)), '","usage":{"input_tokens":123}}\n{"type":"user","value":"한글"}\n']) {
      await imageFile.write(data); imageHash.update(data); imageSize += Buffer.byteLength(data);
    }
  } finally { await imageFile.close(); }
  cases.push({ name: 'image', input: 'synthetic', iterations: 1, maxLineBytes: 1024, expectedRows: 2,
    files: [{ path: imagePath, size: imageSize, sha256: imageHash.digest('hex'), provider: 'claude', sourceRoot: imageDirectory }] });
  if (process.argv.includes('--real')) {
    const { readConfiguration } = require('../../dist/src/configuration');
    const configuration = readConfiguration({ get: (_key, fallback) => fallback });
    const available = [];
    for (const [ordinal, entry] of configuration.roots.entries()) {
      for await (const path of filesIn(entry.path)) available.push({ path, provider: entry.provider, sourceRoot: entry.path, ordinal, size: (await lstat(path)).size });
    }
    available.sort((a, b) => a.size - b.size || a.path.localeCompare(b.path));
    const count = Math.min(200, available.length), selected = [];
    assert.ok(count, 'No real JSONL input');
    for (let index = 0; index < count; index++) {
      const original = available[Math.floor(index * (available.length - 1) / Math.max(1, count - 1))];
      const sourceRoot = join(cache, 'real', `root-${original.ordinal}`);
      const path = join(sourceRoot, relative(original.sourceRoot, original.path));
      selected.push({ path, sourceRoot, provider: original.provider, ...await freezeFile(original.path, path) });
    }
    cases.push({ name: 'real-200', input: 'real-frozen', iterations: 1, files: selected });
  }
  const manifest = { capturedAtSeoul: seoulTime(), baselineSourceSha256: sha(source), baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), cases };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const before = [];
  for (const entry of cases) {
    const result = await child({ variant: 'baseline', name: entry.name, mode: 'timing' });
    before.push({ name: entry.name, ...result });
    console.log(`Before implementation: ${entry.name}: ${result.elapsedMs.toFixed(2)} ms`);
  }
  await writeFile(join(cache, 'before.json'), JSON.stringify(before, null, 2));
}

async function runReader(entry, verify, measureMemory) {
  const { readJsonl } = require(currentModule);
  const { ClaudeParserAdapter, CodexCurrentParserAdapter } = require('../../dist/src/summary/parsers');
  const digest = verify ? createHash('sha256') : null;
  let rows = 0, events = 0, failed = 0, bytes = 0;
  const observedPeaks = { ...process.memoryUsage() };
  const sample = () => {
    const memory = process.memoryUsage();
    for (const key of Object.keys(observedPeaks)) observedPeaks[key] = Math.max(observedPeaks[key], memory[key]);
  };
  const iterations = verify || measureMemory ? 1 : entry.iterations;
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const [ordinal, file] of entry.files.entries()) {
      const sink = {
        identity(value) { digest?.update(JSON.stringify(['identity', value])); },
        event(value) { events++; digest?.update(JSON.stringify(['event', value])); },
      };
      const context = { provider: file.provider, path: file.path, sourceRoot: file.sourceRoot, fileId: ordinal, collectCapabilities: true };
      const Adapter = file.provider === 'claude' ? ClaudeParserAdapter : CodexCurrentParserAdapter;
      const adapter = new Adapter(context, sink);
      try {
        const result = await readJsonl(file.path, file.size, (row, offset) => {
          rows++; digest?.update(JSON.stringify(['row', offset, row]));
          adapter.row(row, offset);
          if (measureMemory && rows % 256 === 0) sample();
        }, { maxLineBytes: entry.maxLineBytes, onBytes(count) { bytes += count; if (measureMemory) sample(); },
          ...(measureMemory ? { processBatch(parse) { parse(); sample(); } } : {}) });
        if (result.rows) adapter.finish();
        digest?.update(JSON.stringify(['read', result, adapter.getIdentity()]));
      } catch (error) {
        failed++; digest?.update(JSON.stringify(['error', error.code ?? error.message, error.offset]));
      }
    }
  }
  if (entry.expectedRows !== undefined) assert.equal(rows, entry.expectedRows * iterations);
  assert.equal(failed, 0, 'Input failed reader/adapter validation');
  return { rows, events, failed, bytes, ...(verify ? { digest: digest.digest('hex') } : {}),
    ...(measureMemory ? { observedPeaks, endpoint: process.memoryUsage() } : {}) };
}

function outputDigest(connection) {
  const digest = createHash('sha256');
  for (const table of ['turn_summary', 'turn_model_usage', 'turn_costs', 'turn_capability_usage', 'sessions', 'projects']) {
    digest.update(table);
    const keys = connection.prepare(`PRAGMA table_info(${table})`).all().filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
    for (const raw of connection.prepare(`SELECT * FROM ${table} ORDER BY ${keys.join(',')}`).iterate()) {
      const value = { ...raw };
      for (const key of ['id', 'turn_id', 'updated_at', 'diagnostic_file_id']) delete value[key];
      digest.update(JSON.stringify(value));
    }
  }
  return digest.digest('hex');
}

async function runRefresh(entry) {
  const { SummaryDatabase } = require('../../dist/src/summary/db');
  const { refreshSummary } = require('../../dist/src/summary/scanner');
  const database = new SummaryDatabase(join(cache, `refresh-${process.pid}.sqlite`));
  const options = { dbPath: database.path ?? join(cache, `refresh-${process.pid}.sqlite`), roots: [{ provider: 'claude', path: entry.files[0].sourceRoot }], timezone: 'Asia/Seoul' };
  const results = [];
  let peakRssBytes = process.memoryUsage().rss;
  try {
    for (const scenario of ['initial', 'unchanged', 'append']) {
      if (scenario === 'append') {
        const source = entry.files[0], output = await open(source.path, 'a');
        try { await output.write(turn('session-0', 999999, 256)); } finally { await output.close(); }
      }
      let phase;
      const phases = {}, phaseCpuMs = {}, cpuStart = process.cpuUsage(), start = performance.now();
      let phaseStarted = start;
      let phaseCpuStarted = cpuStart;
      const result = await refreshSummary(database, options, undefined, progress => {
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
        if (phase !== progress.phase) {
          const now = performance.now(), cpu = process.cpuUsage();
          if (phase) {
            phases[phase] = (phases[phase] ?? 0) + now - phaseStarted;
            phaseCpuMs[phase] = (phaseCpuMs[phase] ?? 0) + (cpu.user + cpu.system - phaseCpuStarted.user - phaseCpuStarted.system) / 1000;
          }
          phase = progress.phase; phaseStarted = now;
          phaseCpuStarted = cpu;
        }
      });
      const elapsedMs = performance.now() - start;
      const cpu = process.cpuUsage(cpuStart), cpuMs = (cpu.user + cpu.system) / 1000;
      assert.equal(result.failed, 0);
      const tokens = database.connection.prepare('SELECT sum(total_tokens) AS tokens FROM turn_summary').get().tokens;
      assert.equal(tokens, entry.expectedTokens + (scenario === 'append' ? 350 : 0));
      if (scenario === 'unchanged') { assert.equal(result.bodyBytes, 0); assert.equal(result.parsed, 0); }
      if (scenario === 'initial') assert.equal(result.parsed, entry.files.length);
      if (scenario === 'append') { assert.equal(result.parsed, 1); assert.equal(result.reused, entry.files.length - 1); }
      results.push({ scenario, elapsedMs, cpuMs, phases, phaseCpuMs, bodyBytes: result.bodyBytes, parsed: result.parsed, reused: result.reused, tokens, digest: outputDigest(database.connection), sampledPeakRssBytes: peakRssBytes });
      if (scenario === 'append') {
        const source = entry.files[0], output = await open(source.path, 'r+');
        try { await output.truncate(source.size); } finally { await output.close(); }
      }
    }
  } finally { database.close(); }
  return { results };
}

async function worker(request) {
  if (request.variant === 'baseline') Object.assign(require(currentModule), require(baselineModule));
  require(currentModule);
  require('../../dist/src/summary/parsers');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entry = manifest.cases.find(value => value.name === request.name);
  const memoryBefore = process.memoryUsage();
  const start = performance.now();
  const result = request.mode === 'refresh' ? await runRefresh(entry) : await runReader(entry, request.mode === 'verify', request.mode === 'memory');
  const elapsedMs = performance.now() - start;
  return { elapsedMs, memoryBefore, ...result, nativeMaxRssKiB: process.resourceUsage().maxRSS };
}

function child(request) {
  return new Promise((accept, reject) => {
    const processChild = fork(__filename, ['--child'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });
    let response;
    processChild.on('message', value => { response = value; });
    processChild.on('error', reject);
    processChild.on('exit', code => code === 0 && response ? accept(response) : reject(new Error(`Benchmark child failed (${code})`)));
    processChild.send(request);
  });
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function compare() {
  const ts = require('typescript');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // Confirm the compiled candidate matches the source being reported.
  const currentSource = await readFile(join(root, 'src/summary/jsonl.ts'), 'utf8');
  assert.equal(await readFile(currentModule, 'utf8'), ts.transpileModule(currentSource, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, sourceMap: true,
  }, fileName: 'jsonl.ts' }).outputText);
  const cases = [];
  for (const entry of manifest.cases) {
    const correctness = {}, memory = {};
    for (const variant of ['baseline', 'candidate']) correctness[variant] = await child({ variant, name: entry.name, mode: 'verify' });
    assert.equal(correctness.baseline.digest, correctness.candidate.digest, `Result mismatch: ${entry.name}`);
    for (const variant of ['baseline', 'candidate']) memory[variant] = await child({ variant, name: entry.name, mode: 'memory' });
    // Untimed per-process warm-up is omitted deliberately: timings include first-use JIT in a new process.
    const runs = [];
    for (let pair = 0; pair < 3; pair++) {
      for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const result = await child({ variant, name: entry.name, mode: 'timing' });
        runs.push({ pair, variant, ...result });
        console.log(`${entry.name} pair ${pair + 1} ${variant}: ${result.elapsedMs.toFixed(2)} ms`);
      }
    }
    const baselineMs = median(runs.filter(run => run.variant === 'baseline').map(run => run.elapsedMs / entry.iterations));
    const candidateMs = median(runs.filter(run => run.variant === 'candidate').map(run => run.elapsedMs / entry.iterations));
    cases.push({ name: entry.name, input: entry.input, files: entry.files.length, bytes: entry.files.reduce((sum, file) => sum + file.size, 0),
      inputSha256: sha(JSON.stringify(entry.files.map(file => [file.provider, file.size, file.sha256]))), iterations: entry.iterations,
      baselineMs, candidateMs, speedup: baselineMs / candidateMs, improvementPercent: (baselineMs - candidateMs) / baselineMs * 100, correctness, memory, runs });
    await writeFile(join(cache, 'comparison-progress.json'), JSON.stringify({ cases }, null, 2));
  }
  const refresh = [];
  for (const name of ['small', 'large']) {
    const runs = [];
    for (let pair = 0; pair < 3; pair++) {
      for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const result = await child({ variant, name, mode: 'refresh' });
        runs.push({ pair, variant, ...result });
        console.log(`refresh ${name} pair ${pair + 1} ${variant}: ${result.results.map(row => `${row.scenario}=${row.elapsedMs.toFixed(1)}`).join(', ')} ms`);
      }
    }
    for (const scenario of ['initial', 'unchanged', 'append']) {
      const data = runs.map(run => ({ pair: run.pair, variant: run.variant, ...run.results.find(result => result.scenario === scenario) }));
      assert.equal(new Set(data.map(row => row.digest)).size, 1, `Full refresh mismatch: ${name}/${scenario}`);
    }
    refresh.push({ name, runs });
    await writeFile(join(cache, 'comparison-progress.json'), JSON.stringify({ cases, refresh }, null, 2));
  }
  const report = { recordedAtSeoul: seoulTime(), node: process.version, platform: process.platform, arch: process.arch,
    baselineCommit: manifest.baselineCommit, baselineSourceSha256: manifest.baselineSourceSha256, candidateSourceSha256: sha(currentSource),
    beforeImplementation: JSON.parse(await readFile(join(cache, 'before.json'), 'utf8')),
    method: 'Three sequential alternating pairs in fresh processes. Frozen input; filesystem cache warmed by correctness runs. Modules loaded before timer; first-use JIT included. Small reader repeats 50 times; others once. Hash and memory sampling excluded from timing runs. Memory sampled at chunk boundaries and every 256 rows in separate runs without hash. Native maxRSS includes full child lifetime. Full refresh includes SQL, phase callbacks and RSS sampling; output hash runs afterward. Capture probe used the earlier runner with TypeScript loaded in children; it is only a before-implementation record, not part of the paired comparison.', cases, refresh };
  const destination = join(root, 'docs/benchmarks/JsonlReaderTradeoff.json');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2));
  console.log('Report: docs/benchmarks/JsonlReaderTradeoff.json');
}

async function confirmRefresh() {
  const destination = join(root, 'docs/benchmarks/JsonlReaderTradeoff.json');
  const report = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(report.candidateSourceSha256, sha(await readFile(join(root, 'src/summary/jsonl.ts'), 'utf8')));
  const runs = [];
  for (let pair = 0; pair < 5; pair++) {
    for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const result = await child({ variant, name: 'large', mode: 'refresh' });
      runs.push({ pair, variant, ...result });
      console.log(`confirm large pair ${pair + 1} ${variant}: ${result.results.map(row => `${row.scenario}=${row.elapsedMs.toFixed(1)} (cpu ${row.cpuMs.toFixed(1)})`).join(', ')} ms`);
    }
  }
  for (const scenario of ['initial', 'unchanged', 'append']) {
    assert.equal(new Set(runs.flatMap(run => run.results.filter(row => row.scenario === scenario).map(row => row.digest))).size, 1);
    assert.equal(runs[0].results.find(row => row.scenario === scenario).digest,
      report.refresh.find(entry => entry.name === 'large').runs[0].results.find(row => row.scenario === scenario).digest);
  }
  report.confirmation = { recordedAtSeoul: seoulTime(), name: 'large',
    reason: 'Initial three-pair whole-refresh timings varied strongly, including unchanged runs with zero body bytes. Repeat five alternating pairs and record process CPU/phase time; preserve the first measurement.', runs };
  await writeFile(destination, JSON.stringify(report, null, 2));
}

if (process.argv.includes('--child')) {
  process.once('message', request => worker(request).then(result => { process.send(result, () => process.disconnect()); })
    .catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); }));
} else {
  (process.argv.includes('--capture') ? capture() : process.argv.includes('--confirm-refresh') ? confirmRefresh() : compare())
    .catch(error => { console.error(error); process.exitCode = 1; });
}
