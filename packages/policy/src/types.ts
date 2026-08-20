export type Address = string;

export interface PaymentRequest {
  idempotencyKey: string;       // REQUIRED on every money-moving tool (LLMs retry)
  agentId: string;
  kind: "private_transfer" | "claim_link" | "withdraw";
  token: Address;
  amount: bigint;
  recipient?: Address;          // absent for claim_link
  memo?: string;
}

export interface PolicyConfig {
  perTxCap: Record<Address, bigint>;      // token -> max per tx
  dailyCap: Record<Address, bigint>;      // token -> rolling 24h max
  allowlist: Address[] | "any";
  approvalThreshold: Record<Address, bigint>; // above => needs human approval
  claimLinkDefaultExpiryBlocks: number;
}

export type Decision =
  | { kind: "allow"; reservationId: string }
  | { kind: "deny"; reason: string }
  | { kind: "needs_approval"; ticketId: string; reservationId: string };
