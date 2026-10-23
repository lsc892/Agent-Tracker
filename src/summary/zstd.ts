import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants, createZstdDecompress } from 'node:zlib';

export class ZstdError extends Error {
  constructor() { super('Invalid Zstd stream'); }
}

/**
 * 책임: 연결된 Zstd 프레임의 정확한 경계와 잘림을 검사한다.
 * 알고리즘: RFC 8878의 헤더·블록 길이만 읽어 프레임별 청크를 나누고 압축 해제·체크섬 검증은 네이티브 decoder에 맡긴다.
 * 규격: https://www.rfc-editor.org/rfc/rfc8878.html#section-3.1.1
 */
class ZstdFrames {
  private chunk: Buffer = Buffer.alloc(0);
  private offset = 0;

  constructor(private readonly input: AsyncIterator<Buffer>) {}

  /**
   * 책임: 입력 청크 경계와 무관하게 지정한 압축 바이트 수를 전달한다.
   * 알고리즘: 현재 청크에서 필요한 부분만 subarray로 yield하고 부족하면 다음 청크를 읽으며 허용된 경계 종료 외의 EOF는 잘림으로 거부한다.
   */
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

  /**
   * 책임: 단일 Zstd 프레임의 마지막 블록·체크섬까지 정확히 구획한다.
   * 알고리즘: descriptor로 헤더 길이를 구하고 3바이트 블록 헤더의 type·size·last 비트를 해석해 payload와 체크섬을 순서대로 전달한다.
   */
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

/**
 * 책임: 한 프레임을 스트리밍 해제하고 오류·조기 종료 시 자원을 회수한다.
 * 알고리즘: backpressure가 적용된 pipeline으로 decoder에 연결하고 원본 읽기 오류를 보존하며, finally에서 양쪽 스트림과 완료 Promise를 정리한다.
 */
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

/**
 * 책임: 전체 파일을 적재하거나 임시 해제 파일을 만들지 않고 Zstd 로그를 읽는다.
 * 알고리즘: magic 값에 따라 일반 프레임은 하나씩 해제하고 skippable 프레임은 길이만큼 건너뛰며 입력 종료까지 반복한다.
 */
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
