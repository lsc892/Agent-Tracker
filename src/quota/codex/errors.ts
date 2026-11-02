// Codex 프로토콜 실패와 조회 취소에 사용할 공통 quota 오류를 생성한다.
import { QuotaError } from '../types';

export function protocolError(): QuotaError { return new QuotaError('protocol', { key: 'quota.codexUnsupportedResponse' }); }
export function cancelled(): QuotaError { return new QuotaError('cancelled', { key: 'quota.codexCancelled' }); }
