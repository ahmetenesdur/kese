/**
 * Chain-side plumbing: submitting a compiled pool transaction, and the block-depth sequencing
 * that has to happen between them.
 */
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
export function blocksUntilProvable(lastTxBlock, head, depth = PROOF_DEPTH) {
    if (lastTxBlock === null)
        return 0;
    // A head behind the last transaction means a reorg or a stale RPC. Waiting the full window is
    // the safe reading; treating it as "already deep enough" would prove against state that may not
    // exist on the branch that wins.
    const currentDepth = head - lastTxBlock;
    return currentDepth >= depth ? 0 : depth - currentDepth;
}
/**
 * Submits to a real chain, and refuses to hand out a proving head until the previous transaction
 * is deep enough to prove against.
 *
 * The sequencing lives here rather than in the wallet because this is the only layer that knows
 * block numbers. A wallet method therefore cannot forget the wait — the worst kind of bug to leave
 * to a caller, since skipping it produces an invalid proof rather than an obvious error.
 */
export function createChainSubmitter(options) {
    const { provider, account, onWait, pollMs = 15_000 } = options;
    let lastTxBlock = null;
    return {
        async head() {
            let head = await provider.getBlockNumber();
            for (;;) {
                const remaining = blocksUntilProvable(lastTxBlock, head);
                if (remaining === 0)
                    return head;
                onWait?.(remaining);
                await new Promise((resolve) => setTimeout(resolve, pollMs));
                head = await provider.getBlockNumber();
            }
        },
        async submit(result) {
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
                const reason = receipt.revert_reason ?? "unknown";
                throw new Error(`transaction reverted: ${reason}`);
            }
            const blockNumber = receipt.block_number;
            lastTxBlock = blockNumber;
            return { txHash: tx.transaction_hash, blockNumber };
        },
    };
}
