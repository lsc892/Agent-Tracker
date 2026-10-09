const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { join, resolve, dirname } = require('node:path');
const { performance } = require('node:perf_hooks');

const root = resolve(__dirname, '../..');
const cache = join(root, 'tests/.cache/jsonl-parsing-branches-20261009');
const setupPath = join(cache, 'setup.json');
const legacyPath = join(root, 'docs/benchmarks/JsonlReaderTradeoff.json');
const manifestPath = join(root, 'tests/.cache/jsonl-reader/manifest.json');
const sha = value => createHash('sha256').update(value).digest('hex');
const canonicalSha = value => sha(value.toString('utf8').replace(/\r\n/g, '\n'));
const git = (directory, args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const seoulTime = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium',
}).format(new Date());
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};

async function prepare() {
  await fs.mkdir(dirname(cache), { recursive: true });
  await fs.mkdir(cache); // Refuse to replace a frozen experiment.
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const legacy = await fs.readFile(legacyPath);
  await fs.writeFile(join(cache, 'previous-report.json'), legacy, { flag: 'wx' });
  await fs.writeFile(join(cache, 'previous-report.md'), await fs.readFile(join(root, 'docs/JsonlReaderTradeoff.md')), { flag: 'wx' });
  await fs.writeFile(join(cache, 'input-manifest.json'), manifestBytes, { flag: 'wx' });
  const branches = {};
  for (const [variant, suffix] of [['before', 'before'], ['after', 'after']]) {
    const directory = resolve(root, `../Agent-Tracker-bench-jsonl-${suffix}-20261009`);
    const source = await fs.readFile(join(directory, 'src/summary/jsonl.ts'));
    const modulePath = join(directory, 'dist/src/summary/jsonl.js');
    await fs.writeFile(join(cache, `${variant}.ts`), source, { flag: 'wx' });
    branches[variant] = { directory, branch: git(directory, ['branch', '--show-current']), commit: git(directory, ['rev-parse', 'HEAD']),
      sourceSha256: sha(source), canonicalSourceSha256: canonicalSha(source), modulePath,
      moduleSha256: sha(await fs.readFile(modulePath)), status: git(directory, ['status', '--short']),
      readerStatus: git(directory, ['status', '--short', '--', 'src/summary/jsonl.ts']) };
  }
  assert.equal(branches.before.commit, manifest.baselineCommit);
  assert.equal(branches.before.readerStatus, '');
  assert.equal(branches.before.canonicalSourceSha256, canonicalSha(await fs.readFile(join(root, 'tests/.cache/jsonl-reader/baseline.ts'))));
  assert.equal(branches.after.canonicalSourceSha256, canonicalSha(await fs.readFile(join(root, 'src/summary/jsonl.ts'))));
  await fs.writeFile(join(cache, 'after-reader.patch'), git(branches.after.directory, ['diff', '--no-ext-diff', '--', 'src/summary/jsonl.ts']) + '\n', { flag: 'wx' });
  const setup = { preparedAtSeoul: seoulTime(), originalBranch: git(root, ['branch', '--show-current']),
    legacyReportSha256: sha(legacy), inputManifestSha256: sha(manifestBytes), branches };
  await fs.writeFile(setupPath, JSON.stringify(setup, null, 2), { flag: 'wx' });
  console.log(`Prepared ${branches.before.branch} / ${branches.after.branch}; previous results archived unchanged.`);
}

/** Inputs are loaded before timing. The product reader receives only RAM-backed handles. */
function memoryOpen(inputs) {
  return async (path, flags) => {
    assert.equal(flags, 'r');
    const input = inputs.get(path);
    assert.ok(input, 'Reader attempted to open a path outside the frozen RAM inputs');
    let closed = false;
    return {
      async read(buffer, offset, length, position) {
        assert.equal(closed, false);
        const bytesRead = Math.min(length, Math.max(0, input.length - position));
        input.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead, buffer };
      },
      async close() { closed = true; },
    };
  };
}

