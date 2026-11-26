// 세션 결제 분류를 저장하고 일별 비용 조회에 사용한다.
import type { SqliteSession } from './connection';
import type { BillingMode, Provider } from './types';

export class SessionBillingStore {
  constructor(private readonly database: SqliteSession) {}

  setSessionBilling(provider: Provider, sessionId: string, mode: BillingMode): void {
    // [결제 정책] 지원하는 제공자와 결제 유형을 확인하고 제공자·세션 키마다 지정값을 하나만 저장한다.
    if (!['claude', 'codex'].includes(provider) || !sessionId || !['subscription', 'api', 'unknown'].includes(mode))
      throw new RangeError('Invalid session billing');
    this.database.statement(`INSERT INTO session_billing VALUES (?, ?, ?)
      ON CONFLICT(provider, session_id) DO UPDATE SET billing_mode = excluded.billing_mode`)
      .run(provider, sessionId, mode);
  }

  sessionBilling(provider: Provider, sessionId: string): BillingMode {
    // [결제 정책] 세션에 직접 지정한 결제 유형을 가장 먼저 적용한다.
    const chosen = this.database.statement('SELECT billing_mode FROM session_billing WHERE provider=? AND session_id=?')
      .get(provider, sessionId)?.billing_mode;
    if (chosen) return chosen as BillingMode;

    // [결제 정책] 저장된 일별 기본 유형의 최솟값과 최댓값이 일치할 때만 해당 유형을 추론한다.
    return this.database.statement(`SELECT CASE
        WHEN MIN(default_billing_mode) = MAX(default_billing_mode) THEN MIN(default_billing_mode) ELSE 'unknown'
      END AS mode FROM usage_request_daily WHERE provider=? AND session_id=?`)
      .get(provider, sessionId)?.mode as BillingMode ?? 'unknown';
  }
}
