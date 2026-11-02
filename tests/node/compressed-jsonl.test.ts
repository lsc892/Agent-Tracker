// Zstd JSONL의 프레임·UTF-8·오프셋·예산·오류·취소 처리를 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';
import { readJsonl } from '../../src/summary/jsonl';

const compress = (text: string): Buffer => zstdCompressSync(Buffer.from(text), {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
});

async function fixture(data: Buffer, run: (path: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-zstd-'));
  const path = join(directory, 'source.jsonl.zst');
  try { await writeFile(path, data); await run(path, directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('Zstd streams preserve UTF-8, decoded offsets and image budgets without creating expanded files', async () => {
  const first = JSON.stringify({ text: randomBytes(160 * 1024).toString('hex') + '한글 😀' }) + '\r\n';
  const image = JSON.stringify({ image: 'data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024), value: 123 }) + '\n';
  const last = '{"last":"한글 😀"}\n';
  const source = compress(first + image + last);
  await fixture(source, async (path, directory) => {
    const rows: { row: Record<string, unknown>; offset: number }[] = [];
    let bytes = 0, batches = 0;
    const result = await readJsonl(path, source.length, (row, offset) => { rows.push({ row, offset }); }, {
      maxLineBytes: 512 * 1024, onBytes: count => { bytes += count; },
      processBatch: parse => { batches++; parse(); },
    });
    assert.deepEqual(rows, [
      { row: JSON.parse(first), offset: 0 },
      { row: { image: 'data:image/png;base64,', value: 123 }, offset: Buffer.byteLength(first) },
      { row: JSON.parse(last), offset: Buffer.byteLength(first + image) },
    ]);
    assert.deepEqual(result, { rows: 3, partialLine: false, bytes: source.length });
    assert.equal(bytes, source.length);
    assert.ok(batches > 1);
    assert.deepEqual(await readFile(path), source);
    assert.deepEqual(await readdir(directory), ['source.jsonl.zst']);
  });
});

test('concatenated Zstd frames obey the compressed snapshot boundary and retain partial JSONL semantics', async () => {
  const first = compress('{"first":true}\n');
  const second = compress('{"second":true}\n{"pending":');
  await fixture(Buffer.concat([first, second]), async path => {
    const rows: unknown[] = [];
    assert.deepEqual(await readJsonl(path, first.length, row => { rows.push(row); }),
      { rows: 1, partialLine: false, bytes: first.length });
    assert.deepEqual(rows, [{ first: true }]);
    assert.deepEqual(await readJsonl(path, first.length + second.length, () => undefined),
      { rows: 2, partialLine: true, bytes: first.length + second.length });
  });
  await fixture(compress(''), async path => {
    assert.equal((await readJsonl(path, compress('').length, () => assert.fail('empty frame'))).rows, 0);
  });
});

test('Zstd frame boundaries handle unknown sizes, raw/RLE blocks and skippable metadata across source chunks', async () => {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const text = Buffer.from('{"value":"한글"}\n');
  const block = (size: number, type: number): Buffer => {
    const header = Buffer.alloc(3); header.writeUIntLE((size << 3) | (type << 1) | 1, 0, 3); return header;
  };
  const raw = Buffer.concat([magic, Buffer.from([0, 0]), block(text.length, 0), text]);
  const rle = Buffer.concat([magic, Buffer.from([0, 0]), block(1024, 1), Buffer.from('\n')]);
  const skip = Buffer.alloc(8); skip.writeUInt32LE(0x184d2a5f); skip.writeUInt32LE(80 * 1024, 4);
  const source = Buffer.concat([raw, skip, randomBytes(80 * 1024), rle, compress('{"last":true}\n')]);
  await fixture(source, async path => {
    const offsets: number[] = [];
    const result = await readJsonl(path, source.length, (_row, offset) => { offsets.push(offset); });
    assert.equal(result.rows, 2);
    assert.deepEqual(offsets, [0, text.length + 1024]);
    assert.equal(result.partialLine, false);
  });
  await fixture(Buffer.concat([skip, Buffer.from('too short')]), async path => {
    await assert.rejects(readJsonl(path, skip.length + 9, () => undefined), { code: 'decompression-error' });
  });
});

test('compressed JSON errors retain decoded offsets and reject retained text beyond the line budget', async () => {
  const first = '{"ok":true}\n';
  for (const [tail, code] of [
    ['{"text":"' + 'x'.repeat(1024) + '"}\n', 'line-byte-budget-exceeded'],
    ['{"image":"data:image/png;base64,AA\\qAA"}\n', 'parse-error'],
    ['[]\n', 'unsupported-schema'],
  ]) {
    const source = compress(first + tail);
    await fixture(source, async path => {
      await assert.rejects(readJsonl(path, source.length, () => undefined, { maxLineBytes: 128 }),
        { code, offset: Buffer.byteLength(first) });
    });
  }
});

test('corrupt and incomplete Zstd frames fail instead of silently accepting a partial source', async () => {
  const source = compress('{"ok":true}\n');
  const corrupt = Buffer.from(source); corrupt[corrupt.length - 1] ^= 1;
  for (const data of [Buffer.from('not a Zstd frame'), ...Array.from({ length: source.length }, (_, end) => source.subarray(0, end)), corrupt]) {
    await fixture(data, async path => {
      await assert.rejects(readJsonl(path, data.length, () => undefined), { code: 'decompression-error' });
    });
  }
  await fixture(source.subarray(0, source.length - 1), async path => {
    await assert.rejects(readJsonl(path, source.length, () => undefined), { code: 'file-truncated-during-read' });
  });
});

test('early stop and cancellation close the decoder even with a large decoded remainder', async () => {
  const source = compress('{"first":true}\n' + '{"padding":"' + 'x'.repeat(5 * 1024 * 1024) + '"}\n');
  await fixture(source, async path => {
    const result = await readJsonl(path, source.length, () => false);
    assert.equal(result.rows, 1);
    assert.equal(result.partialLine, false);
    const controller = new AbortController();
    await assert.rejects(readJsonl(path, source.length, () => { controller.abort(); }, { signal: controller.signal }),
      { code: 'interrupted' });
    let cancelled = false;
    await assert.rejects(readJsonl(path, source.length, () => { cancelled = true; }, { isCancelled: () => cancelled }),
      { code: 'interrupted' });
  });
});