async function worker(request) {
  const setup = JSON.parse(await fs.readFile(setupPath, 'utf8'));
  const manifest = JSON.parse(await fs.readFile(join(cache, 'input-manifest.json'), 'utf8'));
  const branch = setup.branches[request.variant];
  const entry = manifest.cases.find(value => value.name === request.name);
  assert.equal(sha(await fs.readFile(branch.modulePath)), branch.moduleSha256, 'Compiled branch changed');
  assert.equal(sha(await fs.readFile(join(branch.directory, 'src/summary/jsonl.ts'))), branch.sourceSha256, 'Branch source changed');
  const inputs = new Map();
  for (const file of entry.files) {
    const buffer = await fs.readFile(file.path);
    assert.equal(buffer.length, file.size);
    assert.equal(sha(buffer), file.sha256, 'Frozen JSONL changed');
    inputs.set(file.path, buffer);
  }
  // Neither a disk read nor open/close is reachable from readJsonl after this point.
  const originalOpen = fs.open, originalParse = JSON.parse;
  fs.open = memoryOpen(inputs);
  const { readJsonl } = require(branch.modulePath);
  const iterations = request.mode === 'timing' ? (entry.name === 'small' ? 500 : 1) : 1;
  let inBatch = false;
  let jsonParseMs = 0, jsonParseCalls = 0, retainedJsonBytes = 0, maxRetainedLineBytes = 0;
  if (request.mode === 'trace') {
    JSON.parse = function (text, reviver) {
      if (!inBatch) return originalParse(text, reviver);
      const start = performance.now();
      try { return originalParse(text, reviver); }
      finally {
        jsonParseMs += performance.now() - start;
        jsonParseCalls++;
        const bytes = Buffer.byteLength(text, 'utf8');
        retainedJsonBytes += bytes; maxRetainedLineBytes = Math.max(maxRetainedLineBytes, bytes);
      }
    };
  }
  const verify = request.mode === 'verify', measureMemory = request.mode === 'memory';
  const digest = verify ? createHash('sha256') : null;
  const observedPeaks = {};
  const sample = () => {
    for (const [key, value] of Object.entries(process.memoryUsage())) observedPeaks[key] = Math.max(observedPeaks[key] ?? 0, value);
  };
  async function run(count, measured) {
    let rows = 0, batches = 0, bytes = 0, partialFiles = 0, parsingMs = 0;
    for (let iteration = 0; iteration < count; iteration++) {
      for (const [ordinal, file] of entry.files.entries()) {
        if (verify && measured) digest.update(JSON.stringify(['file', ordinal]));
        const result = await readJsonl(file.path, file.size, (row, offset) => {
          rows++;
          if (verify && measured) digest.update(JSON.stringify(['row', offset, row]));
        }, { maxLineBytes: entry.maxLineBytes, onBytes: value => { bytes += value; },
          processBatch(parseRows) {
            batches++;
            if (measureMemory) sample();
            inBatch = true;
            const start = performance.now();
            try { parseRows(); } finally { parsingMs += performance.now() - start; inBatch = false; }
            if (measureMemory) sample();
          } });
        if (result.partialLine) partialFiles++;
        if (verify && measured) digest.update(JSON.stringify(['read', result]));
      }
    }
    if (entry.expectedRows !== undefined) assert.equal(rows, entry.expectedRows * count);
    assert.equal(bytes, entry.files.reduce((sum, file) => sum + file.size, 0) * count);
    return { rows, batches, bytes, partialFiles, parsingMs };
  }
  try {
    if (request.mode === 'timing') await run(1, false);
    global.gc?.();
    const memoryBefore = process.memoryUsage();
    if (measureMemory) sample();
    const pipelineStart = performance.now();
    const result = await run(iterations, true);
    const inMemoryPipelineMs = performance.now() - pipelineStart;
    const perCorpusParsingMs = result.parsingMs / iterations;
    const corpusBytes = entry.files.reduce((sum, file) => sum + file.size, 0);
    return { ...result, iterations, perCorpusParsingMs, inMemoryPipelineMs,
      throughputMiBPerSecond: corpusBytes / 1048576 / (perCorpusParsingMs / 1000), timedFileIO: false,
      ...(verify ? { digest: digest.digest('hex') } : {}),
      ...(request.mode === 'trace' ? { jsonParseMs, jsonParseCalls, retainedJsonBytes, maxRetainedLineBytes,
        preprocessingAndInstrumentationMs: result.parsingMs - jsonParseMs } : {}),
      ...(measureMemory ? { inputBufferBytes: corpusBytes, memoryBefore, observedPeaks, endpoint: process.memoryUsage(),
        peakDelta: Object.fromEntries(Object.keys(memoryBefore).map(key => [key, Math.max(0, (observedPeaks[key] ?? 0) - memoryBefore[key])])),
        nativeMaxRssKiB: process.resourceUsage().maxRSS } : {}) };
  } finally { fs.open = originalOpen; JSON.parse = originalParse; }
}

function child(request) {
  return new Promise((accept, reject) => {
    const processChild = fork(__filename, ['--child'], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true, execArgv: ['--expose-gc'],
    });
    let response;
    processChild.on('message', value => { response = value; });
    processChild.on('error', reject);
    processChild.on('exit', code => code === 0 && response ? accept(response) : reject(new Error(`Parsing child failed (${code})`)));
    processChild.send(request);
  });
}

