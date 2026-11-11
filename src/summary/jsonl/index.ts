// 일반·Zstd JSONL 로그를 메모리 상한과 이미지 본문 제거 정책에 맞춰 읽는다.
import { open } from 'node:fs/promises';
import { zstdChunks, ZstdError } from './zstd';
import { SummaryError } from './errors';
import { JsonlLine } from './line';

export { SummaryError } from './errors';

/** JSON 문법 오류와 지원하지 않는 최상위 형식을 원본 행 위치로 구분한다. */
function parseJsonlObject(text: string, offset: number): Record<string, unknown> {
  let row: unknown;
  try { row = JSON.parse(text); } catch { throw new SummaryError('parse-error', offset); }
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SummaryError('unsupported-schema', offset);
  return row as Record<string, unknown>;
}

/**
 * 책임: 관측한 크기까지만 로그를 읽고 행과 원본 위치를 전달한다.
 * 알고리즘: 64KiB 이하 청크 안의 완성된 줄 구간만 한 번 디코딩·분할하고 경계 줄은 이어 붙인다. 이미지 제거·Zstd 해제와 미완성 마지막 행 유예를 유지한다.
 */
export async function readJsonl(
  path: string,
  size: number,
  onRow: (row: Record<string, unknown>, offset: number) => void | boolean,
  options: { maxLineBytes?: number; signal?: AbortSignal; isCancelled?: () => boolean; onBytes?: (bytes: number) => void;
    /** Raw file bytes, before image filtering or decompression; valid only during the callback. */
    onChunk?: (chunk: Buffer) => void;
    /** Synchronous processing of at most one chunk; file reads stay outside the callback. */
    processBatch?: (parseRows: () => void) => void } = {},
): Promise<{ partialLine: boolean; bytes: number; rows: number }> {
  const maxLine = options.maxLineBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxLine) || maxLine < 1) throw new RangeError('maxLineBytes must be a positive integer');
  const file = await open(path, 'r');
  const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
  let line: JsonlLine | undefined;
  let read = 0;
  let lineOffset = 0;
  let rows = 0;
  const compressed = path.toLowerCase().endsWith('.jsonl.zst');
  const chunks = async function* (): AsyncGenerator<Buffer> {
    while (read < size) {
      if (options.signal?.aborted || options.isCancelled?.()) throw new SummaryError('interrupted', read);
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - read), read);
      if (!bytesRead) throw new SummaryError('file-truncated-during-read', read);
      read += bytesRead;
      options.onChunk?.(chunk.subarray(0, bytesRead));
      options.onBytes?.(bytesRead);
      // The decoder can prefetch; it must not see a buffer overwritten by the next file read.
      yield compressed ? Buffer.from(chunk.subarray(0, bytesRead)) : chunk.subarray(0, bytesRead);
    }
  };
  try {
    for await (const chunk of compressed ? zstdChunks(chunks()) : chunks()) {
      if (options.signal?.aborted || options.isCancelled?.()) throw new SummaryError('interrupted', read);
      const bytesRead = chunk.length;
      let stopped = false;
      const parseRows = (): void => {
        let completeLines: string[] | undefined;
        let completeIndex = 0;
        let index = 0;
        while (index < bytesRead) {
          const newline = chunk.indexOf(10, index);
          const end = newline < 0 ? bytesRead : newline;
          let text: string | undefined;
          let sourceBytes = end - index;
          if (!line && end < bytesRead) {
            // Decode complete lines once per chunk. Keep split UTF-8 in JsonlLine
            // and derive offsets from the Buffer, even for invalid UTF-8 bytes.
            completeLines ??= chunk.toString('utf8', index, chunk.lastIndexOf(10)).split('\n');
            const candidate = completeLines[completeIndex++].trim();
            // Absence proves there is no image to sanitize. JSON.parse still checks
            // every JSON string/escape; escaped image prefixes were never stripped.
            if (sourceBytes <= maxLine && !/data:image\//i.test(candidate)) text = candidate;
          }
          if (text === undefined) {
            line ??= new JsonlLine(maxLine, lineOffset);
            line.append(chunk, index, end);
            if (end === bytesRead) break;
            text = line.text();
            sourceBytes = line.bytes;
          }
          if (text) {
            const row = parseJsonlObject(text, lineOffset);
            rows++;
            if (onRow(row, lineOffset) === false) { stopped = true; return; }
          }
          lineOffset += sourceBytes + 1;
          line = undefined;
          index = end + 1;
        }
      };
      if (options.processBatch) options.processBatch(parseRows); else parseRows();
      if (stopped) return { partialLine: false, bytes: read, rows };
    }
    return { partialLine: (line?.bytes ?? 0) > 0, bytes: read, rows };
  } catch (error) {
    if (error instanceof ZstdError) throw new SummaryError('decompression-error', lineOffset);
    throw error;
  } finally { await file.close(); }
}
