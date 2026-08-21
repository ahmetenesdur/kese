/**
 * Note denomination ladder.
 *
 * The problem this solves is timing, not accounting. A note matures 10 blocks after it is created,
 * and a payment that spends a note produces a change note. So an agent holding one big note can
 * make exactly one payment and then stalls ~10 blocks behind its own change — which is fatal for
 * the demo ("agent pays 3 invoices in one minute") and worse in production.
 *
 * The fix is to keep the balance split across round denominations, so several payments draw on
 * distinct already-mature notes. Round amounts do double duty: they are also what stops a payment
 * of 37.418 STRK from fingerprinting the payer.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_DENOMS, ladderGaps, planLadder, selectNotes, type SelectableNote } from "./notes.js";

/** head is 1000; anything created at or before 990 is mature at depth 10. */
const HEAD = 1000;
const MATURE = 990;
const FRESH = 995;

function note(id: string, amount: bigint, created?: number): SelectableNote {
  return { id, amount, created };
}

describe("planLadder", () => {
  it("stocks at least `burst` notes of every affordable denomination", () => {
    // AT LEAST, not exactly: the second pass parks the remainder and may add more of a
    // denomination. What matters is that no denomination is left under-stocked, since that is the
    // one that will be missing when a burst arrives.
    const plan = planLadder(100n, { denoms: [1n, 2n, 5n, 10n], burst: 2 });
    for (const denom of [1n, 2n, 5n, 10n]) {
      expect(plan.notes.filter((n) => n === denom).length).toBeGreaterThanOrEqual(2);
    }
    expect(plan.notes.reduce((a, b) => a + b, 0n) + plan.reserve).toBe(100n);
  });

  it("conserves the balance exactly — planned notes plus dust equal the input", () => {
    for (const balance of [0n, 1n, 7n, 99n, 1234n, 10n ** 9n]) {
      const plan = planLadder(balance, { denoms: DEFAULT_DENOMS, burst: 3 });
      expect(plan.notes.reduce((a, b) => a + b, 0n) + plan.reserve).toBe(balance);
    }
  });

  it("leaves anything below the smallest denomination as dust rather than inventing a note", () => {
    const plan = planLadder(3n, { denoms: [5n, 10n], burst: 2 });
    expect(plan.notes).toEqual([]);
    expect(plan.reserve).toBe(3n);
  });

  it("does not grow the note count with the balance — every note costs a pool fee", () => {
    // The property that actually protects the fee bill. A ladder whose size tracked the balance
    // would make shielding a large amount ruinous; greedy descending on a canonical 1-2-5 ladder
    // grows only with the number of DIGITS, so a 1000x balance costs a handful more notes.
    const opts = { denoms: DEFAULT_DENOMS, burst: 3 };
    const small = planLadder(1_000n, opts);
    const large = planLadder(1_000_000n, opts);
    expect(large.notes.length).toBeLessThan(small.notes.length * 2);
  });

  it("caps the note count at burst x denominations, whatever the balance", () => {
    const opts = { denoms: DEFAULT_DENOMS, burst: 3 };
    for (const balance of [1_000n, 1_000_000n, 10n ** 24n]) {
      expect(planLadder(balance, opts).notes.length).toBeLessThanOrEqual(
        opts.burst * opts.denoms.length
      );
    }
  });

  it("returns nothing for a zero balance", () => {
    expect(planLadder(0n, { denoms: DEFAULT_DENOMS, burst: 3 })).toEqual({ notes: [], reserve: 0n });
  });
});

describe("selectNotes — maturity", () => {
  it("ignores notes that have not matured yet", () => {
    const result = selectNotes(10n, [note("fresh", 100n, FRESH)], { head: HEAD });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("insufficient_mature");
    expect(result.immatureTotal).toBe(100n);
  });

  it("spends a note that has reached exactly the maturity depth", () => {
    const result = selectNotes(100n, [note("ripe", 100n, MATURE)], { head: HEAD });
    expect(result.ok).toBe(true);
  });

  it("treats a note with unknown creation block as immature", () => {
    // `Note.created` is optional in the SDK. Unknown maturity has to fail closed: spending a note
    // that turns out to be immature produces an invalid proof, and "insufficient balance" is a far
    // more legible failure than a proof rejection. Surfacing the total means the caller can still
    // explain what happened.
    const result = selectNotes(10n, [note("unknown", 100n, undefined)], { head: HEAD });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.immatureTotal).toBe(100n);
  });
});