async function compare() {
  const setup = JSON.parse(await fs.readFile(setupPath, 'utf8'));
  assert.equal(sha(await fs.readFile(legacyPath)), setup.legacyReportSha256, 'Previous measurement must stay unchanged');
  const manifestBytes = await fs.readFile(join(cache, 'input-manifest.json'));
  assert.equal(sha(manifestBytes), setup.inputManifestSha256);
  const manifest = JSON.parse(manifestBytes);
  const pairs = Number(option('--pairs', '3'));
  assert.ok(Number.isInteger(pairs) && pairs >= 1 && pairs <= 10);
  const selected = option('--cases', manifest.cases.map(entry => entry.name).join(',')).split(',');
  assert.ok(selected.every(name => manifest.cases.some(entry => entry.name === name)));
  const cases = [];
  for (const entry of manifest.cases.filter(value => selected.includes(value.name))) {
    const correctness = {}, trace = {}, memory = {};
    for (const variant of ['before', 'after']) correctness[variant] = await child({ variant, name: entry.name, mode: 'verify' });
    assert.equal(correctness.before.digest, correctness.after.digest, 'JSON rows, offsets or partial-line flags changed');
    const runs = [];
    for (let pair = 0; pair < pairs; pair++) {
      for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
        const result = await child({ variant, name: entry.name, mode: 'timing' });
        assert.equal(result.rows, correctness[variant].rows * result.iterations);
        runs.push({ pair, variant, ...result });
        console.log(`${entry.name} ${variant} pair ${pair + 1}: JSONL parsing ${result.perCorpusParsingMs.toFixed(3)} ms`);
      }
    }
    for (const variant of ['before', 'after']) {
      trace[variant] = await child({ variant, name: entry.name, mode: 'trace' });
      memory[variant] = await child({ variant, name: entry.name, mode: 'memory' });
    }
    assert.equal(trace.before.jsonParseCalls, trace.after.jsonParseCalls);
    assert.equal(trace.before.retainedJsonBytes, trace.after.retainedJsonBytes);
    const beforeMs = median(runs.filter(run => run.variant === 'before').map(run => run.perCorpusParsingMs));
    const afterMs = median(runs.filter(run => run.variant === 'after').map(run => run.perCorpusParsingMs));
    cases.push({ name: entry.name, input: entry.input, rows: correctness.before.rows, sourceBytes: entry.files.reduce((sum, file) => sum + file.size, 0),
      retainedJsonBytes: trace.before.retainedJsonBytes, maxRetainedLineBytes: trace.before.maxRetainedLineBytes,
      sourceFileCount: entry.files.length, inputSha256: sha(JSON.stringify(entry.files.map(file => [file.provider, file.size, file.sha256]))),
      beforeMs, afterMs, speedup: beforeMs / afterMs, improvementPercent: (beforeMs - afterMs) / beforeMs * 100,
      correctness, trace, memory, runs });
    await fs.writeFile(join(cache, 'progress.json'), JSON.stringify({ cases }, null, 2));
  }
  assert.equal(sha(await fs.readFile(legacyPath)), setup.legacyReportSha256);
  assert.equal(git(root, ['branch', '--show-current']), setup.originalBranch);
  for (const branch of Object.values(setup.branches)) {
    assert.equal(sha(await fs.readFile(join(branch.directory, 'src/summary/jsonl.ts'))), branch.sourceSha256);
  }
  const output = resolve(root, option('--output', 'docs/benchmarks/JsonlParsingBranches-2026-10-09.json'));
  const report = { recordedAtSeoul: seoulTime(), node: process.version, platform: process.platform, arch: process.arch, pairs,
    originalBranchPreserved: setup.originalBranch,
    previousMeasurement: { path: 'docs/benchmarks/JsonlReaderTradeoff.json', sha256: setup.legacyReportSha256, preserved: true },
    inputManifestSha256: setup.inputManifestSha256,
    branches: Object.fromEntries(Object.entries(setup.branches).map(([key, value]) => [key, {
      branch: value.branch, commit: value.commit, sourceSha256: value.sourceSha256,
      canonicalSourceSha256: value.canonicalSourceSha256, moduleSha256: value.moduleSha256, readerStatus: value.readerStatus,
    }])), harnessSha256: sha(await fs.readFile(__filename)),
    method: 'Both real branch builds, identical frozen JSONL Buffers loaded and hash-checked before timing. fs/promises.open returns RAM-only handles; no disk IO in readJsonl. Primary metric sums synchronous processBatch parseRows intervals: LF/string/image processing, UTF-8 decode, JSON.parse and schema/row-count checks. Excludes RAM feed copy/await, reader initialization, adapter, SQLite, hash and memory sampling. One full warm-up and explicit GC before each timing run. Small case repeats 500 times; others once. Fresh processes, sequential alternating pairs. JSON.parse and retained-byte tracing are separate one-pass diagnostics; residual includes timer/byte-count overhead. Memory uses another one-pass run without hash; preloaded corpus is O(N) benchmark overhead, not product parser space. Existing I/O-inclusive measurements preserved byte-for-byte.',
    complexity: { sourceBytes: 'N', retainedJsonBytes: 'B', maxRetainedLineBytes: 'L', chunkBytes: 65536, maxLineBudgetBytes: 4194304,
      beforeTime: 'O(N+B)', afterTime: 'O(N+B)', parserSpaceBoth: 'O(C+min(L,K)) excluding row objects',
      benchmarkInputSpace: 'O(N), RAM preload outside parser metric' }, cases };
  await fs.mkdir(dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(`Saved ${output}; legacy report SHA-256 unchanged.`);
}

if (process.argv.includes('--child')) {
  process.once('message', request => worker(request).then(result => { process.send(result, () => process.disconnect()); })
    .catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); }));
} else {
  (process.argv.includes('--prepare') ? prepare() : compare()).catch(error => { console.error(error); process.exitCode = 1; });
}
