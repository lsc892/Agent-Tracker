// 단일 파일에서 스레드 합계 또는 부분 식별 정보가 있는 오류를 만든다.
import { SummaryError } from '../jsonl';
import type { ThreadIdentity } from '../parsers/threadUsage';
import { readThreadSource, type ThreadSourceRead, type SourceReadFile } from './sourceReader';

export interface SourcePreparationOptions {
  maxLineBytes?: number;
  cancelled: () => boolean;
  signal?: AbortSignal;
  onBytes?: (bytes: number) => void;
}
export type SourcePreparation =
  | { ok: true; read: ThreadSourceRead }
  | { ok: false; error: { code: string; offset: number }; identity?: ThreadIdentity };

/** 파일을 처음부터 파싱하고 오류도 값으로 반환한다. */
export async function prepareSource(file: SourceReadFile, options: SourcePreparationOptions): Promise<SourcePreparation> {
  let identity: ThreadIdentity | undefined;
  try {
    const read = await readThreadSource(file, {
      ...options,
      onIdentity: value => { identity = value; },
    });
    return { ok: true, read };
  } catch (error) {
    const failure = error instanceof SummaryError
      ? { code: error.code, offset: error.offset }
      : { code: 'source-read-error', offset: 0 };
    return { ok: false, error: failure, identity };
  }
}
