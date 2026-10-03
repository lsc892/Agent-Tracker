import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(__dirname, '../../scripts/quota/benchmark.cjs');
const { optionsFromArgs, summarizeSamples } = require(script) as {
  optionsFromArgs(args: string[]): { real: boolean; iterations: number };
  summarizeSamples(samples: Array<{ offsetMs: number; rssBytes: number; osPeakRssBytes?: number; cpuMs?: number }>,
    method: string, interval: number, lifetime: number): Record<string, number | string | null>;
};

test('quota benchmark requires explicit opt-in before using a real CLI or account home', () => {
  assert.equal(optionsFromArgs([]).real, false);
  assert.equal(optionsFromArgs(['--real']).iterations, 1);
  assert.throws(() => optionsFromArgs(['--executable=codex']), /explicit --real/);
  assert.throws(() => optionsFromArgs(['--data-home=private-home']), /explicit --real/);
  assert.throws(() => optionsFromArgs(['--real=false']), /Invalid benchmark options/);
  assert.throws(() => optionsFromArgs(['--iterations=NaN']), /1–10/);
  assert.throws(() => optionsFromArgs(['--sample-ms=1']), /10–1000/);
});

test('quota RSS report distinguishes observed peak, OS peak, partial CPU and cycle estimate', () => {
  const result = summarizeSamples([
    { offsetMs: 10, rssBytes: 100, osPeakRssBytes: 150, cpuMs: 1 },
    { offsetMs: 40, rssBytes: 200, osPeakRssBytes: 250, cpuMs: 3 },
    { offsetMs: 90, rssBytes: 300, osPeakRssBytes: 350, cpuMs: 4 },
  ], 'fixture', 25, 100);
  assert.equal(result.sampledPeakRssBytes, 300);
  assert.equal(result.osPeakRssBytesAtLastSamples, 350);
  assert.equal(result.observedMeanRssBytes, 200);
  assert.equal(result.cpuTimeAtLastSampleMs, 4);
  assert.equal(result.observedCoverageFraction, 0.8);
  assert.equal(result.observedMeanIntervalMs, 40);
  assert.equal(result.observedMaxIntervalMs, 50);
  assert.equal(result.estimatedCycleMeanRssBytesAt900Seconds, 200 * 100 / 900_000);
  const missing = summarizeSamples([], 'unavailable', 25, 100);
  assert.equal(missing.sampleCount, 0);
  assert.equal(missing.sampledPeakRssBytes, null);
  assert.equal(missing.cpuTimeAtLastSampleMs, null);
  assert.equal(missing.estimatedCycleMeanRssBytesAt900Seconds, null);
});

test('synthetic quota benchmark exercises all exit paths and excludes quota and raw RPC bodies', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-quota-report-'));
  const output = join(directory, 'report.json');
  try {
    const stdout = await new Promise<string>((done, reject) => {
      execFile(process.execPath, [script, '--iterations=1', `--output=${output}`],
        { windowsHide: true, timeout: 25_000, maxBuffer: 512_000 },
        (error, stdout) => error ? reject(error) : done(stdout));
    });
    const serialized = await readFile(output, 'utf8');
    const report = JSON.parse(serialized) as {
      mode: string;
      results: Array<{ scenario: string; matchedExpectedOutcome: boolean; processExitConfirmed: boolean;
        processStillAlive: boolean; memory: { samplerExitConfirmed: boolean } }>;
    };
    assert.equal(report.mode, 'synthetic');
    assert.deepEqual(report.results.map(row => row.scenario), ['success', 'error', 'timeout', 'cancel']);
    for (const row of report.results) {
      assert.equal(row.matchedExpectedOutcome, true);
      assert.equal(row.processExitConfirmed, true);
      assert.equal(row.processStillAlive, false);
      assert.equal(row.memory.samplerExitConfirmed, true);
    }
    assert.doesNotMatch(stdout + serialized, /benchmark-private-canary|usedPercent|resetsAt|accessToken|dataHome|CODEX_HOME/);
  } finally {
    // This is the exact directory created by mkdtemp above, never an account data home.
    await rm(directory, { recursive: true, force: true });
  }
});
