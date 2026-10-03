const { readdirSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collect(path) : entry.name.endsWith('.test.js') ? [path] : [];
  });
}
const files = collect(join(__dirname, '..', 'dist', 'tests'));
if (!files.length) throw new Error('No test files found');
const report = join(__dirname, '..', 'test-results', 'tests.xml');
mkdirSync(join(__dirname, '..', 'test-results'), { recursive: true });
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${report}`, ...files], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
