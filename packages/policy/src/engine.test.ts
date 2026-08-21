/**
 * Policy engine tests.
 *
 * CLAUDE.md singles this engine out for exhaustive testing, and for good reason: it is the only
 * thing standing between an LLM and the money (hard rule 2), and its failure modes — a race that
 * double-spends a cap, a retry that pays twice, a window that rolls the wrong way — are all
 * invisible until they cost real funds.
 *
 * Everything runs against a real in-memory SQLite database. The clock is injected rather than
 * mocked, so window-boundary tests state their intent instead of manipulating global time.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createPolicyEngine } from "./engine.js";
import type { PaymentRequest, PolicyConfig, PolicyEngine } from "./types.js";

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ETH = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
const ALICE = "0x0a11ce";
const MALLORY = "0x0ba11ee";

/** perTx 100, daily 250, ask a human above 50. */
const config: PolicyConfig = {
  perTxCap: { [STRK]: 100n },
  dailyCap: { [STRK]: 250n },
  allowlist: [ALICE],
  approvalThreshold: { [STRK]: 50n },
  claimLinkDefaultExpiryBlocks: 1000,
};

let clock = 1_700_000_000_000;
let engine: PolicyEngine;

function request(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
    agentId: "agent-1",
    kind: "private_transfer",
    token: STRK,
    amount: 10n,
    recipient: ALICE,
    ...overrides,
  };
}

beforeEach(() => {
  clock = 1_700_000_000_000;
  engine = createPolicyEngine({ dbPath: ":memory:", now: () => clock });
});

describe("allowlist", () => {
  it("allows a payment to an allowlisted recipient under every limit", async () => {
    const decision = await engine.decide(request({ amount: 10n }), config);
    expect(decision.kind).toBe("allow");
  });

  it("denies a recipient that is not on the allowlist", async () => {
    const decision = await engine.decide(request({ recipient: MALLORY }), config);
    expect(decision).toMatchObject({ kind: "deny", code: "recipient_not_allowlisted" });
  });

  it('skips the allowlist check when it is "any"', async () => {
    const decision = await engine.decide(request({ recipient: MALLORY }), {
      ...config,
      allowlist: "any",
    });
    expect(decision.kind).toBe("allow");
  });

  it("compares addresses numerically, so zero-padding cannot smuggle a recipient past it", async () => {
    // 0x0a11ce and 0x00000a11ce are the same Starknet address written two ways. String equality
    // would treat the padded form as a stranger — or, worse, let a padded MALLORY look novel.
    const decision = await engine.decide(request({ recipient: "0x00000a11ce" }), config);
    expect(decision.kind).toBe("allow");
  });
});

describe("per-transaction cap", () => {
  it("allows an amount exactly at the cap", async () => {
    const decision = await engine.decide(request({ amount: 100n }), config);
    // At the cap it is still above the approval threshold, so a human is asked — but not denied.
    expect(decision.kind).toBe("needs_approval");
  });

  it("denies an amount above the cap without asking a human", async () => {
    // The decision recorded in docs/decisions.md D-011: a cap is an absolute ceiling, not a
    // prompt. If it could be approved away it would be a suggestion, and a compromised agent
    // could grind the owner down with approval spam until one gets waved through.
    const decision = await engine.decide(request({ amount: 150n }), config);
    expect(decision).toMatchObject({ kind: "deny", code: "per_tx_cap_exceeded" });
  });
});

describe("approval threshold", () => {
  it("allows outright below the threshold", async () => {
    const decision = await engine.decide(request({ amount: 49n }), config);
    expect(decision.kind).toBe("allow");
  });

  it("allows outright exactly at the threshold", async () => {
    const decision = await engine.decide(request({ amount: 50n }), config);
    expect(decision.kind).toBe("allow");
  });

  it("asks for approval above the threshold", async () => {
    const decision = await engine.decide(request({ amount: 51n }), config);
    expect(decision).toMatchObject({ kind: "needs_approval" });
  });

  it("issues a ticket and a reservation together, so the budget is held while a human decides", async () => {
    const decision = await engine.decide(request({ amount: 51n }), config);
    if (decision.kind !== "needs_approval") throw new Error(`expected needs_approval`);
    expect(decision.ticketId).toBeTruthy();
    expect(decision.reservationId).toBeTruthy();
  });
});

describe("unconfigured tokens (fail closed)", () => {
  it("denies a token with no caps configured rather than treating it as unlimited", async () => {
    const decision = await engine.decide(request({ token: ETH }), config);
    expect(decision).toMatchObject({ kind: "deny", code: "token_not_configured" });
  });
});

