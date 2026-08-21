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
/**
 * Discovery and note selection are refreshed on every call rather than cached.
 *
 * The SDK's own guidance is to go stateless: a persisted registry means cursor drift, reorg
 * reconciliation and stale-channel bugs, and it only becomes a bottleneck past several thousand
 * notes. An autonomous payer is exactly the workload where a stale note set silently double-spends.
 */
const REFRESH = { notes: "refresh", channels: "refresh" };
export function createKeseWallet(deps) {
    const { transfers, address, submitter, redact } = deps;
    /**
     * `provingBlockId = head - 10` — always.
     *
     * Three reasons collapse into one number: notes mature 10 blocks after creation, it buys a reorg
     * buffer, and it pins discovery and proving to the same state. The compiler forwards this to the
     * discovery calls so both see one block.
     */
    async function provingBlockId() {
        return (await submitter.head()) - 10;
    }
    /** Compile a build, then either simulate it or submit it, and shape the outcome as a Receipt. */
    async function run(build) {
        try {
            const provingBlock = await provingBlockId();
            const chain = build(provingBlock);
            if (deps.simulateNode) {
                await chain.simulate({ node: deps.simulateNode, provingBlockId: provingBlock });
                return { status: "simulated" };
            }
            const result = await chain.execute({ provingBlockId: provingBlock });
            const { txHash, blockNumber } = await submitter.submit(result);
            return { status: "confirmed", txHash, blockNumber };
        }
        catch (error) {
            return { status: "failed", error: redact(error) };
        }
    }
    return {
        async register() {
            return run((provingBlock) => transfers.build({ provingBlockId: provingBlock }).register());
        },
        async shield(token, amount) {
            return run((provingBlock) => transfers
                // autoRegister: registration is an idempotent PREREQUISITE, not a spend — the SDK acts
                // only when the account's on-chain viewing key is actually absent. Without it a first
                // shield fails with "Missing channel context", which reads like a channel bug, and in
                // simulate mode calling register() first cannot help: a simulated registration is never
                // submitted, so the account stays unregistered.
                // autoSetup: a note cannot be created before its token subchannel exists. Without this
                // the mock pool reports the misleading "Token <n> does not exist" — which is a
                // subchannel assertion, not a missing ERC-20 (docs/decisions.md D-009).
                .build({
                autoRegister: true,
                autoSetup: true,
                autoDiscover: REFRESH,
                provingBlockId: provingBlock,
            })
                .with(token, (t) => t.deposit({ amount }))
                .surplusTo(address));
        },
        async payPrivate(token, amount, recipient) {
            return run((provingBlock) => transfers
                .build({
                autoRegister: true,
                autoSetup: true,
                // "naive" selects the minimum set of notes rather than sweeping every note the wallet
                // holds. That keeps unrelated notes unspent and available to fund parallel payments —
                // the whole point of the denomination ladder in notes.ts.
                autoSelectNotes: "naive",
                autoDiscover: REFRESH,
                provingBlockId: provingBlock,
            })
                .with(token, (t) => t.transfer({ recipient, amount }))
                .surplusTo(address));
        },
        async withdraw(token, amount, to) {
            return run((provingBlock) => transfers
                .build({
                autoRegister: true,
                autoSetup: true,
                autoSelectNotes: "all",
                autoDiscover: REFRESH,
                provingBlockId: provingBlock,
            })
                .with(token, (t) => t.withdraw({ recipient: to, amount }))
                // Change stays private with the sender, rather than following the public withdrawal.
                .surplusTo(address));
        },
        async balances(tokens) {
            const { notes } = await transfers.discoverNotes({
                tokens: tokens.map((token) => BigInt(token)),
            });
            const result = {};
            for (const token of tokens) {
                // Keyed by the address the caller passed, so a lookup with the same string works. Report an
                // explicit zero rather than omitting the key: `balances[token]` should be 0n, not
                // undefined, or "no notes yet" becomes a crash one layer up.
                const held = notes.get(BigInt(token)) ?? [];
                result[token] = held.reduce((sum, note) => sum + note.amount, 0n);
            }
            return result;
        },
    };
}
