import type { SQLInputValue } from 'node:sqlite';
import type { SqliteSession } from './connection';
import type { BillingMode, Provider } from './types';
import { PRICING_VERSION } from '../pricing';

/** Classifies model estimates using a session's billing choice and preserves unknown costs. */
export class SessionBillingStore {
  constructor(private readonly database: SqliteSession) {}

  saveTurnCost(id: SQLInputValue, mode: BillingMode): void {
    this.database.statement(`INSERT OR REPLACE INTO turn_costs
      SELECT ?, ?,
        CASE WHEN ? = 'subscription' THEN 0 WHEN ? = 'api' THEN sum(estimated_cost_usd) END,
        CASE
          WHEN ? = 'subscription' THEN 0
          WHEN ? = 'api' THEN max(1, count(*)) - count(estimated_cost_usd)
          ELSE max(1, count(*))
        END, ?
      FROM turn_model_usage
      WHERE turn_id = ?`)
      .run(id, mode, mode, mode, mode, mode, PRICING_VERSION, id);
  }

  setSessionBilling(provider: Provider, sessionId: string, mode: BillingMode): void {
    if (!['claude','codex'].includes(provider) || !sessionId || !['subscription','api','unknown'].includes(mode)) throw new RangeError('Invalid session billing');
    this.database.transaction(() => {
      this.database.statement(`INSERT INTO session_billing VALUES (?, ?, ?)
        ON CONFLICT(provider, session_id) DO UPDATE SET billing_mode = excluded.billing_mode`)
        .run(provider, sessionId, mode);
      // Page through ids to keep historical classification bounded, including large sessions.
      let after = 0;
      while (true) {
        const turns = this.database.statement('SELECT id FROM turn_summary WHERE provider=? AND session_id=? AND id>? ORDER BY id LIMIT 100')
          .all(provider,sessionId,after) as {id:number}[];
        if (!turns.length) break;
        for (const turn of turns) this.saveTurnCost(turn.id,mode);
        after = turns[turns.length-1].id;
      }
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
