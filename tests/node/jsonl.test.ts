// JSONL 리더의 이미지 생략·청크 경계·오류·취소를 기준 구현과 대조한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonl } from '../../src/summary/jsonl';
import { ThreadLogParser, threadFields } from '../../src/summary/parsers/threadUsage';
import { readThreadSource } from '../../src/summary/scanner/sourceReader';
import { readJsonl as readByteJsonl } from '../fixtures/jsonl-byte-reader';
import { truncateSync } from 'node:fs';
import { createHash } from 'node:crypto';

async function fixture(text: string, run: (path: string, size: number) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-jsonl-'));
  const path = join(directory, 'source.jsonl');
  try { await writeFile(path, text); await run(path, Buffer.byteLength(text)); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('Codex prefix dispatch preserves timestamps, duplicate-key fallback, and response winner order', async () => {
  const meta = '{"type":"session_meta","payload":{"id":"thread"}}\n';
  const response = (input: number, model: string) =>
    JSON.stringify({ thread_id: 'thread', turn_id: 'turn', response_id: 'response', model, usage: { input_tokens: input } });
  const prefix = '{"timestamp":"2026-11-25T00:00:00.123Z","ordinal":1,"type":"response_item","payload":';
  const skipped = prefix + '{"timestamp":999,"content":[{"text":"ignored \\"quote\\""}]}}';
  const duplicated = prefix + '{},"type":"token_usage_record","payload":' + response(20, 'first') + '}\n';
  const later = (input: number, model: string) => '{"payload":' + response(input, model) + ',"type":"token_usage_record"}\n';
  const crossChunk = prefix + JSON.stringify({ content: 'x'.repeat(64 * 1024) }) + '}\n';
  const partial = prefix + '{"content":"waiting';
  await fixture(meta + skipped + '\r\n' + duplicated + later(19, 'loser') + crossChunk + later(20, 'tie') + partial, async (path, size) => {
    const parser = new ThreadLogParser('codex', path, path);
    const bytes = Buffer.from(skipped);
    assert.equal(parser.readCompleteLine(bytes, 0, bytes.length), true);
    const baseline = new ThreadLogParser('codex', path, path);
    const projected = await readJsonl(path, size, (row, offset) => baseline.row(row, offset), { fixedShape: threadFields.codex });
    const actual = await readThreadSource({ id: 1, provider: 'codex', path, source_root: path, size_bytes: size,
      mtime_ms: (await stat(path)).mtimeMs }, { cancelled: () => false, onFailedSession: () => assert.fail('unexpected failure') });
    assert.deepEqual(actual, { partialLine: projected.partialLine, thread: baseline.finish() });
    assert.equal(actual.partialLine, true);
    assert.equal(actual.thread?.lastAt, Date.parse('2026-11-25T00:00:00.123Z'));
    assert.equal(actual.thread?.responses.rows[0].model, 'tie');
  });
  await fixture(meta + prefix + '{"discard":[1,]}}\n', async (path, size) => {
    const failed: string[] = [];
    await assert.rejects(readThreadSource({ id: 1, provider: 'codex', path, source_root: path, size_bytes: size,
      mtime_ms: (await stat(path)).mtimeMs }, { cancelled: () => false, onFailedSession: id => { failed.push(id); } }),
    { code: 'parse-error', offset: Buffer.byteLength(meta) });
    assert.deepEqual(failed, ['thread']);
  });
});

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

test('source fingerprint chunks preserve raw image bytes and stop at the observed snapshot size', async () => {
  const source=JSON.stringify({image_url:`data:image/png;base64,${'A'.repeat(128*1024)}`,value:'synthetic'})+'\n';
  await fixture(source+'{"unobserved":true}\n',async(path)=>{
    const digest=createHash('sha256');
    const rows: Record<string,unknown>[]=[];
    const size=Buffer.byteLength(source);
    const result=await readJsonl(path,size,row=>{rows.push(row);},{maxLineBytes:256,onChunk:chunk=>{digest.update(chunk);}});
    assert.equal(result.bytes,size);assert.equal(result.rows,1);
    assert.equal(digest.digest('hex'),createHash('sha256').update(source).digest('hex'));
    assert.equal(rows[0].image_url,'data:image/png;base64,');
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

async function observed(reader: (...args: Parameters<typeof readJsonl>) => Promise<{ partialLine: boolean; bytes: number; rows: number }>, path: string, size: number, maxLineBytes = 4 * 1024 * 1024,
  stopAfter = Infinity): Promise<unknown> {
  const rows: { row: Record<string, unknown>; offset: number }[] = [];
  let bytes = 0, batches = 0;
  try {
    const result = await reader(path, size, (row, offset) => {
      rows.push({ row, offset }); return rows.length < stopAfter;
    }, { maxLineBytes, onBytes: count => { bytes += count; }, processBatch: parse => { batches++; parse(); } });
    return { result: { rows: result.rows, bytes: result.bytes, partialLine: result.partialLine }, rows, bytes, batches };
  } catch (error) {
    const value = error as { code?: string; offset?: number };
    return { error: { code: value.code, offset: value.offset }, rows, bytes, batches };
  }
}

test('range reader matches byte reader at every image-header chunk boundary and retains UTF-8 across reused chunks', async () => {
  const header = '{"image":"DaTa:ImAgE/png;BaSe64,';
  for (let boundary = 0; boundary <= header.length; boundary++) {
    const first = JSON.stringify({ padding: 'x'.repeat(64 * 1024 - boundary - 15) }) + '\n';
    const source = first + header + 'A'.repeat(128 * 1024) + '","value":"한글 😀","escaped":"a\\\"b\\\\c"}\r\n';
    await fixture(source, async (path, size) => {
      assert.deepEqual(await observed(readJsonl, path, size, 128 * 1024), await observed(readByteJsonl, path, size, 128 * 1024));
    });
  }
  const source = JSON.stringify({ text: '한글 😀'.repeat(30000), next: '\\"data:image/png;base64,keep' }) + '\n';
  await fixture(source, async (path, size) => {
    assert.deepEqual(await observed(readJsonl, path, size), await observed(readByteJsonl, path, size));
  });
});

test('snapshots, line budgets, escaped image prefixes and early stop preserve exact byte-reader results', async () => {
  const source = ' \r\n' + JSON.stringify({ text: 'x'.repeat(64 * 1024 - 40) + '한글 😀' }) + '\n'
    + '{"image":"data:image/png;base64,' + 'A'.repeat(70 * 1024) + '\\u0041\\\"AA\\/","next":true}\n'
    + '{"image":"data:im\\u0061ge/png;base64,kept"}\n' + '{"partial":';
  await fixture(source, async (path, size) => {
    for (const snapshot of [0, 3, ...Array.from({ length: 16 }, (_, index) => 64 * 1024 - 8 + index), size - 12, size]) {
      for (const budget of [1, 31, 64 * 1024, 128 * 1024]) {
        assert.deepEqual(await observed(readJsonl, path, snapshot, budget), await observed(readByteJsonl, path, snapshot, budget),
          `snapshot=${snapshot} budget=${budget}`);
      }
    }
    assert.deepEqual(await observed(readJsonl, path, size, 128 * 1024, 1), await observed(readByteJsonl, path, size, 128 * 1024, 1));
  });
});

test('seeded nested JSON and malformed discarded image bytes preserve output or error and offset', async () => {
  let state = 0x31415926;
  const random = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const strings = ['plain', '한글 😀', 'a"b\\c', 'data:image/png;base64,AAAA', 'DATA:IMAGE/jpeg;BASE64,BBBB',
    'embedded data:image/png;base64,keep', 'data:text/plain;base64,keep', 'data:image/' + 'p'.repeat(256) + ';base64,keep'];
  for (let index = 0; index < 80; index++) {
    const rows = Array.from({ length: 1 + random() % 12 }, () => ({
      [strings[random() % strings.length]]: strings[random() % strings.length],
      nested: [{ image: strings[random() % strings.length], number: random(), boolean: Boolean(random() % 2) }],
    }));
    const source = rows.map(row => JSON.stringify(row)).join(index % 2 ? '\r\n' : '\n') + (index % 3 ? '\n' : '');
    await fixture(source, async (path, size) => {
      const budget = index % 4 ? 4096 : 32;
      assert.deepEqual(await observed(readJsonl, path, size, budget), await observed(readByteJsonl, path, size, budget));
    });
  }
  for (const malformed of ['\\q', '\\u12x4', '\\u123"', '\t', '\x00', '\x1f', '\n']) {
    const first = '{"valid":true}\n';
    const source = first + '{"image":"data:image/png;base64,' + 'A'.repeat(128 * 1024) + malformed + '"}\n';
    await fixture(source, async (path, size) => {
      assert.deepEqual(await observed(readJsonl, path, size, 1024), await observed(readByteJsonl, path, size, 1024));
    });
  }
  for (const unsupported of ['null\n', '[]\n', '1\n', '{bad}\n']) {
    await fixture(unsupported, async (path, size) => {
      assert.deepEqual(await observed(readJsonl, path, size), await observed(readByteJsonl, path, size));
    });
  }
});

test('chunk cancellation and truncation still stop before another parsing batch', async () => {
  const source = '{"value":"' + 'x'.repeat(128 * 1024) + '"}\n';
  await fixture(source, async (path, size) => {
    const controller = new AbortController();
    await assert.rejects(readJsonl(path, size, () => assert.fail('incomplete row'), {
      signal: controller.signal, onBytes: () => controller.abort(),
    }), { code: 'interrupted', offset: 64 * 1024 });
    await assert.rejects(readJsonl(path, size, () => assert.fail('incomplete row'), {
      processBatch: parse => { parse(); truncateSync(path, 64 * 1024); },
    }), { code: 'file-truncated-during-read', offset: 64 * 1024 });
  });
});

test('unfinished ordinary lines keep UTF-8 bytes across reused chunks and emit only after LF', async () => {
  const prefix = '{"text":"';
  // Split a three-byte character at the first read boundary, then span several more chunks.
  const first = prefix + 'x'.repeat(64 * 1024 - Buffer.byteLength(prefix) - 1) + '한글 😀'.repeat(20000) + '"}\r\n';
  const partial = '{"unfinished":"' + 'z'.repeat(70 * 1024);
  await fixture(first + '{"next":true}\n' + partial, async (path, size) => {
    const rows: { row: Record<string, unknown>; offset: number }[] = [];
    let batches = 0;
    const result = await readJsonl(path, size, (row, offset) => { rows.push({ row, offset }); }, {
      processBatch: parse => {
        batches++; parse();
        if (batches * 64 * 1024 < Buffer.byteLength(first)) assert.equal(rows.length, 0);
      },
    });
    assert.deepEqual(rows, [{ row: JSON.parse(first), offset: 0 }, { row: { next: true }, offset: Buffer.byteLength(first) }]);
    assert.deepEqual(result, { rows: 2, bytes: size, partialLine: true });
    assert.deepEqual(await observed(readJsonl, path, size), await observed(readByteJsonl, path, size));
  });
});

test('an image discovered after buffered ordinary chunks preserves the retained budget and validation', async () => {
  const prefix = '{"text":"' + 'x'.repeat(150 * 1024) + '","image":"data:image/png;base64,';
  for (const ending of ['AA"}\n', 'AA\\q"}\n']) {
    const source = prefix + 'A'.repeat(300 * 1024) + ending;
    await fixture(source, async (path, size) => {
      for (const budget of [128 * 1024, 160 * 1024]) {
        assert.deepEqual(await observed(readJsonl, path, size, budget), await observed(readByteJsonl, path, size, budget));
      }
    });
  }
});

test('per-line decoding preserves source byte offsets even when UTF-8 replacement changes string length', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-jsonl-'));
  const path = join(directory, 'source.jsonl');
  const first = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff, 0xc3]), Buffer.from('"}\r\n')]);
  const second = Buffer.from('{"next":"한글 😀"}\n');
  try {
    await writeFile(path, Buffer.concat([first, second]));
    const rows: { row: Record<string, unknown>; offset: number }[] = [];
    await readJsonl(path, first.length + second.length, (row, offset) => { rows.push({ row, offset }); });
    assert.deepEqual(rows, [{ row: JSON.parse(first.toString('utf8')), offset: 0 },
      { row: { next: '한글 😀' }, offset: first.length }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
