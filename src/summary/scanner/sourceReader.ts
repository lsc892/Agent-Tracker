// 원본을 관측한 byte 경계까지 읽어 파싱 이벤트를 전달한다.
import { lstat } from 'node:fs/promises';
import type { FileMetadata } from '../db/types';
import { readJsonl, SummaryError } from '../jsonl';
import type { FixedJsonShape, JsonShape } from '../jsonl/projection';
import { sqlText } from '../parsers/common';
import { ThreadLogParser, threadFields, type ThreadLog } from '../parsers/threadUsage';
import type { ParseEvent, ParsedIdentity, SummaryOptions } from '../types';

export type SourceReadFile = Pick<FileMetadata, 'provider' | 'path' | 'source_root' | 'mtime_ms'> & { id: number; size_bytes: number };

export { sqlText } from '../parsers/common';

export function normalizedIdentity(identity: ParsedIdentity): ParsedIdentity {
  // [DTO 정책] 식별자 객체를 복사한 뒤 문자열 필드를 SQLite와 같은 UTF-8로 맞춘다.
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
  fields: { shape: JsonShape } | { fixedShape: FixedJsonShape }, options: Pick<ReadOptions, 'signal' | 'cancelled' | 'maxLineBytes' | 'onBytes'>):
  Promise<Pick<SourceRead, 'rows' | 'partialLine'>> {
  const { rows, partialLine } = await readJsonl(file.path, file.size_bytes, onRow, {
    signal: options.signal, isCancelled: options.cancelled, maxLineBytes: options.maxLineBytes,
    onBytes: options.onBytes, ...fields,
  });
  // [검증 정책] 읽은 뒤 파일 크기·수정 시각을 확인해 축소나 같은 크기의 변경을 오류로 처리한다.
  const after = await lstat(file.path);
  if (!after.isFile() || after.size < file.size_bytes
    || after.size === file.size_bytes && after.mtimeMs !== file.mtime_ms) throw new SummaryError('file-rewritten-during-read');
  return { rows, partialLine };
}

export interface ThreadSourceRead {
  partialLine: boolean;
  thread?: ThreadLog;
}

export async function readThreadSource(file: SourceReadFile, options: Pick<ReadOptions,
  'signal' | 'cancelled' | 'maxLineBytes' | 'onBytes'> & { onFailedSession: (sessionId: string) => void }): Promise<ThreadSourceRead> {
  // [파싱 정책] 제공자별 고정 필드로 관측한 범위만 읽고 완성한 행이 있을 때 스레드를 확정한다.
  const parser = new ThreadLogParser(file.provider, file.path, file.source_root);
  try {
    const { rows, partialLine } = await readSourceRows(file, (row, offset) => parser.row(row, offset), { fixedShape: threadFields[file.provider] }, options);
    if (!rows) return { partialLine };
    return { partialLine, thread: parser.finish() };
  } catch (error) {
    // [진단 정책] 파싱에 실패해도 앞에서 읽은 세션 ID를 진단에 전달한다.
    const identity = parser.identity();
    if (identity) options.onFailedSession(identity.sessionId);
    throw error;
  }
}

/** 기존 응답별 파서를 쓰는 진단 도구에 파싱 이벤트를 전달한다. */
export async function readSource(
  file: SourceReadFile,
  event: (value: ParseEvent, index: number) => void,
  options: ReadOptions,
): Promise<SourceRead> {
  // [파싱 정책] 제공자별 파서와 필드 선택기를 필요할 때 불러온다.
  const [{ ClaudeParserAdapter, CodexCurrentParserAdapter }, { sourceFields }] = await Promise.all([
    import('../parsers'), import('../parsers/logFields'),
  ]);
  const context = { provider: file.provider, path: file.path, sourceRoot: file.source_root,
    fileId: file.id, collectCapabilities: options.collectCapabilities };
  let index = 0;
  let identity!: ParsedIdentity;
  // [DTO 정책] 원본 내 이벤트 순번을 붙이고 자식 참조는 저장용 문자열로 정규화한다.
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
