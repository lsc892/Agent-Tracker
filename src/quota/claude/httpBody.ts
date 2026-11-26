// Claude HTTP 응답의 크기를 제한하며 JSON 본문을 읽는다.
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
    // [파싱 정책] 청크 크기를 누적해 1MiB를 넘기기 전에 중단하고 다 읽은 본문만 JSON으로 해석한다.
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
    // [종료 정책] 본문 읽기가 실패해도 reader를 취소·해제하고 기존 파싱 오류는 유지한다.
    try { await reader.cancel(); } catch { /* Preserve the safe error above. */ }
    reader.releaseLock();
  }
}
