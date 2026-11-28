// 단일 파일에서 응답 winner·관계 근거 또는 부분 식별 정보가 있는 오류를 만든다.
import { SourceWinners, type SourceWinnersSnapshot } from '../aggregation/sourceWinners';
import { SummaryError } from '../jsonl';
import type { ParsedIdentity } from '../types';
import { readSource, type SourceRead, type SourceReadFile } from './sourceReader';

export interface SourcePreparationOptions {
  collectCapabilities?: boolean;
  maxLineBytes?: number;
  cancelled: () => boolean;
  signal?: AbortSignal;
  onBytes?: (bytes: number) => void;
}
export type SourcePreparation =
  | { ok: true; read: SourceRead; winners: SourceWinnersSnapshot }
  | { ok: false; error: { code: string; offset: number }; identity?: ParsedIdentity };

/** 파일 하나를 파싱해 집계할 응답과 관계 근거를 준비한다. */
export async function prepareSource(file: SourceReadFile, options: SourcePreparationOptions): Promise<SourcePreparation> {
  const winners = new SourceWinners(file.provider);
  let identity: ParsedIdentity | undefined;
  try {
    // 이벤트 순번과 자식 참조를 쌓아 응답별 후보와 귀속 근거를 만든다.
    const read = await readSource(file, (event, index) => winners.add(event, index), {
      ...options,
      collectCapabilities: options.collectCapabilities !== false,
      onIdentity: value => { identity = value; },
      onChild: (reference, rootId) => winners.evidence.child(reference, rootId),
    });
    return { ok: true, read, winners: winners.preparedSnapshot() };
  } catch (error) {
    // 파싱 오류의 코드와 위치를 보존하고, 확보한 세션 식별 정보를 함께 반환한다.
    const failure = error instanceof SummaryError
      ? { code: error.code, offset: error.offset }
      : { code: 'source-read-error', offset: 0 };
    return { ok: false, error: failure, identity };
  }
}
