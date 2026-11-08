// 요청 서명·의존성 확장·확정 snapshot이 공유하는 범위와 식별 계약을 정의한다.
import type { Provider } from '../types';
import type { SignatureRoot } from '../staging/memoryEvents';

export type MetadataScope = 'component' | 'summary_batch';
export type MetadataDependency = [string, string, string, string];

export interface TurnKey {
  provider: Provider;
  session_id: string;
  root_id: string;
}

export interface ComparedTurn extends TurnKey {
  previous_signature: string | null;
  invalid: number;
}

export interface SourceRoot {
  file: Record<string, unknown>;
  root: SignatureRoot;
}

export const COMMITTED_DIRTY_TURNS = `JOIN turn_metadata a ON a.provider=m.provider AND a.session_id=m.session_id AND a.root_id=m.root_id
      JOIN component c ON c.provider=m.provider AND c.session_id=m.session_id WHERE m.dirty=1`;
