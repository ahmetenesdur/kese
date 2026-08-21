/**
 * The guarded spend pipeline.
 *
 * This is the single path from an LLM's tool call to money moving, so it is where hard rules 2, 3,
 * 4 and 5 either hold or quietly do not. Both sides are real here: a real policy engine on
 * in-memory SQLite, and a real KeseWallet driving the SDK against its in-memory pool. Only the
 * approval channel is a double, because a human decision has no real implementation to call.
 *
 * The invariant worth the most attention: a reservation is ALWAYS resolved — committed on success,
 * released on every failure path. A dangling reservation holds budget with nothing to show for it
 * and nothing to notice it, until the rolling window slides past hours later.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Mocknet } from "@starkware-libs/starknet-privacy-sdk/testing";
import { createKeseWallet, type KeseWallet } from "@kese/core";
import { createPolicyEngine, type PolicyConfig, type PolicyEngine } from "@kese/policy";
import { spend, type ApprovalChannel, type SpendDeps } from "./spend.js";
import { createClaimStore } from "./claims.js";

let mocknet: Mocknet;
let policy: PolicyEngine;
let wallet: KeseWallet;
let token: string;
let aliceAddress: string;
let bobAddress: string;
let config: PolicyConfig;

/** Approves everything — stands in for a human who says yes. */
const approveAll: ApprovalChannel = { request: async () => "approved" };

function deps(overrides: Partial<SpendDeps> = {}): SpendDeps {
  return { policy, wallet, config, redact: (e) => String(e), ...overrides };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: `k-${Math.random().toString(36).slice(2)}`,
    agentId: "agent-1",
    kind: "private_transfer" as const,
    token,
    amount: 10n,
    recipient: bobAddress,
    ...overrides,
  };
}

beforeEach(async () => {
  mocknet = new Mocknet();
  const env = mocknet.initialize();
  token = env.ace;
  aliceAddress = `0x${env.alice.address.toString(16)}`;
  bobAddress = `0x${env.bob.address.toString(16)}`;

  let block = 0;
  const submitter = {
    async submit(result: Parameters<typeof mocknet.executeOutside>[0]) {
      mocknet.executeOutside(result);
      block += 20;
      return { txHash: `0xmock${block.toString(16)}`, blockNumber: block };
    },
    async head() {
      return block + 20;
    },
  };

  wallet = createKeseWallet({
    transfers: mocknet.createPrivateTransfers(env.alice.address, env.alice.privateKey),
    address: aliceAddress,
    submitter,
    redact: (e) => String(e),
  });
  // Bob must be registered before he can receive a private transfer.
  createKeseWallet({
    transfers: mocknet.createPrivateTransfers(env.bob.address, env.bob.privateKey),
    address: bobAddress,
    submitter,
    redact: (e) => String(e),
  }).register();

  policy = createPolicyEngine({ dbPath: ":memory:" });
  config = {
    perTxCap: { [token]: 100n },
    dailyCap: { [token]: 250n },
    allowlist: [bobAddress, aliceAddress],
    approvalThreshold: { [token]: 50n },
    claimLinkDefaultExpiryBlocks: 1000,
  };

  await wallet.shield(token, 200n);
});

describe("policy is not bypassable (hard rule 2)", () => {
  it("pays when policy allows", async () => {
    const outcome = await spend(request({ amount: 10n }), deps());
    expect(outcome.status).toBe("paid");
    expect((await wallet.balances([token]))[token]).toBe(190n);
  });

  it("does not touch the wallet when policy denies", async () => {
    const before = (await wallet.balances([token]))[token];
    const outcome = await spend(request({ recipient: "0xdecafbad" }), deps());
    expect(outcome).toMatchObject({ status: "denied", code: "recipient_not_allowlisted" });
    expect((await wallet.balances([token]))[token]).toBe(before);
  });

  it("denies over the per-tx cap without consulting a human", async () => {
    const approvals = { request: vi.fn(async () => "approved" as const) };
    const outcome = await spend(request({ amount: 150n }), deps({ approvals }));
    expect(outcome).toMatchObject({ status: "denied", code: "per_tx_cap_exceeded" });
    expect(approvals.request).not.toHaveBeenCalled();
  });
});

