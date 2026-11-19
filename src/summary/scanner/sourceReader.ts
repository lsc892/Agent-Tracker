// 원본을 고정 byte 경계까지 읽어 이벤트를 전달하고 파일 정체성과 내용 해시를 확인한다.
import { lstat, open } from 'node:fs/promises';
import type { FileMetadata } from '../db/types';
import { readJsonl, SummaryError } from '../jsonl';
import { ClaudeParserAdapter, CodexCurrentParserAdapter } from '../parsers';
import type { ParseEvent, ParsedIdentity, SummaryOptions } from '../types';
import { sourceIdentity } from './sourceFingerprint';
import { createSourceHasher } from './sourceHash';

export const sqlText = (value: string): string => /[\ud800-\udfff]/.test(value) ? Buffer.from(value).toString('utf8') : value;

export function normalizedIdentity(identity: ParsedIdentity): ParsedIdentity {
  const result = { ...identity };
  for (const [name, value] of Object.entries(result)) if (typeof value === 'string') Reflect.set(result, name, sqlText(value));
  return result;
}

export interface SourceRead {
  identity?: ParsedIdentity;
  sourceIdentity?: string;
  contentHash: string;
  partialLine: boolean;
  rows: number;
  parsedRows: number;
  resumed: boolean;
  fallback: boolean;
  position: number;
  prefixHash: string;
  parser: Record<string, unknown>;
  ordinal: number;
}

interface ReadOptions {
  signal?: AbortSignal;
  cancelled: () => boolean;
  maxLineBytes?: SummaryOptions['maxLineBytes'];
  collectCapabilities: boolean;
  onBytes: (bytes: number) => void;
  onIdentity?: (identity: ParsedIdentity) => void;
  onChild?: (reference: string, rootId: string) => void;
  checkpoint?: SourceRead;
  onResume?: () => void;
}

/** 고정 byte 경계의 단일 읽기로 winner 선택과 귀속·진단 근거 수집을 함께 수행한다. */
export async function readSource(
  file: FileMetadata & { id: number },
  event: (value: ParseEvent, index: number) => void,
  options: ReadOptions,
): Promise<SourceRead> {
  const context = { provider: file.provider, path: file.path, sourceRoot: file.source_root,
    fileId: file.id, collectCapabilities: options.collectCapabilities };
  let index = 0;
  const sink = { identity() {}, event: (value: ParseEvent) => event(value, index++),
    child: (reference: string, rootId: string) => options.onChild?.(sqlText(reference), sqlText(rootId)) };
  const parser = file.provider === 'claude' ? new ClaudeParserAdapter(context, sink) : new CodexCurrentParserAdapter(context, sink);
  try {
    const before = await lstat(file.path);
    if (!before.isFile() || String(before.dev) !== file.dev
      || String(before.ino) !== file.inode || before.size < file.size_bytes) throw new SummaryError('file-replaced-during-read');
    let digest = createSourceHasher();
    const saved = options.checkpoint;
    const compressed = file.path.toLowerCase().endsWith('.zst');
    let resumed = false;
    if (saved && !compressed && saved.position <= file.size_bytes) {
      const handle = await open(file.path, 'r');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      try {
        let position = 0;
        while (position < saved.position) {
          if (options.signal?.aborted || options.cancelled()) throw new SummaryError('interrupted', position);
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, saved.position - position), position);
          if (!bytesRead) throw new SummaryError('file-truncated-during-read', position);
          digest.update(buffer.subarray(0, bytesRead));
          options.onBytes(bytesRead);
          position += bytesRead;
        }
        resumed = digest.peek() === saved.prefixHash;
      } finally { await handle.close(); }
    }
    if (resumed) {
      parser.restore(saved!.parser);
      index = saved!.ordinal;
      options.onResume?.();
    } else if (saved) digest = createSourceHasher();
    const start = resumed ? saved!.position : 0;
    let position = start;
    let prefixHash = digest.peek();
    const read = resumed && start === file.size_bytes ? { rows: 0, partialLine: false, completeOffset: start }
      : await readJsonl(file.path, file.size_bytes, (row, offset) => parser.row(row, offset), {
      signal: options.signal, isCancelled: options.cancelled, maxLineBytes: options.maxLineBytes,
      startOffset: start,
      onBytes: options.onBytes, onChunk: chunk => {
        const end = compressed ? -1 : chunk.lastIndexOf(10);
        if (end >= 0) {
          digest.update(chunk.subarray(0, end + 1));
          prefixHash = digest.peek();
          digest.update(chunk.subarray(end + 1));
        } else digest.update(chunk);
        position += chunk.length;
      },
    });
    const after = await lstat(file.path);
    if (String(after.dev) !== file.dev || String(after.ino) !== file.inode || after.size < file.size_bytes
      || after.size === file.size_bytes && after.mtimeMs !== file.mtime_ms) throw new SummaryError('file-rewritten-during-read');
    const rows = read.rows + (resumed ? saved!.rows : 0);
    const result: SourceRead = { rows, parsedRows: read.rows, resumed, fallback: Boolean(saved && !resumed),
      partialLine: read.partialLine, position: compressed ? position : read.completeOffset,
      prefixHash: compressed ? digest.peek() : prefixHash, parser: parser.snapshot(), ordinal: index, contentHash: digest.digest() };
    if (!rows) return result;
    parser.finish();
    const identity = parser.getIdentity()!;
    return { ...result, identity: normalizedIdentity(identity), sourceIdentity: sourceIdentity(identity) };
  } catch (error) {
    const identity = parser.getIdentity();
    if (identity) options.onIdentity?.(normalizedIdentity(identity));
    throw error;
  }
}
