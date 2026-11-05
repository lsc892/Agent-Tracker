// 고정 JSONL의 줄 경계·이미지·UTF-8 결과와 청크 리더의 시간·프로세스 메모리를 비교한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtemp, mkdir, open, writeFile, readFile, rm } = require('node:fs/promises');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { cpus } = require('node:os');
const { resolve, join, dirname, sep } = require('node:path');
const { performance } = require('node:perf_hooks');

const root = resolve(__dirname, '../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const stats = values => {
  const ordered = [...values].sort((a, b) => a - b), middle = ordered.length / 2;
  return { median: (ordered[Math.floor(middle)] + ordered[Math.ceil(middle) - 1]) / 2,
    min: ordered[0], max: ordered.at(-1), samples: values };
};

async function worker(configPath, variant, caseIndex) {
  const config = JSON.parse(await readFile(configPath, 'utf8')), spec = config.cases[Number(caseIndex)];
  const { readJsonl } = require(join(config[variant], 'dist/src/summary/jsonl'));
  const read = async (validate, memory) => {
    const digest = validate ? createHash('sha256') : undefined;
    let tokens = 0, sampledRss = 0, sampledHeap = 0, sampledExternal = 0;
    const result = await readJsonl(spec.path, spec.bytes, (row, offset) => {
      tokens += row.tokens;
      digest?.update(JSON.stringify([row, offset]) + '\n');
    }, { maxLineBytes: spec.maxLineBytes, processBatch: parse => {
      parse();
      if (memory) {
        const used = process.memoryUsage();
        sampledRss = Math.max(sampledRss, used.rss); sampledHeap = Math.max(sampledHeap, used.heapUsed);
        sampledExternal = Math.max(sampledExternal, used.external);
      }
    } });
    assert.deepEqual(result, { rows: spec.requests, bytes: spec.bytes, partialLine: false });
    assert.equal(tokens, spec.tokens);
    if (validate) assert.equal(digest.digest('hex'), spec.expectedSha256);
    return { sampledRss, sampledHeap, sampledExternal };
  };
  // Three complete warm reads per fresh process; hashing and memory sampling are outside timing.
  await read(true, false); await read(false, false); await read(false, false);
  global.gc();
  const began = performance.now(); await read(false, false); const elapsedMs = performance.now() - began;
  global.gc();
  const beforeMemory = process.memoryUsage(), memory = await read(false, true);
  process.send({ elapsedMs, ...memory, beforeMemory, processHighWaterRssBytes: process.resourceUsage().maxRSS * 1024,
    correctness: 'raw generated rows, sanitized images, offsets, counts and token sums passed' });
}

