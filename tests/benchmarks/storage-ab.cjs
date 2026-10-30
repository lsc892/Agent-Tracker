// 날짜 배치·SQL 묶음 비교·파싱 재사용을 서로 분리한 재현 가능한 A/B 실험을 실행한다.
const { mkdir, mkdtemp, writeFile, rm, readdir } = require('node:fs/promises');
const { join, resolve, dirname } = require('node:path');
const { cpus } = require('node:os');
const { execFileSync } = require('node:child_process');
const explicitProduct = process.argv.find(a => a.startsWith('--product='))?.slice(10);
const historicalProduct = resolve(__dirname,'../.cache/storage-product-20261030/before');
if (explicitProduct || require('node:fs').existsSync(historicalProduct)) process.env.AGENT_TRACKER_BENCH_PRODUCT = resolve(explicitProduct ?? historicalProduct);
const { root, productRoot, assert, time, fingerprint } = require('./storage-ab-common.cjs');
async function sources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(path)); else if (/\.(ts|js)$/.test(entry.name)) files.push(path);
  }
  return files;
}
async function main() {
  const options = { product: productRoot, requests: 100000, layoutTurns: [100,10000], writeTurns: [10,25,100,300,1000,3000,10000],
    parseTurns: [100,10000], samples: 5, warmup: 1, sections: ['layout','writes','parsing'],
    output: join(root, 'docs/benchmarks/2026-10-29/StorageAB-2026-10-29.json') };
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    assert.ok(Object.hasOwn(options, key), `Unknown option ${key}`);
    options[key] = ['requests','samples','warmup'].includes(key) ? Number(value)
      : ['layoutTurns','writeTurns','parseTurns'].includes(key) ? value.split(',').map(Number)
      : key === 'sections' ? value.split(',') : resolve(value);
  }
  assert.ok(Number.isInteger(options.samples) && options.samples >= 3 && options.samples <= 31);
  assert.ok(Number.isInteger(options.warmup) && options.warmup >= 1 && options.warmup <= 5);
  assert.ok(Number.isInteger(options.requests) && options.requests > 0 && options.requests <= 1000000);
  for (const key of ['layoutTurns','writeTurns','parseTurns']) assert.ok(options[key].every(n => Number.isInteger(n) && n > 0 && n <= 10000));
  assert.ok(options.layoutTurns.every(n => options.requests % (2 * n) === 0));
  assert.ok(options.sections.every(n => ['layout','writes','parsing'].includes(n)));
  assert.equal(require(join(productRoot,'dist/src/summary/db/schema')).SCHEMA_VERSION,13,
    'Historical prototype comparison requires a schema-v13 --product snapshot; use storage-product.cjs for product stages.');
  const benchSources = ['storage-ab','storage-ab-common','storage-ab-layout','storage-ab-writes','storage-ab-parsing'].map(n => join(__dirname, `${n}.cjs`));
  const hashes = fingerprint([...benchSources, ...await sources(join(productRoot,'src/summary')), ...await sources(join(productRoot,'dist/src/summary')),
    ...['sessions','rollups'].map(n => join(root, `tests/fixtures/storage-ab/incremental-${n}.js.txt`))]);
  const report = { startedSeoul: time(), head: execFileSync('git', ['rev-parse','HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    runtime: { node: process.version, sqlite: require('node:sqlite').DatabaseSync ? process.versions.sqlite : null, platform: process.platform, cpu: cpus()[0].model },
    options, sourceSha256: hashes, limitations: ['synthetic controlled input; no installed DB changes', 'warm same-process rotated order; not OS cold I/O',
      'measured writes include input structuredClone, transaction, validation, rollup maintenance and commit',
      'no production change or automatic threshold adoption; parser cache is a benchmark-only prototype'] };
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(join(root, 'tests/results/benchmarks'), { recursive: true });
  const directory = await mkdtemp(join(root, 'tests/results/benchmarks/storage-ab-'));
  try {
    for (const section of options.sections) {
      console.log(`${time()} Starting ${section}`);
      const fn = section === 'layout' ? require('./storage-ab-layout.cjs').runLayout
        : section === 'writes' ? require('./storage-ab-writes.cjs').runWrites : require('./storage-ab-parsing.cjs').runParsing;
      report[section] = await fn(directory, options);
      report.updatedSeoul = time(); await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
    }
    assert.deepEqual(fingerprint(Object.keys(hashes)), hashes, 'Measured sources changed during execution');
    report.completedSeoul = time(); await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Saved ${options.output}`);
  } finally {
    const target = resolve(directory), parent = resolve(root, 'tests/results/benchmarks');
    assert.equal(dirname(target), parent); assert.ok(target.startsWith(parent + require('node:path').sep));
    await rm(target, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
