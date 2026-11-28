// 이전 집계 API에서 사용한 응답 반영값의 호환 타입.
import type { TokenVector } from '../types';
import type { Provider } from './types';

export interface AppliedResponse {
  provider: Provider;
  sessionId: string;
  responseKey: string;
  rootId: string;
  tokens: Pick<TokenVector, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>;
}
