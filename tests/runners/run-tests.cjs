const { readdirSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collect(path) : entry.name.endsWith('.test.js') ? [path] : [];
  });
}
const root = join(__dirname, '../..');
const files = collect(join(root, 'dist', 'tests', 'node'));
if (!files.length) throw new Error('No test files found');
const report = join(root, 'tests', 'results', 'tests.xml');
mkdirSync(join(root, 'tests', 'results'), { recursive: true });
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${report}`, ...files], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
