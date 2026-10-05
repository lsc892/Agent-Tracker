import { open } from 'node:fs/promises';

export class SummaryError extends Error {
  constructor(public readonly code: string, public readonly offset = 0) { super(code); }
}

/** Keeps bounded JSON blocks while discarding inline image bodies before JSON.parse. */
class JsonlLine {
  private readonly blocks: Buffer[] = [];
  private block: Buffer;
  private used = 0;
  private length = 0;
  private inString = false;
  private escaped = false;
  private unicode = 0;
  private probe: string | undefined;
  private image = false;
  bytes = 0;

  constructor(private readonly maxBytes: number, private readonly offset: number) {
    this.block = Buffer.allocUnsafe(Math.min(1024, maxBytes));
  }

  append(byte: number): void {
    this.bytes++;
    let retain = true;
    if (this.inString) {
      if (this.image) {
        // JSON.parse cannot validate discarded bytes. Preserve its string escape/control checks here.
        retain = false;
        if (byte < 32) throw new SummaryError('parse-error', this.offset);
        if (this.unicode) {
          if (!((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102))) {
            throw new SummaryError('parse-error', this.offset);
          }
          this.unicode--;
        } else if (this.escaped) {
          if (byte === 117) this.unicode = 4;
          else if (![34, 47, 92, 98, 102, 110, 114, 116].includes(byte)) throw new SummaryError('parse-error', this.offset);
          this.escaped = false;
        } else if (byte === 92) this.escaped = true;
        else if (byte === 34) { this.inString = false; this.image = false; retain = true; }
      } else if (this.escaped) { this.escaped = false; this.probe = undefined; }
      else if (byte === 92) { this.escaped = true; this.probe = undefined; }
      else if (byte === 34) { this.inString = false; this.probe = undefined; }
      else if (this.probe !== undefined) {
        this.probe += String.fromCharCode(byte);
        const prefix = 'data:image/';
        if ((this.probe.length <= prefix.length && !prefix.startsWith(this.probe.toLowerCase())) || this.probe.length > 256) {
          this.probe = undefined;
        } else if (byte === 44) {
          this.image = /^data:image\/[^,]+;base64,$/i.test(this.probe);
          this.probe = undefined;
        }
      }
    } else if (byte === 34) { this.inString = true; this.probe = ''; }
    if (!retain) return;
    if (this.length >= this.maxBytes) throw new SummaryError('line-byte-budget-exceeded', this.offset);
    if (this.used === this.block.length) {
      this.blocks.push(this.block);
      this.block = Buffer.allocUnsafe(Math.min(64 * 1024, this.maxBytes - this.length));
      this.used = 0;
    }
    this.block[this.used++] = byte;
    this.length++;
  }

  text(): string {
    return Buffer.concat([...this.blocks, this.block.subarray(0, this.used)], this.length).toString('utf8').trim();
  }
}

/** Reads only the observed snapshot; the line budget excludes discarded image bodies. */
export async function readJsonl(
  path: string,
  size: number,
  onRow: (row: Record<string, unknown>, offset: number) => void | boolean,
  options: { maxLineBytes?: number; signal?: AbortSignal; isCancelled?: () => boolean; onBytes?: (bytes: number) => void;
    /** Synchronous processing of at most one chunk; file reads stay outside the callback. */
    processBatch?: (parseRows: () => void) => void } = {},
): Promise<{ partialLine: boolean; bytes: number; rows: number }> {
  const maxLine = options.maxLineBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxLine) || maxLine < 1) throw new RangeError('maxLineBytes must be a positive integer');
  const file = await open(path, 'r');
  const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
  let line = new JsonlLine(maxLine, 0);
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
      let stopped = false;
      const parseRows = (): void => {
        for (let index = 0; index < bytesRead; index++) {
          if (chunk[index] !== 10) { line.append(chunk[index]); continue; }
          const text = line.text();
          if (text) {
            let row: unknown;
            try { row = JSON.parse(text); } catch { throw new SummaryError('parse-error', lineOffset); }
            if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SummaryError('unsupported-schema', lineOffset);
            rows++;
            if (onRow(row as Record<string, unknown>, lineOffset) === false) { stopped = true; return; }
          }
          lineOffset += line.bytes + 1;
          line = new JsonlLine(maxLine, lineOffset);
        }
      };
      if (options.processBatch) options.processBatch(parseRows); else parseRows();
      if (stopped) return {partialLine:false,bytes:read,rows};
    }
    return { partialLine: line.bytes > 0, bytes: read, rows };
  } finally { await file.close(); }
}