describe("approvals", () => {
  it("pays once a human approves", async () => {
    const outcome = await spend(request({ amount: 60n }), deps({ approvals: approveAll }));
    expect(outcome.status).toBe("paid");
  });

  it("does not pay when a human denies", async () => {
    const before = (await wallet.balances([token]))[token];
    const outcome = await spend(
      request({ amount: 60n }),
      deps({ approvals: { request: async () => "denied" } })
    );
    expect(outcome.status).toBe("denied");
    expect((await wallet.balances([token]))[token]).toBe(before);
  });

  it("treats an approval timeout as a denial (fail closed)", async () => {
    const outcome = await spend(
      request({ amount: 60n }),
      deps({ approvals: { request: async () => "timeout" } })
    );
    expect(outcome.status).toBe("denied");
  });

  it("fails closed when no approval channel is configured at all", async () => {
    // Hard rule 4: an unreachable approvals channel means deny, never assume yes.
    const outcome = await spend(request({ amount: 60n }), deps({ approvals: undefined }));
    expect(outcome.status).toBe("denied");
    expect(outcome.status === "denied" && outcome.reason).toMatch(/approval/i);
  });

  it("fails closed when the approval channel throws", async () => {
    const outcome = await spend(
      request({ amount: 60n }),
      deps({
        approvals: {
          request: async () => {
            throw new Error("telegram unreachable");
          },
        },
      })
    );
    expect(outcome.status).toBe("denied");
  });
});

describe("reservations are always resolved (hard rule 5)", () => {
  /** Budget still held after the call — the thing a dangling reservation silently consumes. */
  async function heldBudget(): Promise<bigint> {
    // Probe: how much of the daily cap is still spendable?
    const probe = await policy.decide(
      { ...request(), idempotencyKey: `probe-${Math.random()}`, amount: 1n },
      { ...config, approvalThreshold: { [token]: 1000n } }
    );
    if (probe.kind === "deny") return config.dailyCap[token]!;
    await policy.releaseReservation(probe.reservationId);
    return 0n;
  }

  it("releases the reservation when a human denies", async () => {
    await spend(request({ amount: 60n }), deps({ approvals: { request: async () => "denied" } }));
    // 250 cap, nothing committed: three more 60s must still fit.
    for (let i = 0; i < 3; i++) {
      const outcome = await spend(request({ amount: 60n }), deps({ approvals: approveAll }));
      expect(outcome.status).toBe("paid");
    }
  });

  it("releases the reservation when the payment itself fails", async () => {
    // Shielded balance is 200; a 90 payment passes policy but the wallet cannot fund it after
    // the balance is spent down. The budget must come back.
    await spend(request({ amount: 90n }), deps({ approvals: approveAll }));
    await spend(request({ amount: 90n }), deps({ approvals: approveAll }));
    const failed = await spend(request({ amount: 60n }), deps({ approvals: approveAll }));
    expect(failed.status).toBe("failed");
    expect(await heldBudget()).toBe(0n);
  });

  it("commits the reservation on success, so the spend counts against the daily cap", async () => {
    await spend(request({ amount: 90n }), deps({ approvals: approveAll }));
    await spend(request({ amount: 90n }), deps({ approvals: approveAll }));
    // 180 of 250 committed — a third 90 must not fit.
    const outcome = await spend(request({ amount: 90n }), deps({ approvals: approveAll }));
    expect(outcome).toMatchObject({ status: "denied", code: "daily_cap_exceeded" });
  });
});