function runWorker(configPath, variant, index) {
  return new Promise((done, fail) => {
    const child = fork(__filename, ['--worker', configPath, variant, String(index)], {
      execArgv: ['--expose-gc'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    let result, error = '';
    child.stderr.on('data', data => { error += data; });
    child.on('message', message => { result = message; }); child.on('error', fail);
    child.on('exit', code => code === 0 && result ? done(result) : fail(new Error(error.slice(0, 500) || `Worker exit ${code}`)));
  });
}

async function generate(directory, name, requests, padding, imageBytes = 0) {
  const path = join(directory, name + '.jsonl'), file = await open(path, 'wx');
  const inputHash = createHash('sha256'), expected = createHash('sha256');
  let bytes = 0, tokens = 0, maxSourceLineBytes = 0;
  try {
    for (let index = 0; index < requests; index++) {
      const row = { id: index, text: 'x'.repeat(padding) + '한글 😀', tokens: 100 + index % 1000 };
      if (imageBytes) row.image = 'data:image/png;base64,' + 'A'.repeat(imageBytes);
      const text = JSON.stringify(row) + '\r\n', count = Buffer.byteLength(text);
      const sanitized = { ...row };
      if (imageBytes) sanitized.image = 'data:image/png;base64,';
      expected.update(JSON.stringify([sanitized, bytes]) + '\n');
      await file.writeFile(text); inputHash.update(text); tokens += row.tokens;
      bytes += count; maxSourceLineBytes = Math.max(maxSourceLineBytes, count - 1);
    }
  } finally { await file.close(); }
  return { name, path, requests, bytes, tokens, maxSourceLineBytes, maxLineBytes: imageBytes ? 1024 : 4 * 1024 * 1024,
    inputSha256: inputHash.digest('hex'), expectedSha256: expected.digest('hex') };
}

async function main() {
  const options = { before: '', after: root, output: '', pairs: 10 };
  for (const arg of process.argv.slice(2)) {
    const match = /^--(before|after|output|pairs)=(.+)$/.exec(arg); assert.ok(match, `Unknown option ${arg}`);
    options[match[1]] = match[1] === 'pairs' ? Number(match[2]) : resolve(match[2]);
  }
  assert.ok(options.before && options.output && Number.isInteger(options.pairs) && options.pairs >= 10);
  assert.ok(!fs.existsSync(options.output), 'Choose a new output');
  const cache = join(root, 'tests/.cache'); await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, 'jsonl-chunks-'));
  try {
    const cases = [await generate(directory, '100-short', 100, 256), await generate(directory, '10000-short', 10000, 256),
      await generate(directory, '100-long', 100, 128 * 1024), await generate(directory, '1-image-8MiB', 1, 128, 8 * 1024 * 1024)];
    const config = { A: options.before, B: options.after, cases }, configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify(config));
    const report = { startedAtSeoul: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date()),
      environment: { node: process.version, cpu: cpus()[0]?.model, platform: process.platform }, pairs: options.pairs,
      method: { warmupsPerFreshProcess: 3, order: 'AB/BA alternating', cache: 'warm OS cache, not flushed',
        timed: 'open/read/parse/count/close; no hashing, input preparation, GC, memory sampling or IPC',
        memory: 'separate read after GC in each worker; sampled after each parsing batch; process high-water includes module loading, warmups and timed read; transient intra-batch allocations may be missed',
        distribution: 'ordinal-v1, one normalized request-shaped row per record, CRLF, UTF-8 suffix, tokens=100+index%1000; reader-only, no sessions/projects or DB' },
      runnerSha256: sha(fs.readFileSync(__filename)), sources: {}, cases: [] };
    for (const variant of ['A', 'B']) report.sources[variant] = {
      sourceSha256: sha(fs.readFileSync(join(config[variant], 'src/summary/jsonl.ts'))),
      buildSha256: sha(fs.readFileSync(join(config[variant], 'dist/src/summary/jsonl.js'))),
    };
    for (const [index, spec] of cases.entries()) {
      const trials = { A: [], B: [] };
      for (let pair = 0; pair < options.pairs; pair++) {
        for (const variant of pair % 2 ? ['B', 'A'] : ['A', 'B']) trials[variant].push(await runWorker(configPath, variant, index));
      }
      const { path: _localPath, ...input } = spec;
      const summary = Object.fromEntries(['A', 'B'].map(variant => [variant, Object.fromEntries(
        ['elapsedMs', 'sampledRss', 'sampledHeap', 'sampledExternal', 'processHighWaterRssBytes'].map(key => [key, stats(trials[variant].map(row => row[key]))]))]));
      const fasterPairs = trials.A.filter((row, pair) => trials.B[pair].elapsedMs < row.elapsedMs).length;
      report.cases.push({ ...input, trials, summary, fasterPairs });
      console.log(`${spec.name}: ${summary.A.elapsedMs.median.toFixed(3)} -> ${summary.B.elapsedMs.median.toFixed(3)} ms; faster ${fasterPairs}/${options.pairs}`);
    }
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(cache) + sep));
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') worker(...process.argv.slice(3)).then(() => process.disconnect(), error => {
  console.error(error.message); process.exitCode = 1; process.disconnect();
});
else main().catch(error => { console.error(error.message); process.exitCode = 1; });
