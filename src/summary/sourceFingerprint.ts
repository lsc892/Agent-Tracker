// 파싱된 원본 식별자와 내용 해시로 이동한 로그의 기존 snapshot 포함 여부를 검증한다.
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import type { FileMetadata } from './db/types';
import type { ParsedIdentity } from './types';
import { SummaryError } from './jsonl';

export function sourceIdentity(identity: ParsedIdentity): string {
  return JSON.stringify([identity.threadId, identity.isMain]);
}

/** Verify the entire accepted snapshot, allowing only an appended suffix at the new path. */
export async function includesSourceSnapshot(
  current: FileMetadata,
  previous: FileMetadata,
  options: { check: () => void; onBytes: (bytes: number) => void },
): Promise<boolean> {
  if (!current.content_hash || !previous.content_hash || previous.size_bytes <= 0 || previous.size_bytes > current.size_bytes) return false;
  if (previous.size_bytes === current.size_bytes) return previous.content_hash === current.content_hash;
  const file = await open(current.path, 'r');
  try {
    const digest = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < current.size_bytes) {
      options.check();
      const boundary = position < previous.size_bytes ? previous.size_bytes : current.size_bytes;
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, boundary - position), position);
      if (!bytesRead) throw new SummaryError('file-truncated-during-read', position);
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
      options.onBytes(bytesRead);
      if (position === previous.size_bytes && digest.copy().digest('hex') !== previous.content_hash) return false;
    }
    const after = await lstat(current.path);
    if (!after.isFile() || after.isSymbolicLink() || String(after.dev) !== current.dev || String(after.ino) !== current.inode
        || after.size < current.size_bytes || after.size === current.size_bytes && after.mtimeMs !== current.mtime_ms
        || digest.digest('hex') !== current.content_hash) throw new SummaryError('file-rewritten-during-read');
    return true;
  } finally { await file.close(); }
}
