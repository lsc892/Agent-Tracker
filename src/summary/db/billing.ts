// 세션 결제 분류를 저장하고 일별 비용 조회에 사용한다.
import type { SqliteSession } from './connection';
import type { BillingMode, Provider } from './types';

export class SessionBillingStore {
  constructor(private readonly database: SqliteSession) {}

  setSessionBilling(provider: Provider, sessionId: string, mode: BillingMode): void {
    if (!['claude', 'codex'].includes(provider) || !sessionId || !['subscription', 'api', 'unknown'].includes(mode))
      throw new RangeError('Invalid session billing');
    this.database.statement(`INSERT INTO session_billing VALUES (?, ?, ?)
      ON CONFLICT(provider, session_id) DO UPDATE SET billing_mode = excluded.billing_mode`)
      .run(provider, sessionId, mode);
  }

  sessionBilling(provider: Provider, sessionId: string): BillingMode {
    const chosen = this.database.statement('SELECT billing_mode FROM session_billing WHERE provider=? AND session_id=?')
      .get(provider, sessionId)?.billing_mode;
    if (chosen) return chosen as BillingMode;
    return this.database.statement(`SELECT CASE
        WHEN MIN(default_billing_mode) = MAX(default_billing_mode) THEN MIN(default_billing_mode) ELSE 'unknown'
      END AS mode FROM usage_request_daily WHERE provider=? AND session_id=?`)
      .get(provider, sessionId)?.mode as BillingMode ?? 'unknown';
  }
}
