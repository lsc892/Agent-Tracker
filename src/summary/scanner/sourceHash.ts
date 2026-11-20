// 원본 prefix 검증에 사용하는 고정 크기 스트리밍 해시를 만든다.
import { createHash } from 'node:crypto';

export interface SourceHasher {
  update(chunk: Buffer): unknown;
  peek(): string;
  digest(): string;
}

/** peek는 진행 중인 상태를 소모하지 않아 완성 줄 경계의 해시만 보관할 수 있다. */
export function createSourceHasher(): SourceHasher {
  const hash = createHash('sha256');
  return { update: chunk => hash.update(chunk), peek: () => hash.copy().digest('hex'), digest: () => hash.digest('hex') };
}