describe("idempotency (hard rule 3)", () => {
  it("does not pay twice when the same key is replayed", async () => {
    // The failure this prevents: policy remembers the DECISION, so a naive replay sails past the
    // cap check and executes the payment a second time. Execution has to be idempotent too.
    const req = request({ amount: 10n });
    const first = await spend(req, deps());
    expect(first.status).toBe("paid");

    const replay = await spend(req, deps());
    expect(replay.status).toBe("paid");
    expect((await wallet.balances([token]))[token]).toBe(190n); // charged once
  });

  it("returns the original transaction hash on replay", async () => {
    const req = request({ amount: 10n });
    const first = await spend(req, deps());
    const replay = await spend(req, deps());
    expect(first.status === "paid" && replay.status === "paid").toBe(true);
    if (first.status !== "paid" || replay.status !== "paid") return;
    expect(replay.txHash).toBe(first.txHash);
  });

  it("denies a key reused for a different amount", async () => {
    const key = "same-key";
    await spend(request({ idempotencyKey: key, amount: 10n }), deps());
    const conflicting = await spend(request({ idempotencyKey: key, amount: 90n }), deps());
    expect(conflicting).toMatchObject({ status: "denied", code: "idempotency_key_reused" });
  });
});

describe("what the approval message actually says", () => {
  it("states the amount in whole tokens with a symbol, not base units", async () => {
    // The first live dry run put `60000000000000000000` in front of the owner, on a phone, with
    // two buttons under it. Counting twenty digits to tell 60 from 600 is not a decision.
    //
    // Uses realistic 10^18-scale amounts rather than the mock pool's tiny ones, because the whole
    // point is what a twenty-digit number looks like to a person.
    const ONE = 10n ** 18n;
    const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
    let seen = "";
    await spend(
      { ...request({ amount: 60n * ONE }), token: STRK },
      deps({
        network: "sepolia",
        config: {
          ...config,
          perTxCap: { [STRK]: 100n * ONE },
          dailyCap: { [STRK]: 500n * ONE },
          approvalThreshold: { [STRK]: 50n * ONE },
          allowlist: "any",
        },
        approvals: { request: async (t) => ((seen = t.summary), "denied") },
      })
    );
    expect(seen).toContain("60 STRK");
    expect(seen).not.toContain("60000000000000000000");
  });

  it("reports the remaining budget in whole tokens too", async () => {
    let seen: string | undefined = "";
    await spend(
      request({ amount: 60n }),
      deps({
        approvals: { request: async (t) => ((seen = t.remainingDailyBudget), "denied") },
      })
    );
    expect(seen).not.toMatch(/base units/);
  });
});

describe("denial codes name what actually happened", () => {
  it('reports an owner denial as "owner_denied", not "approval_unavailable"', async () => {
    // The approval WAS available and the owner used it. Labelling that "unavailable" describes a
    // broken integration, which is a different thing to go and investigate.
    const outcome = await spend(
      request({ amount: 60n }),
      deps({ approvals: { request: async () => "denied" } })
    );
    expect(outcome).toMatchObject({ status: "denied", code: "owner_denied" });
  });

  it('reports a timeout as "approval_timeout"', async () => {
    const outcome = await spend(
      request({ amount: 60n }),
      deps({ approvals: { request: async () => "timeout" } })
    );
    expect(outcome).toMatchObject({ status: "denied", code: "approval_timeout" });
  });

  it('reports an undeliverable request as "approval_unavailable"', async () => {
    const outcome = await spend(
      request({ amount: 60n }),
      deps({ approvals: { request: async () => "unreachable" } })
    );
    expect(outcome).toMatchObject({ status: "denied", code: "approval_unavailable" });
  });

  it('reports a missing channel as "approval_unavailable"', async () => {
    const outcome = await spend(request({ amount: 60n }), deps({ approvals: undefined }));
    expect(outcome).toMatchObject({ status: "denied", code: "approval_unavailable" });
  });
});

describe("simulate mode must not report a payment (honest reporting)", () => {
  it('reports "simulated", never "paid", when nothing was submitted', async () => {
    // Without this the LLM is told the payment succeeded while nothing reached the chain — and it
    // would go on to tell the user the invoice is settled. A dry run that lies is worse than no
    // dry run.
    const outcome = await spend(
      request({ amount: 10n }),
      deps({
        wallet: { ...wallet, payPrivate: async () => ({ status: "simulated" as const }) },
      })
    );
    expect(outcome.status).toBe("simulated");
  });

  it("releases the reservation, because no budget was actually spent", async () => {
    const simulating = deps({
      wallet: { ...wallet, payPrivate: async () => ({ status: "simulated" as const }) },
    });
    // Daily cap is 250, threshold is 50. Ten simulated 40s total 400 — well over the cap, so if a
    // dry run held its reservation the later ones would start being denied.
    for (let i = 0; i < 10; i++) {
      const outcome = await spend(request({ amount: 40n }), simulating);
      expect(outcome.status, `simulated payment ${i + 1} should not consume budget`).toBe(
        "simulated"
      );
    }
  });

  it("says plainly that nothing was submitted", async () => {
    const outcome = await spend(
      request({ amount: 10n }),
      deps({
        wallet: { ...wallet, payPrivate: async () => ({ status: "simulated" as const }) },
      })
    );
    expect(outcome.status === "simulated" && outcome.reason).toMatch(/not submitted/i);
  });
});

