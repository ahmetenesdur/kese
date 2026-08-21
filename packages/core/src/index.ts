/**
 * @kese/core — STRK20 SDK wrapper and shared primitives.
 * See docs/strk20-notes.md §1-§7 for exact APIs & gotchas:
 * - viewing key MUST be bigint; tip: 0n; provingBlockId = head - 10; typed pool Contract for discovery
 * TODO(claude-code, Phase B1): implement KeseWallet with init/register/shield/payPrivate/withdraw/
 * balances/activity by lifting the proven wiring out of scripts/day1-sepolia-smoke.ts.
 */
export * from "./address.js";
export * from "./config.js";
export * from "./fees.js";
export { DEFAULT_DENOMS } from "./notes.js";

export interface Receipt { status: "submitted" | "confirmed" | "failed"; txHash?: string; error?: string }

export interface KeseWallet {
  register(): Promise<Receipt>;
  shield(token: string, amount: bigint): Promise<Receipt>;            // PUBLIC edge — say so in UX
  payPrivate(token: string, amount: bigint, recipient: string): Promise<Receipt>;
  createClaimEscrow(token: string, amount: bigint, commitmentHash: string, expiryBlocks: number): Promise<Receipt>;
  withdraw(token: string, amount: bigint, to: string): Promise<Receipt>; // PUBLIC edge
  balances(tokens: string[]): Promise<Record<string, bigint>>;
  activity(): Promise<unknown[]>; // Deposit-event based — NEVER tx sender (see STRK20_INTEGRATION_PLAN.md §7)
}
