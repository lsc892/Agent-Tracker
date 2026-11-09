// 단일 파일을 읽어 원본별 winner·관계 근거 또는 부분 식별 정보가 있는 오류를 만든다.
import { performance } from 'node:perf_hooks';
import { SourceWinners, type SourceWinnersSnapshot } from '../aggregation/sourceWinners';
import type { FileMetadata } from '../db/types';
import { SummaryError } from '../jsonl';
import type { ParsedIdentity } from '../types';
import { readSource, type SourceRead } from './sourceReader';

export type SourceFile = FileMetadata & { id: number };
export interface SourcePreparationOptions {
  collectCapabilities: boolean;
  maxLineBytes?: number;
  cancelled: () => boolean;
  signal?: AbortSignal;
  onBytes?: (bytes: number) => void;
}
export type SourcePreparation = {
  bytes: number;
  elapsedMs: number;
} & ({ ok: true; read: SourceRead; winners: SourceWinnersSnapshot }
  | { ok: false; error: { code: string; offset: number }; identity?: ParsedIdentity });

/** 읽기·파싱·해시·winner 선택은 파일 안에서 끝내고 오류도 값으로 반환한다. */
export async function prepareSource(file: SourceFile, options: SourcePreparationOptions): Promise<SourcePreparation> {
  const startedAtMs = performance.now();
  const winners = new SourceWinners(file.provider);
  let bytes = 0;
  let identity: ParsedIdentity | undefined;
  try {
    const read = await readSource(file, (event, index) => winners.add(event, index), {
      ...options,
      onBytes: count => {
        bytes += count;
        options.onBytes?.(count);
      },
      onIdentity: value => { identity = value; },
      onChild: (reference, rootId) => winners.evidence.child(reference, rootId),
    });
    return { ok: true, read, winners: winners.snapshot(), bytes, elapsedMs: performance.now() - startedAtMs };
  } catch (error) {
    const failure = error instanceof SummaryError ? error : new SummaryError('source-read-error');
    return { ok: false, error: { code: failure.code, offset: failure.offset }, identity,
      bytes, elapsedMs: performance.now() - startedAtMs };
  }
}
