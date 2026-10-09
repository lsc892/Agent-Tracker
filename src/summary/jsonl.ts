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

  append(chunk: Buffer, start: number, end: number): void {
    this.bytes += end - start;
    // Cache the next delimiter: searching the entire remaining chunk for an absent
    // backslash again for every string would make quote-heavy input quadratic.
    const search = chunk.subarray(0, end);
    const find = (byte: number, from: number): number => {
      const found = search.indexOf(byte, from);
      return found < 0 || found > end ? end : found;
    };
    let quote = find(34, start);
    let escape = find(92, start);
    let index = start;
    while (index < end) {
      if (this.probe !== undefined || this.escaped || this.unicode) {
        this.appendByte(chunk[index++]);
        continue;
      }
      if (quote < index) quote = find(34, index);
      if (escape < index) escape = find(92, index);
      const boundary = this.inString ? Math.min(quote, escape) : quote;
      if (boundary > index) {
        if (this.image) {
          // Discard without retaining Base64; JSON.parse cannot check these bytes.
          if (/[\x00-\x1f]/.test(chunk.toString('latin1', index, boundary))) throw new SummaryError('parse-error', this.offset);
        } else this.retain(chunk, index, boundary);
        index = boundary;
      } else this.appendByte(chunk[index++]);
    }
  }

  private retain(chunk: Buffer, start: number, end: number): void {
    if (end - start > this.maxBytes - this.length) throw new SummaryError('line-byte-budget-exceeded', this.offset);
    while (start < end) {
      if (this.used === this.block.length) this.nextBlock();
      const count = Math.min(end - start, this.block.length - this.used);
      chunk.copy(this.block, this.used, start, start + count);
      start += count;
      this.used += count;
      this.length += count;
    }
  }

  private nextBlock(): void {
    this.blocks.push(this.block);
    this.block = Buffer.allocUnsafe(Math.min(64 * 1024, this.maxBytes - this.length));
    this.used = 0;
  }

  private appendByte(byte: number): void {
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
    if (this.used === this.block.length) this.nextBlock();
    this.block[this.used++] = byte;
    this.length++;
  }

  text(): string {
    const tail = this.block.subarray(0, this.used);
    return (this.blocks.length ? Buffer.concat([...this.blocks, tail], this.length) : tail).toString('utf8').trim();
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
  let line: JsonlLine | undefined;
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
        let index = 0;
        while (index < bytesRead) {
          const newline = chunk.indexOf(10, index);
          const end = newline < 0 || newline >= bytesRead ? bytesRead : newline;
          let text: string | undefined;
          let sourceBytes = end - index;
          if (!line && end < bytesRead && sourceBytes <= maxLine) {
            const candidate = chunk.toString('utf8', index, end).trim();
            // Absence proves there is no image to sanitize. JSON.parse still checks
            // every JSON string/escape; escaped image prefixes were never stripped.
            if (!/data:image\//i.test(candidate)) text = candidate;
          }
          if (text === undefined) {
            line ??= new JsonlLine(maxLine, lineOffset);
            line.append(chunk, index, end);
            if (end === bytesRead) break;
            text = line.text();
            sourceBytes = line.bytes;
          }
          if (text) {
            let row: unknown;
            try { row = JSON.parse(text); } catch { throw new SummaryError('parse-error', lineOffset); }
            if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SummaryError('unsupported-schema', lineOffset);
            rows++;
            if (onRow(row as Record<string, unknown>, lineOffset) === false) { stopped = true; return; }
          }
          lineOffset += sourceBytes + 1;
          line = undefined;
          index = end + 1;
        }
      };
      if (options.processBatch) options.processBatch(parseRows); else parseRows();
      if (stopped) return {partialLine:false,bytes:read,rows};
    }
    return { partialLine: (line?.bytes ?? 0) > 0, bytes: read, rows };
  } finally { await file.close(); }
}