describe("request validation", () => {
  it("denies a non-positive amount", async () => {
    const decision = await engine.decide(request({ amount: 0n }), config);
    expect(decision).toMatchObject({ kind: "deny", code: "invalid_request" });
  });

  it("denies a transfer with no recipient", async () => {
    const decision = await engine.decide(request({ recipient: undefined }), config);
    expect(decision).toMatchObject({ kind: "deny", code: "invalid_request" });
  });

  it("allows a claim link with no recipient — that is the whole point of a claim link", async () => {
    const decision = await engine.decide(
      request({ kind: "claim_link", recipient: undefined, amount: 10n }),
      config
    );
    expect(decision.kind).toBe("allow");
  });

  it("denies a malformed address instead of throwing out of the engine", async () => {
    // An LLM will hand us a truncated or hallucinated address sooner or later. Address parsing
    // must fail closed like every other check — an exception escaping decide() would surface as a
    // tool crash, and a crash is not a denial.
    const decision = await engine.decide(request({ recipient: "0xnot-an-address" }), config);
    expect(decision).toMatchObject({ kind: "deny", code: "invalid_request" });
  });

  it("denies a malformed token address the same way", async () => {
    const decision = await engine.decide(request({ token: "definitely not hex" }), config);
    expect(decision).toMatchObject({ kind: "deny", code: "invalid_request" });
  });

  it("denies an empty idempotency key", async () => {
    const decision = await engine.decide(request({ idempotencyKey: "  " }), config);
    expect(decision).toMatchObject({ kind: "deny", code: "invalid_request" });
  });
});

const HOUR = 60 * 60 * 1000;

describe("rolling daily cap", () => {
  it("denies a payment that would push the rolling 24h total past the daily cap", async () => {
    // daily cap 250: 100 + 100 fits, the third 100 does not.
    expect((await engine.decide(request({ amount: 100n }), config)).kind).toBe("needs_approval");
    expect((await engine.decide(request({ amount: 100n }), config)).kind).toBe("needs_approval");
    const third = await engine.decide(request({ amount: 100n }), config);
    expect(third).toMatchObject({ kind: "deny", code: "daily_cap_exceeded" });
  });

  it("allows a payment that lands exactly on the daily cap", async () => {
    await engine.decide(request({ amount: 100n }), config);
    await engine.decide(request({ amount: 100n }), config);
    expect((await engine.decide(request({ amount: 50n }), config)).kind).toBe("allow");
  });

  it("counts still-active reservations, so two concurrent payments cannot both fit", async () => {
    // The whole point of reserving before executing: nothing has been committed yet, but the
    // budget is spoken for. Without this, a burst of tool calls each sees an empty ledger.
    await engine.decide(request({ amount: 200n / 2n }), config); // 100, active
    await engine.decide(request({ amount: 100n }), config); // 100, active
    const third = await engine.decide(request({ amount: 60n }), config);
    expect(third).toMatchObject({ kind: "deny", code: "daily_cap_exceeded" });
  });

  it("counts committed reservations", async () => {
    const first = await engine.decide(request({ amount: 100n }), config);
    if (first.kind === "deny") throw new Error("expected a reservation");
    await engine.commitReservation(first.reservationId, '{"txHash":"0x1"}');

    await engine.decide(request({ amount: 100n }), config);
    const third = await engine.decide(request({ amount: 60n }), config);
    expect(third).toMatchObject({ kind: "deny", code: "daily_cap_exceeded" });
  });

  it("does not count released reservations — a failed payment must give its budget back", async () => {
    const first = await engine.decide(request({ amount: 100n }), config);
    if (first.kind === "deny") throw new Error("expected a reservation");
    await engine.decide(request({ amount: 100n }), config);

    // 200 of 250 is now spoken for, so 60 does not fit...
    expect((await engine.decide(request({ amount: 60n }), config)).kind).toBe("deny");

    // ...until the first payment fails and releases its hold.
    await engine.releaseReservation(first.reservationId);
    expect((await engine.decide(request({ amount: 60n }), config)).kind).toBe("needs_approval");
  });

  it("counts a reservation from 23 hours ago", async () => {
    await engine.decide(request({ amount: 100n }), config);
    clock += 23 * HOUR;
    await engine.decide(request({ amount: 100n }), config);
    const third = await engine.decide(request({ amount: 60n }), config);
    expect(third).toMatchObject({ kind: "deny", code: "daily_cap_exceeded" });
  });

  it("drops a reservation once it is more than 24 hours old", async () => {
    // Rolling window, not a calendar day: budget frees up continuously as spend ages out.
    await engine.decide(request({ amount: 100n }), config);
    await engine.decide(request({ amount: 100n }), config);
    expect((await engine.decide(request({ amount: 100n }), config)).kind).toBe("deny");

    clock += 24 * HOUR + 1;
    expect((await engine.decide(request({ amount: 100n }), config)).kind).toBe("needs_approval");
  });

  it("holds budget for a pending approval, so a second payment cannot spend it first", async () => {
    const pending = await engine.decide(request({ amount: 100n }), config);
    expect(pending.kind).toBe("needs_approval");
    await engine.decide(request({ amount: 100n }), config);
    expect((await engine.decide(request({ amount: 60n }), config)).kind).toBe("deny");
  });

  it("tracks each token's cap separately", async () => {
    const twoTokens: PolicyConfig = {
      ...config,
      perTxCap: { [STRK]: 100n, [ETH]: 100n },
      dailyCap: { [STRK]: 250n, [ETH]: 250n },
      approvalThreshold: { [STRK]: 50n, [ETH]: 50n },
    };
    await engine.decide(request({ amount: 100n }), twoTokens);
    await engine.decide(request({ amount: 100n }), twoTokens);
    // STRK is nearly spent; ETH must be untouched by that.
    expect((await engine.decide(request({ token: ETH, amount: 100n }), twoTokens)).kind).toBe(
      "needs_approval"
    );
  });

  it("resolves caps for a zero-padded token address", async () => {
    // Same trap as the allowlist: config is keyed by address, and an LLM may pad it. Falling
    // through to `token_not_configured` would be a confusing denial for a configured token.
    const padded = `0x0${STRK.slice(2)}`;
    const decision = await engine.decide(request({ token: padded, amount: 10n }), config);
    expect(decision.kind).toBe("allow");
  });
});

