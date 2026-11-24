// 원본을 관측한 byte 경계까지 읽어 파싱 이벤트를 전달한다.
import { lstat } from 'node:fs/promises';
import type { FileMetadata } from '../db/types';
import { readJsonl, SummaryError } from '../jsonl';
import type { JsonShape } from '../jsonl/projection';
import { sqlText } from '../parsers/common';
import type { ParseEvent, ParsedIdentity, SummaryOptions } from '../types';

export type SourceReadFile = Pick<FileMetadata, 'provider' | 'path' | 'source_root' | 'size_bytes' | 'mtime_ms'> & { id: number };

export { sqlText } from '../parsers/common';

export function normalizedIdentity(identity: ParsedIdentity): ParsedIdentity {
  const result = { ...identity };
  for (const [name, value] of Object.entries(result)) if (typeof value === 'string') Reflect.set(result, name, sqlText(value));
  return result;
}

export interface SourceRead {
  identity?: ParsedIdentity;
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

async function readSourceRows(file: SourceReadFile, onRow: (row: Record<string, unknown>, offset: number) => void,
  fields: { shape: JsonShape }, options: Pick<ReadOptions, 'signal' | 'cancelled' | 'maxLineBytes' | 'onBytes'>):
  Promise<Pick<SourceRead, 'rows' | 'partialLine'>> {
  const { rows, partialLine } = await readJsonl(file.path, file.size_bytes, onRow, {
    signal: options.signal, isCancelled: options.cancelled, maxLineBytes: options.maxLineBytes,
    onBytes: options.onBytes, ...fields,
  });
  const after = await lstat(file.path);
  if (!after.isFile() || after.size < file.size_bytes
    || after.size === file.size_bytes && after.mtimeMs !== file.mtime_ms) throw new SummaryError('file-rewritten-during-read');
  return { rows, partialLine };
}

/** 고정 byte 경계의 단일 읽기로 파싱 이벤트를 전달한다. */
export async function readSource(
  file: SourceReadFile,
  event: (value: ParseEvent, index: number) => void,
  options: ReadOptions,
): Promise<SourceRead> {
  const [{ ClaudeParserAdapter, CodexCurrentParserAdapter }, { sourceFields }] = await Promise.all([
    import('../parsers'), import('../parsers/logFields'),
  ]);
  const context = { provider: file.provider, path: file.path, sourceRoot: file.source_root,
    fileId: file.id, collectCapabilities: options.collectCapabilities };
  let index = 0;
  let identity!: ParsedIdentity;
  const sink = { identity: (value: ParsedIdentity) => { identity = value; }, event: (value: ParseEvent) => event(value, index++),
    child: (reference: string, rootId: string) => options.onChild?.(sqlText(reference), sqlText(rootId)) };
  const parser = file.provider === 'claude' ? new ClaudeParserAdapter(context, sink) : new CodexCurrentParserAdapter(context, sink);
  try {
    const result = await readSourceRows(file, (row, offset) => parser.row(row, offset), { shape: sourceFields(file.provider, options.collectCapabilities) }, options);
    if (!result.rows) return result;
    parser.finish();
    return { ...result, identity: normalizedIdentity(identity) };
  } catch (error) {
    const partialIdentity = parser.getIdentity();
    if (partialIdentity) options.onIdentity?.(normalizedIdentity(partialIdentity));
    throw error;
  }
}
