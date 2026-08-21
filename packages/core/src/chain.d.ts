/**
 * Chain-side plumbing: submitting a compiled pool transaction, and the block-depth sequencing
 * that has to happen between them.
 */
import type { Account, RpcProvider } from "starknet";
import type { Submitter } from "./wallet.js";
/**
 * How many blocks a proof's base state must sit behind the head.
 *
 * Ten, always. The sequencer rejects proofs whose base block is newer than this, notes mature over
 * the same span, and it doubles as a reorg buffer.
 */
export declare const PROOF_DEPTH = 10;
/**
 * Blocks still to wait before a proof may be built on top of `lastTxBlock`.
 *
 * Applies to *any* on-chain state a proof will read, not just notes: an account's deploy before
 * `register()`, an ERC-20 top-up before `deposit()`, and the previous private transaction before
 * the next one. That breadth is what catches out a burst-paying agent.
 */
export declare function blocksUntilProvable(lastTxBlock: number | null, head: number, depth?: number): number;
export interface ChainSubmitterOptions {
    provider: RpcProvider;
    account: Account;
    /** Called while waiting for depth, so a CLI can show progress instead of appearing hung. */
    onWait?: (remaining: number) => void;
    /** Poll interval while waiting for block depth. */
    pollMs?: number;
}
/**
 * Submits to a real chain, and refuses to hand out a proving head until the previous transaction
 * is deep enough to prove against.
 *
 * The sequencing lives here rather than in the wallet because this is the only layer that knows
 * block numbers. A wallet method therefore cannot forget the wait — the worst kind of bug to leave
 * to a caller, since skipping it produces an invalid proof rather than an obvious error.
 */
export declare function createChainSubmitter(options: ChainSubmitterOptions): Submitter;
