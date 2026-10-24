import { QuotaError } from '../types';

export function protocolError(): QuotaError { return new QuotaError('protocol', { key: 'quota.codexUnsupportedResponse' }); }
export function cancelled(): QuotaError { return new QuotaError('cancelled', { key: 'quota.codexCancelled' }); }
