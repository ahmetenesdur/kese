/**
 * @kese/core — STRK20 SDK wrapper. See docs/strk20-notes.md §1-§7 for exact APIs & gotchas:
 * - viewing key MUST be bigint; tip: 0n; provingBlockId = head - 10; ContractDiscoveryProvider default
 * TODO(claude-code): implement KeseWallet with init/register/shield/payPrivate/withdraw/balances/activity
 * using createPrivateTransfers builder chain (build -> with(token, t=>...) -> execute({provingBlockId})).
 */
export interface Receipt { status: "submitted" | "confirmed" | "failed"; txHash?: string; error?: string }

export interface KeseWallet {
  register(): Promise<Receipt>;
  shield(token: string, amount: bigint): Promise<Receipt>;            // PUBLIC edge — say so in UX
  payPrivate(token: string, amount: bigint, recipient: string): Promise<Receipt>;
  createClaimEscrow(token: string, amount: bigint, commitmentHash: string, expiryBlocks: number): Promise<Receipt>;
  withdraw(token: string, amount: bigint, to: string): Promise<Receipt>; // PUBLIC edge
  balances(tokens: string[]): Promise<Record<string, bigint>>;
  activity(): Promise<unknown[]>; // classifyTransaction-based history
}
