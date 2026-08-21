/**
 * Note denomination ladder — Kese's novel piece.
 *
 * **The problem is timing, not accounting.** A note matures 10 blocks after it is created, and a
 * payment that spends a note produces a change note. So an agent holding one large note can make
 * exactly one payment and then stalls ~10 blocks behind its own change. For an autonomous payer
 * that is the difference between "pays three invoices in a minute" and "pays one and hangs".
 *
 * **The fix** is to keep the shielded balance split across a ladder of round denominations, so
 * several payments draw on distinct, already-mature notes and — ideally — spend exact change, which
 * creates no new note that has to mature at all.
 *
 * **It is also a privacy measure, not only a throughput one.** Round denominations blunt
 * amount-fingerprinting, and because the ladder is stocked by shielding *ahead of time* it forces
 * the shield to be its own earlier transaction rather than riding along with the payment it funds —
 * which is exactly what stops an observer correlating "this address deposited X" with the transfer
 * that spent it.
 */
/**
 * Default ladder, in whole token units — scale by the token's decimals before use.
 *
 * A 1-2-5 progression is the same one physical currency settled on, and not by accident: it is a
 * *canonical* system, meaning greedy change-making is provably optimal. That lets note selection
 * stay simple and still behave well.
 */
export declare const DEFAULT_DENOMS: bigint[];
/**
 * How many payments should be fundable in parallel.
 *
 * This is the tuning knob of the whole feature, and it is a product decision rather than a
 * technical one: higher means more concurrent payments but more notes to create up front (each
 * costs a pool fee), lower means cheaper shielding but an agent that stalls sooner under burst.
 * Three matches the demo script; raise it if the agent turns out to be chattier than that.
 */
export declare const DEFAULT_BURST = 3;
export interface LadderOptions {
    /** Ascending denominations, in the token's smallest unit. */
    denoms: readonly bigint[];
    /** Target number of notes to hold at each denomination. */
    burst: number;
}
export interface LadderPlan {
    /** Note amounts to create, in the order they should be minted. */
    notes: bigint[];
    /**
     * Everything not spent stocking the ladder, left as ONE note.
     *
     * This is the reserve, not leftover dust: it is where future rebalances draw from. Splitting it
     * across the ladder instead would be ruinous — the top denomination is fixed, so a large balance
     * would shred into thousands of notes, each carrying a pool fee. A cash drawer keeps small
     * denominations for making change and the rest in the safe, for the same reason.
     */
    reserve: bigint;
}
/** A note as far as selection is concerned. Mirrors the fields we need from the SDK's `Note`. */
export interface SelectableNote {
    id: string | bigint;
    amount: bigint;
    /** Block the note was created in. **Optional in the SDK**, and absent means "assume immature". */
    created?: number;
}
export type SelectionResult = {
    ok: true;
    notes: SelectableNote[];
    total: bigint;
    change: bigint;
    exact: boolean;
} | {
    ok: false;
    reason: "insufficient_mature" | "invalid_amount";
    matureTotal: bigint;
    immatureTotal: bigint;
};
/**
 * Split a balance into a ladder plus a reserve.
 *
 * Stock `burst` notes at each denomination from the bottom up — that is what buys parallelism, and
 * it has to happen before the money is committed elsewhere. Everything left over stays as a single
 * reserve note.
 *
 * An earlier version also parked the remainder across the ladder, largest-first. That is minimal
 * change-making, and it is the wrong goal here: the top denomination is fixed, so a balance far
 * above it shreds into thousands of notes — a million units against a ladder topping out at 100
 * produced **10,019 notes**, each carrying a pool fee, to buy no extra parallelism at all (the
 * burst quota was already met on the first pass). The note count must track the ladder's shape,
 * never the balance.
 */
export declare function planLadder(balance: bigint, options: LadderOptions): LadderPlan;
/**
 * Which denominations the ladder is short of.
 *
 * Immature notes count as held: they will mature on their own, and rebalancing against mature
 * notes alone would re-mint denominations that are already on their way — doubling the ladder every
 * time the agent pays in a burst, which is precisely when it can least afford the fees.
 */
export declare function ladderGaps(held: readonly SelectableNote[], options: LadderOptions): bigint[];
export interface SelectOptions {
    /** Current chain head, for maturity. */
    head: number;
    /** Blocks a note must age before it can be spent. */
    depth?: number;
    /**
     * Ceiling on the exact-change search. Subset-sum is exponential; with a canonical ladder an exact
     * combination is usually found in the first handful of branches, and the greedy fallback is
     * always available. Bounding it keeps a pathological note set from hanging a payment.
     */
    searchBudget?: number;
}
/**
 * Choose notes to fund `amount`.
 *
 * Preference order, and the reasoning behind it:
 *  1. **Exact change** — creates no new note, so nothing has to mature and the rest of the ladder
 *     stays spendable. This is the case the ladder exists to produce.
 *  2. **Fewest notes** — every note spent is one fewer available to fund a parallel payment.
 */
export declare function selectNotes(amount: bigint, notes: readonly SelectableNote[], options: SelectOptions): SelectionResult;