describe("reservation lifecycle", () => {
  it("rejects committing a reservation that does not exist", async () => {
    await expect(engine.commitReservation("no-such-id", "{}")).rejects.toThrow(/not found/i);
  });

  it("rejects releasing a reservation that does not exist", async () => {
    await expect(engine.releaseReservation("no-such-id")).rejects.toThrow(/not found/i);
  });

  it("rejects committing a reservation that was already released", async () => {
    const decision = await engine.decide(request({ amount: 10n }), config);
    if (decision.kind !== "allow") throw new Error("expected allow");
    await engine.releaseReservation(decision.reservationId);
    await expect(engine.commitReservation(decision.reservationId, "{}")).rejects.toThrow(
      /released/i
    );
  });

  it("refuses to release a reservation that was already committed", async () => {
    // Releasing a committed spend would hand the budget back for money that actually left the
    // wallet — the cap would then under-count real spending for the rest of the window.
    const decision = await engine.decide(request({ amount: 10n }), config);
    if (decision.kind !== "allow") throw new Error("expected allow");
    await engine.commitReservation(decision.reservationId, '{"txHash":"0x1"}');
    await expect(engine.releaseReservation(decision.reservationId)).rejects.toThrow(/committed/i);
  });

  it("is idempotent when releasing twice", async () => {
    const decision = await engine.decide(request({ amount: 10n }), config);
    if (decision.kind !== "allow") throw new Error("expected allow");
    await engine.releaseReservation(decision.reservationId);
    await expect(engine.releaseReservation(decision.reservationId)).resolves.toBeUndefined();
  });

  it("is idempotent when committing twice with the same receipt", async () => {
    // The caller may retry after a network blip; a second commit of the same outcome is not an error.
    const decision = await engine.decide(request({ amount: 10n }), config);
    if (decision.kind !== "allow") throw new Error("expected allow");
    await engine.commitReservation(decision.reservationId, '{"txHash":"0x1"}');
    await expect(
      engine.commitReservation(decision.reservationId, '{"txHash":"0x1"}')
    ).resolves.toBeUndefined();
  });
});

describe("decision log (audit trail)", () => {
  it("records allows and denies alike, newest first", async () => {
    await engine.decide(request({ amount: 10n }), config);
    await engine.decide(request({ recipient: MALLORY }), config);

    const log = await engine.recentDecisions(10);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ decision: "deny", code: "recipient_not_allowlisted" });
    expect(log[1]).toMatchObject({ decision: "allow", amount: 10n });
  });
});

