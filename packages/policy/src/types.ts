export type { Address } from "@kese/core";
import type { Address } from "@kese/core";

export interface PaymentRequest {
  idempotencyKey: string; // REQUIRED on every money-moving tool (LLMs retry)
  agentId: string;
  kind: "private_transfer" | "claim_link" | "withdraw";
  token: Address;
  amount: bigint;
  recipient?: Address; // absent for claim_link
  memo?: string;
}

export interface PolicyConfig {
  perTxCap: Record<Address, bigint>; // token -> max per tx
  dailyCap: Record<Address, bigint>; // token -> rolling 24h max
  allowlist: Address[] | "any";
  approvalThreshold: Record<Address, bigint>; // above => needs human approval
  claimLinkDefaultExpiryBlocks: number;
}

/**
 * Why a request was refused. Machine-readable so the MCP layer can phrase it for an LLM and the
 * Telegram message can say which rule fired, without anyone parsing prose.
 */
export type DenyCode =
  | "recipient_not_allowlisted"
  | "per_tx_cap_exceeded"
  | "daily_cap_exceeded"
  | "token_not_configured"
  | "idempotency_key_reused"
  | "invalid_request"
  | "storage_unavailable";

export type Decision =
  | { kind: "allow"; reservationId: string }
  | { kind: "deny"; code: DenyCode; reason: string }
  | { kind: "needs_approval"; ticketId: string; reservationId: string; reason: string };

export interface PolicyEngine {
  /**
   * The only gate to money. Deterministic: same request + same state => same decision.
   *
   * On `allow` and `needs_approval` the spend is already RESERVED against the caps — hard rule 5.
   * The caller MUST finish the lifecycle with commitReservation (chain action succeeded) or
   * releaseReservation (it failed, was denied, or the approval timed out), or the budget stays
   * held until the rolling window slides past it.
   */
  decide(req: PaymentRequest, cfg: PolicyConfig): Promise<Decision>;
  commitReservation(reservationId: string, receiptJson: string): Promise<void>;
  releaseReservation(reservationId: string): Promise<void>;
  /**
   * What became of a reservation.
   *
   * `decide()` remembers the DECISION; this reports whether the money actually moved. A caller
   * replaying an idempotency key gets back a valid reservation from `decide()` and would otherwise
   * execute the payment a second time — the receipt stored at commit time is what makes execution
   * idempotent, not just the decision.
   */
  reservationOutcome(
    reservationId: string
  ): Promise<{ state: "active" | "committed" | "released"; receiptJson?: string } | null>;

  /** How much of a token's rolling 24h budget is still available, for approval context. */
  remainingDaily(token: Address, cfg: PolicyConfig): Promise<bigint>;

  /** Audit view: the decision log, newest first. */
  recentDecisions(limit?: number): Promise<DecisionLogEntry[]>;
  close(): void;
}

export interface DecisionLogEntry {
  at: number;
  idempotencyKey: string;
  agentId: string;
  kind: PaymentRequest["kind"];
  token: Address;
  amount: bigint;
  recipient?: Address;
  /** Free text from the caller — what the payment was for. UNTRUSTED: an LLM writes this. */
  memo?: string;
  decision: Decision["kind"];
  code?: DenyCode;
}
