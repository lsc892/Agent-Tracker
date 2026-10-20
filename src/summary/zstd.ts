import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants, createZstdDecompress } from 'node:zlib';

export class ZstdError extends Error {
  constructor() { super('Invalid Zstd stream'); }
}

/** Only frame/block lengths are inspected; native Zstd owns decompression and checksum validation.
 * RFC 8878: https://www.rfc-editor.org/rfc/rfc8878.html#section-3.1.1
 * Node's decoder can stop at the first frame and accept an incomplete trailer, so delimit each frame explicitly.
 */
class ZstdFrames {
  private chunk: Buffer = Buffer.alloc(0);
  private offset = 0;

  constructor(private readonly input: AsyncIterator<Buffer>) {}

  async *take(size: number, allowEnd = false): AsyncGenerator<Buffer> {
    let remaining = size;
    while (remaining) {
      if (this.offset === this.chunk.length) {
        const next = await this.input.next();
        if (next.done) {
          if (allowEnd && remaining === size) return;
          throw new ZstdError();
        }
        this.chunk = next.value;
        this.offset = 0;
        continue;
      }
      const end = this.offset + Math.min(remaining, this.chunk.length - this.offset);
      const part = this.chunk.subarray(this.offset, end);
      this.offset = end;
      remaining -= part.length;
      yield part;
    }
  }

  read(size: number): Promise<Buffer>;
  read(size: number, allowEnd: true): Promise<Buffer | undefined>;
  async read(size: number, allowEnd = false): Promise<Buffer | undefined> {
    // Only headers/trailers (at most 13 bytes) use read(); payload uses take().
    const parts: Buffer[] = [];
    for await (const part of this.take(size, allowEnd)) parts.push(part);
    return parts.length ? Buffer.concat(parts) : undefined;
  }

  async *frame(magic: Buffer): AsyncGenerator<Buffer> {
    yield magic;
    const descriptor = await this.read(1);
    const flags = descriptor[0];
    if (flags & 8) throw new ZstdError();
    yield descriptor;
    const single = Boolean(flags & 32);
    const sizeFlag = flags >>> 6;
    const sizeBytes = sizeFlag ? 1 << sizeFlag : Number(single);
    const headerBytes = Number(!single) + [0, 1, 2, 4][flags & 3] + sizeBytes;
    if (headerBytes) yield await this.read(headerBytes);
    let last = false;
    while (!last) {
      const header = await this.read(3);
      const block = header.readUIntLE(0, 3);
      last = Boolean(block & 1);
      const type = (block >>> 1) & 3;
      const size = block >>> 3;
      if (type === 3 || size > 128 * 1024) throw new ZstdError();
      yield header;
      yield* this.take(type === 1 ? 1 : size);
    }
    if (flags & 4) yield await this.read(4);
  }

  async close(): Promise<void> { await this.input.return?.(); }
}

async function* decodeFrame(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let sourceError: unknown;
  const input = async function* (): AsyncGenerator<Buffer> {
    try { yield* chunks; }
    catch (error) { sourceError = error; throw error; }
  };
  const source = Readable.from(input(), { objectMode: false, highWaterMark: 64 * 1024 });
  const decoder = createZstdDecompress({ chunkSize: 64 * 1024,
    params: { [constants.ZSTD_d_windowLogMax]: 27 } });
  let failure: unknown;
  // Observe rejection immediately, including when the row consumer stops before EOF.
  const completed = pipeline(source, decoder).catch(error => { failure = error; });
  try {
    for await (const chunk of decoder) yield chunk as Buffer;
    await completed;
    if (failure) throw failure;
  } catch {
    throw sourceError ?? new ZstdError();
  } finally {
    source.destroy();
    decoder.destroy();
    await completed;
  }
}

/** Backpressure bounds both sides; no expanded file or whole-file buffer is created. */
export async function* zstdChunks(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const frames = new ZstdFrames(chunks[Symbol.asyncIterator]());
  let seen = false;
  try {
    for (let magic = await frames.read(4, true); magic; magic = await frames.read(4, true)) {
      seen = true;
      const value = magic.readUInt32LE();
      if (value >= 0x184d2a50 && value <= 0x184d2a5f) {
        const size = (await frames.read(4)).readUInt32LE();
        for await (const part of frames.take(size)) void part;
      } else if (value === 0xfd2fb528) yield* decodeFrame(frames.frame(magic));
      else throw new ZstdError();
    }
    if (!seen) throw new ZstdError();
  } finally { await frames.close(); }
}
