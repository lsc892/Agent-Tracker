// 세션 결제 분류를 저장하고 일별 비용 조회에 사용한다.
import type { SqliteSession } from './connection';
import type { BillingMode, Provider } from './types';

export class SessionBillingStore {
  constructor(private readonly database: SqliteSession) {}

  setSessionBilling(provider: Provider, sessionId: string, mode: BillingMode | null): void {
    // [결제 정책] 지원하는 제공자와 결제 유형을 확인하고 제공자·세션 키마다 지정값을 하나만 저장한다.
    if (!['claude', 'codex'].includes(provider) || !sessionId || (mode !== null && !['subscription', 'api', 'unknown'].includes(mode)))
      throw new RangeError('Invalid session billing');
    const { changes } = this.database.statement('UPDATE sessions SET billing_mode=? WHERE provider=? AND session_id=?')
      .run(mode, provider, sessionId);
    if (!changes) throw new Error('FOREIGN KEY constraint failed');
  }

  sessionBillingOverride(provider: Provider, sessionId: string): BillingMode | null {
    const row = this.database.statement('SELECT billing_mode FROM sessions WHERE provider=? AND session_id=?').get(provider, sessionId);
    return (row?.billing_mode ?? null) as BillingMode | null;
  }

  sessionBilling(provider: Provider, sessionId: string): BillingMode {
    // [결제 정책] 세션에 직접 지정한 결제 유형을 가장 먼저 적용한다.
    const chosen = this.sessionBillingOverride(provider, sessionId);
    if (chosen !== null) return chosen;

    // [결제 정책] 저장된 일별 기본 유형의 최솟값과 최댓값이 일치할 때만 해당 유형을 추론한다.
    return this.database.statement(`SELECT CASE
        WHEN MIN(default_billing_mode) = MAX(default_billing_mode) THEN MIN(default_billing_mode) ELSE 'unknown'
      END AS mode FROM usage_request_daily WHERE provider=? AND session_id=?`)
      .get(provider, sessionId)?.mode as BillingMode ?? 'unknown';
  }
}
