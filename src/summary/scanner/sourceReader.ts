// 원본을 고정 byte 경계까지 읽어 이벤트를 전달하고 파일 정체성과 내용 해시를 확인한다.
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import type { FileMetadata } from '../db/types';
import { readJsonl, SummaryError } from '../jsonl';
import { ClaudeParserAdapter, CodexCurrentParserAdapter } from '../parsers';
import type { ParseEvent, ParsedIdentity, SummaryOptions } from '../types';
import { sourceIdentity } from './sourceFingerprint';

export type SourceReadFile = Pick<FileMetadata, 'provider' | 'path' | 'source_root' | 'size_bytes' | 'mtime_ms' | 'dev' | 'inode'> & { id: number };

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
}

interface ReadOptions {
  signal?: AbortSignal;
  cancelled: () => boolean;
  maxLineBytes?: SummaryOptions['maxLineBytes'];
  collectCapabilities: boolean;
  onBytes?: (bytes: number) => void;
  onIdentity?: (identity: ParsedIdentity) => void;
  onChild?: (reference: string, rootId: string) => void;
}

function isObservedSource(file: SourceReadFile, stat: Stats): boolean {
  const truncated = stat.size < file.size_bytes;
  return String(stat.dev) === file.dev && String(stat.ino) === file.inode && !truncated;
}

/** 고정 byte 경계의 단일 읽기로 winner 선택과 귀속·진단 근거 수집을 함께 수행한다. */
export async function readSource(
  file: SourceReadFile,
  event: (value: ParseEvent, index: number) => void,
  options: ReadOptions,
): Promise<SourceRead> {
  const context = { provider: file.provider, path: file.path, sourceRoot: file.source_root,
    fileId: file.id, collectCapabilities: options.collectCapabilities };
  let index = 0;
  let identity!: ParsedIdentity;
  const sink = { identity: (value: ParsedIdentity) => { identity = value; }, event: (value: ParseEvent) => event(value, index++),
    child: (reference: string, rootId: string) => options.onChild?.(sqlText(reference), sqlText(rootId)) };
  const parser = file.provider === 'claude' ? new ClaudeParserAdapter(context, sink) : new CodexCurrentParserAdapter(context, sink);
  try {
    const before = await lstat(file.path);
    if (!before.isFile() || !isObservedSource(file, before)) throw new SummaryError('file-replaced-during-read');
    const digest = createHash('sha256');
    const read = await readJsonl(file.path, file.size_bytes, (row, offset) => parser.row(row, offset), {
      signal: options.signal, isCancelled: options.cancelled, maxLineBytes: options.maxLineBytes,
      onBytes: options.onBytes, onChunk: chunk => { digest.update(chunk); },
    });
    const after = await lstat(file.path);
    if (!isObservedSource(file, after)
      || after.size === file.size_bytes && after.mtimeMs !== file.mtime_ms) throw new SummaryError('file-rewritten-during-read');
    const result: SourceRead = { rows: read.rows, partialLine: read.partialLine, contentHash: digest.digest('hex') };
    if (!read.rows) return result;
    parser.finish();
    return { ...result, identity: normalizedIdentity(identity), sourceIdentity: sourceIdentity(identity) };
  } catch (error) {
    const partialIdentity = parser.getIdentity();
    if (partialIdentity) options.onIdentity?.(normalizedIdentity(partialIdentity));
    throw error;
  }
}