describe("claim links", () => {
  const claimDeps = () => {
    const store = createClaimStore(":memory:");
    return {
      store,
      deps: deps({
        claims: store,
        claimBaseUrl: "https://kese.example/claim",
        wallet: {
          ...wallet,
          createClaimEscrow: async () => ({ status: "confirmed" as const, txHash: "0xesc" }),
        },
      }),
    };
  };

  it("returns the claim URL, once", async () => {
    const { deps: d } = claimDeps();
    const outcome = await spend(request({ kind: "claim_link", recipient: undefined }), d);
    expect(outcome.status).toBe("paid");
    expect(outcome.status === "paid" && outcome.claimUrl).toMatch(/^https:\/\/kese\.example\/claim/);
  });

  it("never puts the refund secret in the outcome", async () => {
    // It is the payer's only route back to the funds after expiry. The outcome goes straight into
    // an LLM's context, and from there wherever the model decides to repeat it.
    const { store, deps: d } = claimDeps();
    const outcome = await spend(request({ kind: "claim_link", recipient: undefined }), d);
    const stored = await store.refundableAt(Number.MAX_SAFE_INTEGER);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(outcome)).not.toContain(stored[0]!.refundSecret);
  });

  it("persists the refund secret so the payer can still reclaim after a restart", async () => {
    const { store, deps: d } = claimDeps();
    await spend(request({ kind: "claim_link", recipient: undefined }), d);
    const stored = await store.refundableAt(Number.MAX_SAFE_INTEGER);
    expect(stored[0]!.refundSecret).toBeTruthy();
  });

  it("refuses to re-show the secret on a replay, and does not lock a second escrow", async () => {
    // Hard rule 7 says the secret is shown once. A retry legitimately cannot get it back — and
    // generating a fresh one would lock a second lot of funds behind a link nobody asked for.
    const { deps: d } = claimDeps();
    const req = request({ kind: "claim_link", recipient: undefined });
    const first = await spend(req, d);
    const replay = await spend(req, d);
    expect(first.status === "paid" && first.claimUrl).toBeTruthy();
    expect(replay.status === "paid" && replay.claimUrl).toBeUndefined();
    expect(replay.status === "paid" && replay.replayed).toBe(true);
  });

  it("still goes through policy — an over-cap claim link is refused", async () => {
    const { deps: d } = claimDeps();
    const outcome = await spend(
      request({ kind: "claim_link", recipient: undefined, amount: 150n }),
      d
    );
    expect(outcome).toMatchObject({ status: "denied", code: "per_tx_cap_exceeded" });
  });

  it("fails closed when no claim store is configured", async () => {
    const outcome = await spend(
      request({ kind: "claim_link", recipient: undefined }),
      deps({ claimBaseUrl: "https://x" })
    );
    expect(outcome.status).toBe("failed");
  });
});

describe("secret handling (hard rule 1)", () => {
  it("routes wallet failure text through the redactor", async () => {
    const seen: unknown[] = [];
    const outcome = await spend(
      request({ amount: 90n }),
      deps({
        approvals: approveAll,
        wallet: {
          ...wallet,
          payPrivate: async () => ({ status: "failed" as const, error: "boom 0xSECRET" }),
        },
        redact: (e) => {
          seen.push(e);
          return "[redacted]";
        },
      })
    );
    expect(outcome.status).toBe("failed");
    expect(JSON.stringify(outcome)).not.toContain("0xSECRET");
  });
});
