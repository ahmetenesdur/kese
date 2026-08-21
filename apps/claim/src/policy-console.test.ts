import { describe, expect, it } from "vitest";
import { decide, type Policy } from "./policy-console.js";

/**
 * The console on the landing page states rules a visitor is asked to believe. If it drifts from
 * `packages/policy/src/engine.ts`, the page becomes a confident lie about our own product — so the
 * two decisions that are opinions rather than mechanics are pinned here.
 */
const policy: Policy = {
  perTxCap: 10,
  dailyCap: 50,
  approvalThreshold: 2,
  spentToday: 12,
  allowlisted: true,
};

describe("the landing page's policy console", () => {
  it("allows a payment inside every limit", () => {
    expect(decide(1, policy).verdict).toBe("allow");
  });

  it("asks above the threshold", () => {
    expect(decide(5, policy).verdict).toBe("ask");
  });

  it("DENIES over the per-tx cap rather than asking — caps are absolute", () => {
    // The interesting case. 20 is over the cap AND over the threshold; a design that asked here
    // would imply the cap is negotiable. The engine denies, and so must this.
    const d = decide(20, policy);
    expect(d.verdict).toBe("deny");
    expect(d.rules[d.decidedAt]!.code).toBe("per_tx_cap_exceeded");
  });

  it("checks the cap before the threshold, which is why that works", () => {
    const order = decide(1, policy).rules.map((r) => r.label);
    expect(order.indexOf("Per-transaction cap")).toBeLessThan(order.indexOf("Approval threshold"));
  });

  it("treats the daily budget as a rolling window that already has spending in it", () => {
    // Raise the per-tx cap out of the way, or it decides first — 12 already spent against a cap of
    // 50 means 38 is the last amount that fits, and the clock never enters into it.
    const roomy = { ...policy, perTxCap: 100 };
    expect(decide(38, roomy).verdict).not.toBe("deny");
    expect(decide(38.01, roomy).verdict).toBe("deny");
  });

  it("stops at the first failing rule and marks the rest as never reached", () => {
    // Every rule comes back every time. A gate that stops at the first failure is different from
    // one that collects reasons, and the page can only show that difference if the skipped rules
    // are still there to be drawn.
    const d = decide(20, { ...policy, allowlisted: false });
    expect(d.rules).toHaveLength(5);
    expect(d.rules[1]!.state).toBe("fail");
    expect(d.rules[1]!.code).toBe("recipient_not_allowlisted");
    expect(d.rules.slice(2).map((r) => r.state)).toEqual(["skipped", "skipped", "skipped"]);
  });

  it("blanks a skipped rule's detail, so it cannot show a figure nothing computed", () => {
    const d = decide(20, policy);
    const skipped = d.rules.filter((r) => r.state === "skipped");
    expect(skipped).not.toHaveLength(0);
    expect(skipped.every((r) => r.detail === "" && r.meter === undefined)).toBe(true);
  });

  it("marks the threshold rule as an ask, not a failure", () => {
    // Colouring it red would say the payment was refused when a human is merely being asked.
    const d = decide(5, policy);
    expect(d.rules[4]!.state).toBe("ask");
    expect(d.rules[4]!.code).toBeUndefined();
  });

  it("refuses a non-positive amount instead of computing with it", () => {
    expect(decide(0, policy).verdict).toBe("deny");
    expect(decide(-5, policy).verdict).toBe("deny");
  });
});
