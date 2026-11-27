// 단일 파일에서 응답 winner·관계 근거 또는 부분 식별 정보가 있는 오류를 만든다.
import { SourceWinners, type SourceWinnersSnapshot } from '../aggregation/sourceWinners';
import { SummaryError } from '../jsonl';
import type { ParsedIdentity } from '../types';
import { readSource, type SourceRead, type SourceReadFile } from './sourceReader';

export interface SourcePreparationOptions {
  maxLineBytes?: number;
  cancelled: () => boolean;
  signal?: AbortSignal;
  onBytes?: (bytes: number) => void;
}
export type SourcePreparation =
  | { ok: true; read: SourceRead; winners: SourceWinnersSnapshot }
  | { ok: false; error: { code: string; offset: number }; identity?: ParsedIdentity };

/** 파일을 처음부터 파싱하고 오류도 값으로 반환한다. */
export async function prepareSource(file: SourceReadFile, options: SourcePreparationOptions): Promise<SourcePreparation> {
  const winners = new SourceWinners(file.provider);
  let identity: ParsedIdentity | undefined;
  try {
    const read = await readSource(file, (event, index) => winners.add(event, index), {
      ...options,
      collectCapabilities: false,
      onIdentity: value => { identity = value; },
      onChild: (reference, rootId) => winners.evidence.child(reference, rootId),
    });
    return { ok: true, read, winners: winners.preparedSnapshot() };
  } catch (error) {
    const failure = error instanceof SummaryError
      ? { code: error.code, offset: error.offset }
      : { code: 'source-read-error', offset: 0 };
    return { ok: false, error: failure, identity };
  }
}
