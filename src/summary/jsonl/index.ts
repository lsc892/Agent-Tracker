// 일반·Zstd JSONL 로그를 메모리 상한과 이미지 본문 제거 정책에 맞춰 읽는다.
import { open } from 'node:fs/promises';
import { zstdChunks, ZstdError } from './zstd';
import { SummaryError } from './errors';
import { JsonlLine } from './line';
import { projectFixedJson, projectJson, type FixedJsonShape, type JsonShape } from './projection';
import { StreamingFixedProjection } from './streamProjection';

export { SummaryError } from './errors';

/** JSON 문법 오류와 지원하지 않는 최상위 형식을 원본 행 위치로 구분한다. */
function parseJsonlObject(text: string, offset: number, shape: JsonShape | undefined, fixedShape: FixedJsonShape | undefined): Record<string, unknown> {
  // [파싱 정책] 고정 필드, 유형별 필드, 전체 JSON 순으로 적용하고 문법 오류와 객체 형식 오류를 구분한다.
  let row: unknown;
  try { row = fixedShape ? projectFixedJson(text, fixedShape) : shape ? projectJson(text, shape) : JSON.parse(text); }
  catch { throw new SummaryError('parse-error', offset); }
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SummaryError('unsupported-schema', offset);
  return row as Record<string, unknown>;
}

/**
 * 책임: 관측한 크기까지만 로그를 읽고 행과 원본 위치를 전달한다.
 * 64KiB 이하 단위로 파일을 읽고 LF마다 한 행을 전달한다.
 * 청크 경계를 넘거나 이미지가 있는 줄의 고정 필드는 읽는 중에 고른다.
 */
export async function readJsonl(
  path: string,
  size: number,
  onRow: (row: Record<string, unknown>, offset: number) => void | boolean,
  options: { maxLineBytes?: number; signal?: AbortSignal; isCancelled?: () => boolean; onBytes?: (bytes: number) => void;
    shape?: JsonShape; fixedShape?: FixedJsonShape;
    /** Raw file bytes, before image filtering or decompression; valid only during the callback. */
    onChunk?: (chunk: Buffer) => void;
    /** Synchronous processing of at most one chunk; file reads stay outside the callback. */
    processBatch?: (parseRows: () => void) => void } = {},
): Promise<{ partialLine: boolean; bytes: number; rows: number }> {
  const maxLine = options.maxLineBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxLine) || maxLine < 1) throw new RangeError('maxLineBytes must be a positive integer');
  const compressed = path.toLowerCase().endsWith('.jsonl.zst');
  const file = await open(path, 'r');
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
  let line: JsonlLine | undefined;
  let projection: StreamingFixedProjection | undefined;
  let read = 0;
  let lineOffset = 0;
  let rows = 0;
  const chunks = async function* (): AsyncGenerator<Buffer> {
    while (read < size) {
      if (options.signal?.aborted || options.isCancelled?.()) throw new SummaryError('interrupted', read);
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - read), read);
      if (!bytesRead) throw new SummaryError('file-truncated-during-read', read);
      read += bytesRead;
      const bytes = buffer.subarray(0, bytesRead);
      options.onChunk?.(bytes);
      options.onBytes?.(bytesRead);
      // The decoder can prefetch; it must not see a buffer overwritten by the next file read.
      yield compressed ? Buffer.from(bytes) : bytes;
    }
  };

  function parseChunk(chunk: Buffer): boolean {
    let index = 0;
    while (index < chunk.length) {
      const newline = chunk.indexOf(10, index);
      const end = newline < 0 ? chunk.length : newline;
      let text: string | undefined;
      let sourceBytes = end - index;
      if (!line && newline >= 0 && sourceBytes <= maxLine) {
        const candidate = chunk.toString('utf8', index, end).trim();
        // JsonlLine strips literal image bodies and validates their discarded bytes.
        if (!/data:image\//i.test(candidate)) text = candidate;
      }
      if (text === undefined) {
        if (!line) {
          projection = options.fixedShape && new StreamingFixedProjection(options.fixedShape, lineOffset);
          line = new JsonlLine(maxLine, lineOffset, projection?.append.bind(projection));
        }
        line.append(chunk, index, end);
        if (newline < 0) break;
        if (!projection) text = line.text();
        sourceBytes = line.bytes;
      }
      const row = projection ? projection.finish() : text ? parseJsonlObject(text, lineOffset, options.shape, options.fixedShape) : undefined;
      if (row) {
        rows++;
        if (onRow(row, lineOffset) === false) return true;
      }
      lineOffset += sourceBytes + 1;
      line = undefined;
      projection = undefined;
      index = end + 1;
    }
    return false;
  }

  try {
    for await (const chunk of compressed ? zstdChunks(chunks()) : chunks()) {
      if (options.signal?.aborted || options.isCancelled?.()) throw new SummaryError('interrupted', read);
      let stopped: boolean;
      if (options.processBatch) {
        stopped = false;
        options.processBatch(() => { stopped = parseChunk(chunk) || stopped; });
      } else {
        stopped = parseChunk(chunk);
      }
      if (stopped) return { partialLine: false, bytes: read, rows };
    }
    return { partialLine: (line?.bytes ?? 0) > 0, bytes: read, rows };
  } catch (error) {
    if (error instanceof ZstdError) throw new SummaryError('decompression-error', lineOffset);
    throw error;
  } finally { await file.close(); }
}
