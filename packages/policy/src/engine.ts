import type { Decision, PaymentRequest, PolicyConfig } from "./types.js";

/**
 * Deterministic policy core. HARD RULES (CLAUDE.md):
 * - every money path goes through decide(); no bypass
 * - reservations are taken ATOMICALLY (single SQLite tx) before any chain action
 * - idempotency: same key => return stored outcome, never re-execute
 * - fail closed on any storage/approval-channel error
 *
 * TODO(claude-code): implement with better-sqlite3:
 *   tables: reservations(id, token, amount, created_at, state),
 *           idempotency(key, request_hash, outcome_json),
 *           decisions_log(ts, request_json, decision_json)   // audit trail
 *   decide(): idempotency check -> allowlist -> perTxCap -> (SUM(active+committed last 24h)+amount) <= dailyCap
 *             -> approvalThreshold => needs_approval + ticket
 *   commitReservation(id, receipt) / releaseReservation(id)
 */
export interface PolicyEngine {
  decide(req: PaymentRequest, cfg: PolicyConfig): Promise<Decision>;
  commitReservation(reservationId: string, receiptJson: string): Promise<void>;
  releaseReservation(reservationId: string): Promise<void>;
}
