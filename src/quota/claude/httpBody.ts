import { QuotaError } from '../types';

/**
 * 책임: 응답 크기를 제한하면서 Claude JSON 본문을 읽는다.
 * 알고리즘: 스트림 청크의 누적 크기가 1MiB를 넘으면 중단하고 완료 후 파싱하며, finally에서 reader를 취소·해제한다.
 */
export async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new QuotaError('protocol', { key: 'quota.claudeEmptyResponse' });
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1_048_576) throw new QuotaError('protocol', { key: 'quota.claudeResponseTooLarge' });
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new QuotaError('protocol', { key: 'quota.claudeInvalidJson' }); }
  } finally {
    try { await reader.cancel(); } catch { /* Preserve the safe error above. */ }
    reader.releaseLock();
  }
}
