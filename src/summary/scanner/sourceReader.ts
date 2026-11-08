// 원본을 고정 byte 경계까지 읽어 이벤트를 전달하고 파일 정체성과 내용 해시를 확인한다.
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import type { FileMetadata } from '../db/types';
import { readJsonl, SummaryError } from '../jsonl';
import { ClaudeParserAdapter, CodexCurrentParserAdapter } from '../parsers';
import type { ParseEvent, ParsedIdentity, SummaryOptions } from '../types';
import { sourceIdentity } from './sourceFingerprint';

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
  onBytes: (bytes: number) => void;
  onIdentity?: (identity: ParsedIdentity) => void;
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
  const sink = { identity() {}, event: (value: ParseEvent) => event(value, index++) };
  const parser = file.provider === 'claude' ? new ClaudeParserAdapter(context, sink) : new CodexCurrentParserAdapter(context, sink);
  try {
    const before = await lstat(file.path);
    if (!before.isFile() || before.isSymbolicLink() || String(before.dev) !== file.dev
      || String(before.ino) !== file.inode || before.size < file.size_bytes) throw new SummaryError('file-replaced-during-read');
    const digest = createHash('sha256');
    const read = await readJsonl(file.path, file.size_bytes, (row, offset) => parser.row(row, offset), {
      signal: options.signal, isCancelled: options.cancelled, maxLineBytes: options.maxLineBytes,
      onBytes: options.onBytes, onChunk: chunk => { digest.update(chunk); },
    });
    const after = await lstat(file.path);
    if (String(after.dev) !== file.dev || String(after.ino) !== file.inode || after.size < file.size_bytes
      || after.size === file.size_bytes && after.mtimeMs !== file.mtime_ms) throw new SummaryError('file-rewritten-during-read');
    if (!read.rows) return { ...read, contentHash: digest.digest('hex') };
    parser.finish();
    const identity = parser.getIdentity()!;
    return { ...read, identity: normalizedIdentity(identity), sourceIdentity: sourceIdentity(identity), contentHash: digest.digest('hex') };
  } catch (error) {
    const identity = parser.getIdentity();
    if (identity) options.onIdentity?.(normalizedIdentity(identity));
    throw error;
  }
}
