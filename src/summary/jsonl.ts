import { open } from 'node:fs/promises';

export class SummaryError extends Error {
  constructor(public readonly code: string, public readonly offset = 0) { super(code); }
}

/** Reads only the observed snapshot, retaining at most one bounded line and one chunk. */
export async function readJsonl(
  path: string,
  size: number,
  onRow: (row: Record<string, unknown>, offset: number) => void | boolean,
  options: { maxLineBytes?: number; signal?: AbortSignal; isCancelled?: () => boolean; onBytes?: (bytes: number) => void;
    /** Synchronous processing of at most one chunk; file reads stay outside the callback. */
    processBatch?: (parseRows: () => void) => void } = {},
): Promise<{ partialLine: boolean; bytes: number; rows: number }> {
  const maxLine = options.maxLineBytes ?? 4 * 1024 * 1024;
  const file = await open(path, 'r');
  const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
  let pending = Buffer.alloc(0);
  let read = 0;
  let lineOffset = 0;
  let rows = 0;
  try {
    while (read < size) {
      if (options.signal?.aborted || options.isCancelled?.()) throw new SummaryError('interrupted', read);
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - read), read);
      if (!bytesRead) throw new SummaryError('file-truncated-during-read', read);
      read += bytesRead;
      options.onBytes?.(bytesRead);
      let start = 0;
      let stopped = false;
      const parseRows = (): void => {
        for (let index = 0; index < bytesRead; index++) {
          if (chunk[index] !== 10) continue;
          const tail = chunk.subarray(start, index);
          if (pending.length + tail.length > maxLine) throw new SummaryError('line-byte-budget-exceeded', lineOffset);
          const line = pending.length ? Buffer.concat([pending, tail]) : tail;
          const text = line.toString('utf8').trim();
          if (text) {
            let row: unknown;
            try { row = JSON.parse(text); } catch { throw new SummaryError('parse-error', lineOffset); }
            if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SummaryError('unsupported-schema', lineOffset);
            rows++;
            if (onRow(row as Record<string, unknown>, lineOffset) === false) { stopped = true; return; }
          }
          lineOffset += pending.length + tail.length + 1;
          pending = Buffer.alloc(0);
          start = index + 1;
        }
      };
      if (options.processBatch) options.processBatch(parseRows); else parseRows();
      if (stopped) return {partialLine:false,bytes:read,rows};
      if (start < bytesRead) {
        if (pending.length + bytesRead - start > maxLine) throw new SummaryError('line-byte-budget-exceeded', lineOffset);
        pending = Buffer.concat([pending, chunk.subarray(start, bytesRead)]);
      }
    }
    return { partialLine: pending.length > 0, bytes: read, rows };
  } finally { await file.close(); }
}