describe("idempotency (hard rule 3)", () => {
  it("returns the original decision when the same key is replayed", async () => {
    // LLMs retry tool calls. A replay must return the first answer, never re-execute.
    const req = request({ amount: 10n });
    const first = await engine.decide(req, config);
    const replay = await engine.decide(req, config);
    expect(replay).toEqual(first);
  });

  it("does not create a second reservation on replay", async () => {
    const req = request({ amount: 100n });
    await engine.decide(req, config);
    await engine.decide(req, config);
    await engine.decide(req, config);
    // Three calls, one key: only 100 of the 250 daily cap should be spoken for, so 100 more fits.
    expect((await engine.decide(request({ amount: 100n }), config)).kind).toBe("needs_approval");
  });

  it("replays a denial as the same denial", async () => {
    const req = request({ recipient: MALLORY });
    const first = await engine.decide(req, config);
    expect(await engine.decide(req, config)).toEqual(first);
  });

  it("replays needs_approval with the same ticket, not a second one", async () => {
    // A new ticket per retry would spam the owner's Telegram with duplicates of one payment.
    const req = request({ amount: 51n });
    const first = await engine.decide(req, config);
    const replay = await engine.decide(req, config);
    expect(replay).toEqual(first);
  });

  it("denies a key reused for a DIFFERENT request", async () => {
    // The dangerous case: an agent retries with the same key but a larger amount. Returning the
    // stored "allow" would authorise a payment nobody evaluated.
    const key = "shared-key";
    await engine.decide(request({ idempotencyKey: key, amount: 10n }), config);
    const conflicting = await engine.decide(
      request({ idempotencyKey: key, amount: 90n }),
      config
    );
    expect(conflicting).toMatchObject({ kind: "deny", code: "idempotency_key_reused" });
  });

  it("treats a changed recipient as a different request", async () => {
    const key = "shared-key-2";
    await engine.decide(request({ idempotencyKey: key, recipient: ALICE }), config);
    const conflicting = await engine.decide(
      request({ idempotencyKey: key, recipient: "0x0cafe" }),
      { ...config, allowlist: "any" }
    );
    expect(conflicting).toMatchObject({ kind: "deny", code: "idempotency_key_reused" });
  });
});

describe("fail closed (hard rule 4)", () => {
  it("denies rather than throwing when storage is unavailable", async () => {
    engine.close();
    const decision = await engine.decide(request({ amount: 10n }), config);
    expect(decision).toMatchObject({ kind: "deny", code: "storage_unavailable" });
  });
});

describe("concurrent spending", () => {
  it("never lets parallel payments exceed the daily cap", async () => {
    // The headline race: ten tool calls fired at once against a cap that fits only two.
    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => engine.decide(request({ amount: 100n }), config))
    );

    const granted = decisions.filter((d) => d.kind !== "deny");
    expect(granted).toHaveLength(2); // 2 x 100 fits under 250; the rest must be refused
    expect(decisions.filter((d) => d.kind === "deny")).toHaveLength(8);
  });

  it("keeps the reserved total at or under the cap after a parallel burst", async () => {
    await Promise.all(
      Array.from({ length: 20 }, () => engine.decide(request({ amount: 60n }), config))
    );
    const log = await engine.recentDecisions(100);
    const reserved = log
      .filter((entry) => entry.decision !== "deny")
      .reduce((total, entry) => total + entry.amount, 0n);
    expect(reserved).toBeLessThanOrEqual(config.dailyCap[STRK]!);
  });
});

describe("persistence across restarts", () => {
  // Regression guard rather than a TDD cycle: file-backed storage already works via dbPath, but
  // nothing else in this suite exercises it, and "the caps reset when the server restarts" is
  // exactly the bug that would go unnoticed until it mattered.
  it("remembers reservations and idempotency after the process restarts", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "kese-policy-"));
    const dbPath = join(dir, "policy.sqlite");
    const key = "survives-restart";

    try {
      const first = createPolicyEngine({ dbPath, now: () => clock });
      const original = await first.decide(request({ idempotencyKey: key, amount: 100n }), config);
      expect(original.kind).toBe("needs_approval");
      first.close();

      const second = createPolicyEngine({ dbPath, now: () => clock });
      // The reservation still counts against the cap...
      await second.decide(request({ amount: 100n }), config);
      expect((await second.decide(request({ amount: 100n }), config)).kind).toBe("deny");
      // ...and the idempotency key still replays its original decision.
      expect(await second.decide(request({ idempotencyKey: key, amount: 100n }), config)).toEqual(
        original
      );
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
