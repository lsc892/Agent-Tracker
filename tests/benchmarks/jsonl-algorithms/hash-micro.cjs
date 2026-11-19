// 동일한 64KiB 메모리 청크를 네이티브 스트리밍 해시에 넣어 CPU 시간과 프로세스 메모리를 계측한다.
'use strict';

const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { cpus, release } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { loadHashers, validateHashers } = require('./hashers.cjs');

const project = resolve(__dirname, '../../..');
const chunkBytes = 64 * 1024;
const sizes = [1_000_000, 10_000_000, 100_000_000];
const algorithmIds = ['sha256', 'xxh128', 'blake3'];
const warmups = 3;
const repetitions = 10;

function memory() {
  return { ...process.memoryUsage(), lifetimeMaxRss: process.resourceUsage().maxRSS * 1024 };
}

async function childMain(algorithm) {
  const verification = await validateHashers();
  const provider = (await loadHashers())[algorithm];
  const chunk = Buffer.alloc(chunkBytes, 97);
  process.send({ type: 'ready', algorithm, provider: {
    name: provider.name, implementation: provider.implementation,
    package: provider.package, reference: provider.reference,
  }, verification, baseline: memory() });
  process.on('message', request => {
    if (request.type === 'stop') { process.disconnect(); return; }
    try {
      global.gc();
      const before = memory();
      const started = performance.now();
      const hash = provider.create();
      for (let remaining = request.bytes; remaining > 0; remaining -= chunkBytes) {
        hash.update(remaining >= chunkBytes ? chunk : chunk.subarray(0, remaining));
      }
      const digest = hash.digest();
      const elapsedMs = performance.now() - started;
      const after = memory();
      global.gc();
      process.send({ type: 'result', id: request.id, algorithm, bytes: request.bytes,
        elapsedMs, digest, before, after, afterGc: memory() });
    } catch (error) {
      process.send({ type: 'failure', id: request.id, message: error.stack ?? String(error) });
    }
  });
}

function startChild(algorithm) {
  const child = fork(__filename, ['--child', algorithm], {
    cwd: project, execArgv: ['--expose-gc'], windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let diagnostic = '', nextId = 0;
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
  child.on('error', error => {
    readyReject(error);
    for (const operation of pending.values()) operation.reject(error);
  });
  child.on('exit', code => {
    if (code !== 0) {
      const error = new Error(`${algorithm} child exited ${code}: ${diagnostic}`);
      readyReject(error);
      for (const operation of pending.values()) operation.reject(error);
    }
  });
  child.on('message', value => {
    if (value.type === 'ready') { readyResolve(value); return; }
    const operation = pending.get(value.id);
    if (!operation) return;
    pending.delete(value.id);
    if (value.type === 'failure') operation.reject(new Error(value.message));
    else operation.resolve(value);
  });
  return {
    ready,
    measure(bytes) {
      const id = ++nextId;
      return new Promise((resolveResult, rejectResult) => {
        pending.set(id, { resolve: resolveResult, reject: rejectResult });
        child.send({ type: 'measure', id, bytes });
      });
    },
    stop() { if (child.connected) child.send({ type: 'stop' }); },
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function main() {
  const argument = process.argv.find(value => value.startsWith('--output='));
  const output = resolve(argument ? argument.slice('--output='.length)
    : join(project, 'tests/.cache', `jsonl-algorithms-hash-micro-${Date.now()}.json`));
  const children = Object.fromEntries(algorithmIds.map(id => [id, startChild(id)]));
  try {
    const ready = await Promise.all(algorithmIds.map(id => children[id].ready));
    const samples = [], measuredDigests = new Map();
    for (const bytes of sizes) {
      for (let round = 0; round < warmups + repetitions; round++) {
        const order = round % 2 ? [...algorithmIds].reverse() : algorithmIds;
        for (const algorithm of order) {
          const result = await children[algorithm].measure(bytes);
          const key = `${algorithm}/${bytes}`;
          const expectedDigest = measuredDigests.get(key);
          if (expectedDigest && result.digest !== expectedDigest) throw new Error(`${key} repeated digest mismatch`);
          measuredDigests.set(key, result.digest);
          if (round >= warmups) samples.push({ ...result, repetition: round - warmups + 1, order: [...order] });
        }
      }
    }
    const summaries = [];
    for (const bytes of sizes) for (const algorithm of algorithmIds) {
      const selected = samples.filter(sample => sample.algorithm === algorithm && sample.bytes === bytes);
      const elapsed = selected.map(sample => sample.elapsedMs);
      const medianMs = median(elapsed);
      summaries.push({ algorithm, bytes, samples: selected.length, medianMs,
        minMs: Math.min(...elapsed), maxMs: Math.max(...elapsed),
        throughputGBs: bytes / medianMs / 1_000_000,
        medianRssBeforeBytes: median(selected.map(sample => sample.before.rss)),
        medianRssAfterBytes: median(selected.map(sample => sample.after.rss)),
        maxLifetimeRssBytes: Math.max(...selected.map(sample => sample.after.lifetimeMaxRss)),
        medianHeapDeltaBytes: median(selected.map(sample => sample.after.heapUsed - sample.before.heapUsed)),
        medianExternalDeltaBytes: median(selected.map(sample => sample.after.external - sample.before.external)),
      });
    }
    const sourceFiles = ['hashers.cjs', 'hash-micro.cjs'].map(name => ({
      path: `tests/benchmarks/jsonl-algorithms/${name}`,
      sha256: createHash('sha256').update(readFileSync(join(__dirname, name))).digest('hex'),
    }));
    const report = {
      experiment: 'jsonl-algorithms-native-hash-micro', createdAt: new Date().toISOString(),
      environment: { node: process.version, openssl: process.versions.openssl,
        v8: process.versions.v8, os: process.platform, osRelease: release(), arch: process.arch,
        cpu: cpus()[0].model.trim(), logicalCpuCount: cpus().length },
      scope: 'CPU hashing of one reused hot 64KiB memory buffer, excluding file I/O, JSON parsing, dependency loading, process startup, GC, and memory sampling',
      memoryScope: 'Per-algorithm child process RSS and heap endpoints. Lifetime max RSS includes provider loading and warmup. Input buffer remains 64KiB at all sizes.',
      chunkBytes, sizes, warmups, repetitions, order: 'ABC/CBA alternating for each warmup and measured round',
      input: { pattern: 'reused byte 0x61 chunk, final chunk sliced to requested decimal byte size', chunkBytes },
      providers: ready, sourceFiles, verification: { repeatedDigestMatched: true }, summaries, samples,
    };
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ output, summaries }, null, 2));
  } finally {
    for (const child of Object.values(children)) child.stop();
  }
}

if (process.argv[2] === '--child') childMain(process.argv[3]).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
else main().catch(error => { console.error(error); process.exitCode = 1; });
