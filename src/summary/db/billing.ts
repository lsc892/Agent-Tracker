// 세션 결제 분류와 요청별 비용을 저장하고 사용자 선택에 따라 재계산한다.
import type { SQLInputValue } from 'node:sqlite';
import type { SqliteSession } from './connection';
import type { BillingMode, Provider } from './types';
import { PRICING_VERSION } from '../models/pricing';

const COST_AGGREGATES = `
  CASE WHEN ? = 'subscription' THEN 0 WHEN ? = 'api' THEN sum(estimated_cost_usd) END,
  CASE
    WHEN ? = 'subscription' THEN 0
    WHEN ? = 'api' THEN max(1, count(*)) - count(estimated_cost_usd)
    ELSE max(1, count(*))
  END`;

/** 세션의 결제 분류를 관리하고 모델별 추정 비용을 요청 비용으로 저장한다. */
export class SessionBillingStore {
  constructor(private readonly database: SqliteSession) {}

  saveTurnCost(id: SQLInputValue, mode: BillingMode): void {
    this.database.statement(`INSERT OR REPLACE INTO turn_costs
      SELECT ?, ?, ${COST_AGGREGATES}, ?
      FROM turn_model_usage
      WHERE turn_id = ?`)
      .run(id, mode, mode, mode, mode, mode, PRICING_VERSION, id);
  }

  /**
   * 책임: 사용자가 지정한 결제 방식을 세션의 기존 요청 비용에 반영한다.
   * 알고리즘: 범위·모드를 검증하고 선택 저장과 세션 요청별 비용 집계를 같은 트랜잭션에서 수행한다.
   */
  setSessionBilling(provider: Provider, sessionId: string, mode: BillingMode): void {
    if (!['claude','codex'].includes(provider) || !sessionId || !['subscription','api','unknown'].includes(mode)) throw new RangeError('Invalid session billing');
    this.database.transaction(() => {
      this.database.statement(`INSERT INTO session_billing VALUES (?, ?, ?)
        ON CONFLICT(provider, session_id) DO UPDATE SET billing_mode = excluded.billing_mode`)
        .run(provider, sessionId, mode);
      this.database.statement(`INSERT OR REPLACE INTO turn_costs
        SELECT t.id, ?, ${COST_AGGREGATES}, ?
        FROM turn_summary t
        LEFT JOIN turn_model_usage u ON u.turn_id = t.id
        WHERE t.provider = ? AND t.session_id = ?
        GROUP BY t.id`)
        .run(mode, mode, mode, mode, mode, PRICING_VERSION, provider, sessionId);
    });
  }

  sessionBilling(provider: Provider, sessionId: string): BillingMode {
    const chosen = this.database.statement('SELECT billing_mode FROM session_billing WHERE provider=? AND session_id=?')
      .get(provider,sessionId)?.billing_mode as BillingMode | undefined;
    if (chosen) return chosen;
    return this.database.statement(`SELECT CASE
        WHEN count(*) = count(c.billing_mode) AND min(c.billing_mode) = max(c.billing_mode) THEN min(c.billing_mode)
        ELSE 'unknown'
      END AS mode
      FROM turn_summary t
      LEFT JOIN turn_costs c ON c.turn_id = t.id
      WHERE t.provider = ? AND t.session_id = ?`)
      .get(provider, sessionId)?.mode as BillingMode ?? 'unknown';
  }
}
