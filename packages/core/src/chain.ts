/**
 * Chain-side plumbing: submitting a compiled pool transaction, and the block-depth sequencing
 * that has to happen between them.
 */

import type { Account, RpcProvider } from "starknet";
import type { ExecuteResult } from "@starkware-libs/starknet-privacy-sdk";
import type { Network } from "./config.js";
import type { Submitter } from "./wallet.js";

/**
 * How many blocks a proof's base state must sit behind the head.
 *
 * Ten, always. The sequencer rejects proofs whose base block is newer than this, notes mature over
 * the same span, and it doubles as a reorg buffer.
 */
export const PROOF_DEPTH = 10;

/**
 * Blocks still to wait before a proof may be built on top of `lastTxBlock`.
 *
 * Applies to *any* on-chain state a proof will read, not just notes: an account's deploy before
 * `register()`, an ERC-20 top-up before `deposit()`, and the previous private transaction before
 * the next one. That breadth is what catches out a burst-paying agent.
 */
export function blocksUntilProvable(
  lastTxBlock: number | null,
  head: number,
  depth = PROOF_DEPTH
): number {
  if (lastTxBlock === null) return 0;
  // A head behind the last transaction means a reorg or a stale RPC. Waiting the full window is
  // the safe reading; treating it as "already deep enough" would prove against state that may not
  // exist on the branch that wins.
  const currentDepth = head - lastTxBlock;
  return currentDepth >= depth ? 0 : depth - currentDepth;
}

/**
 * Why arming mainnet is a date and not a flag.
 *
 * One keypair serves both networks here, so which chain a run touches is decided by an environment
 * variable — and we have already had the near miss: a mainnet dry run was launched from a shell
 * where only the mode flag stood between a rehearsal and real money. A plain `KESE_MAINNET_ARMED=yes`
 * would fix that for exactly one day and then become part of the furniture, which is the same bug
 * with more steps.
 *
 * So arming carries the UTC date it is good for. Setting it is deliberate, and it stops working by
 * itself the next morning. Nothing needs to remember to disarm.
 *
 * This lives at the submitter rather than in a preflight because a preflight can be skipped: the
 * MCP server never runs one. Every transaction that reaches the chain passes through `submit()`.
 */
export function mainnetArmingError(
  network: Network,
  env: Record<string, string | undefined>,
  now: Date
): string | null {
  const armed = env.KESE_MAINNET_ARMED?.trim();
  const today = now.toISOString().slice(0, 10);

  // Armed for mainnet while pointed somewhere else. This is not a harmless combination to wave
  // through: someone who sets this variable believes they are about to touch mainnet, and if they
  // are not, every figure they are about to read and approve belongs to a different chain. It
  // happened — a transfer typed with the arming date but without KESE_NETWORK went out on Sepolia
  // while both parties read the output as mainnet. Refusing costs one clear error; allowing it
  // costs the trust in every number the run prints.
  if (network !== "mainnet") {
    if (armed) {
      return (
        `KESE_MAINNET_ARMED is set, but KESE_NETWORK is "${network}". Arming mainnet while pointed ` +
        `at another chain is almost always a mistake — set KESE_NETWORK=mainnet, or drop the arming.`
      );
    }
    return null;
  }

  if (!armed) {
    return (
      "refusing to submit a mainnet transaction: KESE_MAINNET_ARMED is not set. " +
      `Set it to today's UTC date (${today}) when you mean to spend real funds.`
    );
  }
  if (armed !== today) {
    return (
      `refusing to submit a mainnet transaction: KESE_MAINNET_ARMED is "${armed}", ` +
      `but today is ${today} (UTC). Arming expires daily on purpose — re-set it deliberately.`
    );
  }
  return null;
}

export interface ChainSubmitterOptions {
  provider: RpcProvider;
  account: Account;
  /** Which chain this talks to. Mainnet submissions must be armed for the day — see above. */
  network: Network;
  /** Called while waiting for depth, so a CLI can show progress instead of appearing hung. */
  onWait?: (remaining: number) => void;
  /** Poll interval while waiting for block depth. */
  pollMs?: number;
  /** Injected for tests. */
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

/**
 * Submits to a real chain, and refuses to hand out a proving head until the previous transaction
 * is deep enough to prove against.
 *
 * The sequencing lives here rather than in the wallet because this is the only layer that knows
 * block numbers. A wallet method therefore cannot forget the wait — the worst kind of bug to leave
 * to a caller, since skipping it produces an invalid proof rather than an obvious error.
 */
export function createChainSubmitter(options: ChainSubmitterOptions): Submitter {
  const {
    provider,
    account,
    network,
    onWait,
    pollMs = 15_000,
    env = process.env,
    now = () => new Date(),
  } = options;
  let lastTxBlock: number | null = null;

  return {
    async head(): Promise<number> {
      let head = await provider.getBlockNumber();
      for (;;) {
        const remaining = blocksUntilProvable(lastTxBlock, head);
        if (remaining === 0) return head;
        onWait?.(remaining);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        head = await provider.getBlockNumber();
      }
    },

    async submit(result: ExecuteResult) {
      // Before anything is estimated or signed: this is the last point at which real money is
      // still only a possibility.
      const blocked = mainnetArmingError(network, env, now());
      if (blocked) throw new Error(blocked);

      const { call, proof } = result.callAndProof;
      // The proof rides in the transaction details, alongside the fee bounds.
      const proofDetails = { proofFacts: proof.proofFacts, proof: proof.data };

      const fee = await account.estimateInvokeFee(call, proofDetails);
      const tx = await account.execute(call, {
        tip: 0n, // mandatory on v3 transactions
        resourceBounds: fee.resourceBounds,
        ...proofDetails,
      });

      const receipt = await provider.waitForTransaction(tx.transaction_hash);
      if (!receipt.isSuccess()) {
        const reason = (receipt as { revert_reason?: string }).revert_reason ?? "unknown";
        throw new Error(`transaction reverted: ${reason}`);
      }

      const blockNumber = (receipt as unknown as { block_number: number }).block_number;
      lastTxBlock = blockNumber;
      return { txHash: tx.transaction_hash, blockNumber };
    },
  };
}
