import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonl } from '../../src/summary/jsonl';

async function fixture(text: string, run: (path: string, size: number) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-jsonl-'));
  const path = join(directory, 'source.jsonl');
  try { await writeFile(path, text); await run(path, Buffer.byteLength(text)); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('inline image bodies crossing read chunks do not consume the retained line budget or change source offsets', async () => {
  // The next image header straddles the 64 KiB read boundary.
  const emptyFirst = JSON.stringify({ padding: '', name: '한글' }) + '\n';
  const first = JSON.stringify({ padding: 'x'.repeat(64 * 1024 - 20 - Buffer.byteLength(emptyFirst)), name: '한글' }) + '\n';
  const image = JSON.stringify({ image_url: `data:image/png;base64,${'A'.repeat(5 * 1024 * 1024)}`,
    content: [{ image_url: 'data:image/jpeg;base64,BBBB' }],
    text: 'embedded "data:image/png;base64,keep"', usage: { input_tokens: 123, output_tokens: 7 } }) + '\n';
  const last = '{"type":"next","value":"한글"}\r\n';
  await fixture(first + image + last, async (path, size) => {
    const rows: { row: Record<string, unknown>; offset: number }[] = [];
    const result = await readJsonl(path, size, (row, offset) => { rows.push({ row, offset }); }, { maxLineBytes: 128 * 1024 });
    assert.equal(result.rows, 3); assert.equal(result.partialLine, false); assert.equal(result.bytes, size);
    assert.deepEqual(rows.map(row => row.offset), [0, Buffer.byteLength(first), Buffer.byteLength(first + image)]);
    assert.equal(rows[1].row.image_url, 'data:image/png;base64,');
    assert.deepEqual(rows[1].row.content, [{ image_url: 'data:image/jpeg;base64,' }]);
    assert.deepEqual(rows[1].row.usage, { input_tokens: 123, output_tokens: 7 });
    assert.equal(rows[1].row.text, 'embedded "data:image/png;base64,keep"');
    assert.equal(rows[2].row.value, '한글');
  });
});

test('a snapshot ending inside a discarded image waits for the newline without exceeding its budget', async () => {
  const first = '{"type":"first"}\n';
  await fixture(first + '{"image_url":"data:image/png;base64,' + 'A'.repeat(128 * 1024), async (path, size) => {
    const result = await readJsonl(path, size, () => undefined, { maxLineBytes: 128 });
    assert.equal(result.rows, 1); assert.equal(result.partialLine, true);
  });
});

test('non-image content still enforces the line budget at the original offset after a skipped image', async () => {
  const first = JSON.stringify({ image_url: 'data:image/png;base64,' + 'A'.repeat(128 * 1024) }) + '\n';
  await fixture(first + JSON.stringify({ text: 'data:text/plain;base64,' + 'A'.repeat(1024) }) + '\n', async (path, size) => {
    await assert.rejects(readJsonl(path, size, () => undefined, { maxLineBytes: 128 }),
      { code: 'line-byte-budget-exceeded', offset: Buffer.byteLength(first) });
  });
});

test('discarded image strings still reject invalid JSON escapes and control bytes', async () => {
  for (const invalid of ['\\q', '\\u12x4', '\t']) {
    await fixture('{"image_url":"data:image/png;base64,AA' + invalid + 'AA"}\n', async (path, size) => {
      await assert.rejects(readJsonl(path, size, () => undefined), { code: 'parse-error', offset: 0 });
    });
  }
  await fixture('{"image_url":"data:image/png;base64,AA\\"AA\\u0041\\/"}\n', async (path, size) => {
    const result = await readJsonl(path, size, row => { assert.equal(row.image_url, 'data:image/png;base64,'); });
    assert.equal(result.rows, 1);
  });
});
