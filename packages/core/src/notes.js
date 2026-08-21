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
import { PROOF_DEPTH } from "./chain.js";
/**
 * Default ladder, in whole token units — scale by the token's decimals before use.
 *
 * A 1-2-5 progression is the same one physical currency settled on, and not by accident: it is a
 * *canonical* system, meaning greedy change-making is provably optimal. That lets note selection
 * stay simple and still behave well.
 */
export const DEFAULT_DENOMS = [1n, 2n, 5n, 10n, 20n, 50n, 100n];
/**
 * How many payments should be fundable in parallel.
 *
 * This is the tuning knob of the whole feature, and it is a product decision rather than a
 * technical one: higher means more concurrent payments but more notes to create up front (each
 * costs a pool fee), lower means cheaper shielding but an agent that stalls sooner under burst.
 * Three matches the demo script; raise it if the agent turns out to be chattier than that.
 */
export const DEFAULT_BURST = 3;
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
export function planLadder(balance, options) {
    const denoms = [...options.denoms].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const notes = [];
    let remaining = balance > 0n ? balance : 0n;
    for (const denom of denoms) {
        for (let i = 0; i < options.burst && remaining >= denom; i++) {
            notes.push(denom);
            remaining -= denom;
        }
    }
    return { notes, reserve: remaining };
}
/**
 * Which denominations the ladder is short of.
 *
 * Immature notes count as held: they will mature on their own, and rebalancing against mature
 * notes alone would re-mint denominations that are already on their way — doubling the ladder every
 * time the agent pays in a burst, which is precisely when it can least afford the fees.
 */
export function ladderGaps(held, options) {
    const counts = new Map();
    for (const note of held) {
        counts.set(note.amount, (counts.get(note.amount) ?? 0) + 1);
    }
    const gaps = [];
    for (const denom of options.denoms) {
        const missing = options.burst - (counts.get(denom) ?? 0);
        for (let i = 0; i < missing; i++)
            gaps.push(denom);
    }
    return gaps;
}
/**
 * Choose notes to fund `amount`.
 *
 * Preference order, and the reasoning behind it:
 *  1. **Exact change** — creates no new note, so nothing has to mature and the rest of the ladder
 *     stays spendable. This is the case the ladder exists to produce.
 *  2. **Fewest notes** — every note spent is one fewer available to fund a parallel payment.
 */
export function selectNotes(amount, notes, options) {
    const depth = options.depth ?? PROOF_DEPTH;
    const mature = [];
    let immatureTotal = 0n;
    for (const note of notes) {
        // Unknown creation block fails closed. Spending a note that turns out to be immature produces
        // an invalid proof; "insufficient balance" is a far more legible failure than a proof
        // rejection, and the immature total lets the caller explain the wait.
        const isMature = note.created !== undefined && options.head - note.created >= depth;
        if (isMature)
            mature.push(note);
        else
            immatureTotal += note.amount;
    }
    const matureTotal = mature.reduce((sum, note) => sum + note.amount, 0n);
    if (amount <= 0n) {
        return { ok: false, reason: "invalid_amount", matureTotal, immatureTotal };
    }
    if (matureTotal < amount) {
        return { ok: false, reason: "insufficient_mature", matureTotal, immatureTotal };
    }
    const exact = findExactSubset(amount, mature, options.searchBudget ?? 20_000);
    if (exact) {
        return { ok: true, notes: exact, total: amount, change: 0n, exact: true };
    }
    // No exact combination: take the largest notes first, which reaches the amount in the fewest
    // notes and leaves the small denominations intact for the next payment.
    const descending = [...mature].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
    const picked = [];
    let total = 0n;
    for (const note of descending) {
        if (total >= amount)
            break;
        picked.push(note);
        total += note.amount;
    }
    return { ok: true, notes: picked, total, change: total - amount, exact: false };
}
/**
 * Depth-first search for a subset summing exactly to `target`.
 *
 * Largest-first with a running remainder bound: once the notes still ahead cannot reach the
 * target, the branch is dead. On a canonical ladder that prunes almost everything immediately.
 * Returns null when the budget runs out, which the caller treats as "no exact change" rather than
 * an error — a slightly worse selection, never a failed payment.
 */
function findExactSubset(target, notes, budget) {
    const sorted = [...notes].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
    // suffixTotals[i] = sum of sorted[i..]; lets a branch bail the moment it cannot reach the target.
    const suffixTotals = new Array(sorted.length + 1).fill(0n);
    for (let i = sorted.length - 1; i >= 0; i--) {
        suffixTotals[i] = suffixTotals[i + 1] + sorted[i].amount;
    }
    let steps = 0;
    const chosen = [];
    function search(index, remaining) {
        if (remaining === 0n)
            return true;
        if (index >= sorted.length || remaining < 0n)
            return false;
        if (suffixTotals[index] < remaining)
            return false;
        if (++steps > budget)
            return false;
        const note = sorted[index];
        if (note.amount <= remaining) {
            chosen.push(note);
            if (search(index + 1, remaining - note.amount))
                return true;
            chosen.pop();
        }
        return search(index + 1, remaining);
    }
    return search(0, target) ? [...chosen] : null;
}