describe("selectNotes — choosing notes", () => {
  it("prefers an exact match, so the payment creates no change note at all", () => {
    // This is the whole point. Exact change means nothing new is created, nothing new has to
    // mature, and the rest of the ladder is untouched and still spendable.
    const notes = [note("a", 50n, MATURE), note("b", 10n, MATURE), note("c", 25n, MATURE)];
    const result = selectNotes(10n, notes, { head: HEAD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exact).toBe(true);
    expect(result.change).toBe(0n);
    expect(result.notes.map((n) => n.id)).toEqual(["b"]);
  });

  it("finds an exact combination that no single note provides", () => {
    const notes = [note("a", 50n, MATURE), note("b", 20n, MATURE), note("c", 5n, MATURE)];
    const result = selectNotes(25n, notes, { head: HEAD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exact).toBe(true);
    expect(result.notes.map((n) => n.id).sort()).toEqual(["b", "c"]);
  });

  it("falls back to change when no exact combination exists", () => {
    const result = selectNotes(30n, [note("a", 50n, MATURE)], { head: HEAD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exact).toBe(false);
    expect(result.change).toBe(20n);
  });

  it("spends the fewest notes it can when change is unavoidable", () => {
    // Every note spent is a note no longer available to fund a parallel payment.
    const notes = [
      note("big", 100n, MATURE),
      note("s1", 1n, MATURE),
      note("s2", 1n, MATURE),
      note("s3", 1n, MATURE),
    ];
    const result = selectNotes(99n, notes, { head: HEAD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]!.id).toBe("big");
  });

  it("reports the shortfall when mature notes cannot cover the amount", () => {
    const result = selectNotes(500n, [note("a", 50n, MATURE), note("b", 20n, FRESH)], {
      head: HEAD,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.matureTotal).toBe(50n);
    expect(result.immatureTotal).toBe(20n);
  });

  it("refuses a non-positive amount rather than returning an empty selection", () => {
    const result = selectNotes(0n, [note("a", 50n, MATURE)], { head: HEAD });
    expect(result.ok).toBe(false);
  });
});

describe("selectNotes — parallel payments", () => {
  it("lets a ladder fund a burst of payments from distinct notes", () => {
    // The demo claim: three invoices in one minute. Each payment must draw on its own mature note,
    // and none may need the change of another.
    const ladder: SelectableNote[] = [
      note("n1", 10n, MATURE),
      note("n2", 10n, MATURE),
      note("n3", 10n, MATURE),
    ];
    const spent = new Set<string>();

    for (let payment = 0; payment < 3; payment++) {
      const available = ladder.filter((n) => !spent.has(String(n.id)));
      const result = selectNotes(10n, available, { head: HEAD });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.exact).toBe(true); // no change note created, so nothing has to mature
      for (const n of result.notes) spent.add(String(n.id));
    }
    expect(spent.size).toBe(3);
  });
});

describe("ladderGaps", () => {
  it("names the denominations missing from the ladder", () => {
    const held = [note("a", 10n, MATURE), note("b", 10n, MATURE)];
    const gaps = ladderGaps(held, { denoms: [1n, 5n, 10n], burst: 2 });
    // Two tens already held; the ones and fives are missing.
    expect(gaps.filter((g) => g === 1n)).toHaveLength(2);
    expect(gaps.filter((g) => g === 5n)).toHaveLength(2);
    expect(gaps.filter((g) => g === 10n)).toHaveLength(0);
  });

  it("is empty when the ladder is already stocked", () => {
    const held = [
      note("a", 1n, MATURE),
      note("b", 1n, MATURE),
      note("c", 5n, MATURE),
      note("d", 5n, MATURE),
    ];
    expect(ladderGaps(held, { denoms: [1n, 5n], burst: 2 })).toEqual([]);
  });

  it("counts immature notes as already held — they will mature on their own", () => {
    // Rebalancing on the basis of mature notes alone would re-mint denominations that are already
    // on their way, doubling the ladder every time the agent pays in a burst.
    const held = [note("a", 5n, FRESH), note("b", 5n, FRESH)];
    expect(ladderGaps(held, { denoms: [5n], burst: 2 })).toEqual([]);
  });
});
