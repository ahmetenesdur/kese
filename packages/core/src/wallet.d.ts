/**
 * KeseWallet — the money-moving primitive.
 *
 * This is deliberately dumb about policy. Caps, allowlists and approvals live in `@kese/policy`,
 * and the MCP layer is what wires `decide()` in front of these calls (CLAUDE.md hard rule 2).
 * A wallet that also enforced limits would give the two layers two chances to disagree.
 *
 * Two rules are baked into the shape of this API rather than left to callers:
 *
 * 1. **No shield-and-pay convenience method, ever.** Bundling a deposit with the transfer it funds
 *    publishes "this address deposited X" in the same transaction as the transfer it paid for, and
 *    an observer correlates them trivially — the recipient stays hidden, the sender and amount do
 *    not. Shielding must be its own earlier transaction. If someone later wants one call that does
 *    both, that is a privacy regression, not a convenience.
 * 2. **Failures come back as receipts, not exceptions.** Every caller is on a money path that has
 *    already reserved budget and must release it; a thrown error makes that a try/catch each caller
 *    has to remember. `Receipt.status === "failed"` makes it part of the return type.
 *
 * Everything on the failure path goes through `redact` before it lands in a receipt, because a
 * receipt is headed for an MCP tool result — that is, straight into an LLM's context.
 */
import type { ExecuteResult, PrivateTransfersInterface } from "@starkware-libs/starknet-privacy-sdk";
import type { ProviderInterface } from "starknet";
export interface Receipt {
    status: "confirmed" | "simulated" | "failed";
    txHash?: string;
    blockNumber?: number;
    error?: string;
}
/**
 * How a compiled transaction reaches the world.
 *
 * This is the one seam that genuinely differs between a chain and a test: everything above it —
 * builder, compiler, note selection, channel setup — is the SDK's real code in both cases. Keeping
 * it injected is what lets the test suite exercise the real pipeline without a prover.
 */
export interface Submitter {
    submit(result: ExecuteResult): Promise<{
        txHash?: string;
        blockNumber?: number;
    }>;
    /** Current chain head, used to derive the proving block. */
    head(): Promise<number>;
}
export interface KeseWalletDeps {
    transfers: PrivateTransfersInterface;
    /** This wallet's own account address — surplus and change come back here. */
    address: string;
    submitter: Submitter;
    redact: (input: unknown) => string;
    /**
     * Set to run in SIMULATE mode: every action is compiled against live pool state and checked by
     * the node, but nothing is submitted and no real proof is produced. Receipts come back as
     * `simulated`, never `confirmed` — the distinction has to survive all the way to the caller, or
     * a dry run reads like a successful payment.
     */
    simulateNode?: ProviderInterface;
}
export interface KeseWallet {
    register(): Promise<Receipt>;
    /** PUBLIC edge: the depositing address and amount are visible on-chain, and screened. */
    shield(token: string, amount: bigint): Promise<Receipt>;
    payPrivate(token: string, amount: bigint, recipient: string): Promise<Receipt>;
    /** PUBLIC edge: the recipient address and amount are visible on-chain. */
    withdraw(token: string, amount: bigint, to: string): Promise<Receipt>;
    balances(tokens: string[]): Promise<Record<string, bigint>>;
}
export declare function createKeseWallet(deps: KeseWalletDeps): KeseWallet;
