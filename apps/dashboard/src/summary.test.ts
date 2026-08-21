/**
 * Assembling what the owner sees.
 *
 * The dashboard answers "where is my money and what has the agent been doing with it". Two things
 * have to be right or it quietly misleads:
 *
 *  - **Coverage.** Kese's own decision log records everything the agent ATTEMPTED, including
 *    refusals that never reached the chain. The chain records what actually SETTLED. Showing one
 *    and calling it the other is how a denied payment reads as a completed one.
 *  - **Attribution.** On-chain shields are attributable to us; withdrawals are not — the pool
 *    encrypts the initiator. The view has to say that rather than under-report and look precise.
 */

import { describe, expect, it } from "vitest";
import { buildSummary, mergeActivity } from "./summary.js";
import type { DecisionLogEntry } from "@kese/policy";

const STRK = "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ONE = 10n ** 18n;

const decision = (over: Partial<DecisionLogEntry> = {}): DecisionLogEntry => ({
  at: 1_700_000_000_000,
  idempotencyKey: "k1",
  agentId: "agent-1",
  kind: "private_transfer",
  token: STRK,
  amount: 2n * ONE,
  recipient: "0x0b0b",
  decision: "allow",
  ...over,
});

describe("buildSummary", () => {
  it("reports the shielded balance and what is left of today's budget", () => {
    const summary = buildSummary({
      network: "sepolia",
      balances: { [STRK]: 12n * ONE },
      remainingDaily: { [STRK]: 30n * ONE },
      config: {
        perTxCap: { [STRK]: 10n * ONE },
        dailyCap: { [STRK]: 50n * ONE },
        approvalThreshold: { [STRK]: 5n * ONE },
        allowlist: "any",
        claimLinkDefaultExpiryBlocks: 1000,
      },
    });
    const strk = summary.tokens[0]!;
    expect(strk.symbol).toBe("STRK");
    expect(strk.shielded).toBe("12");
    expect(strk.dailyRemaining).toBe("30");
    expect(strk.dailyCap).toBe("50");
  });

  it("reports how much of the daily budget is spent, as a fraction for a meter", () => {
    const summary = buildSummary({
      network: "sepolia",
      balances: { [STRK]: 0n },
      remainingDaily: { [STRK]: 20n * ONE },
      config: {
        perTxCap: { [STRK]: 10n * ONE },
        dailyCap: { [STRK]: 50n * ONE },
        approvalThreshold: { [STRK]: 5n * ONE },
        allowlist: "any",
        claimLinkDefaultExpiryBlocks: 1000,
      },
    });
    expect(summary.tokens[0]!.dailyUsedFraction).toBeCloseTo(0.6, 5);
  });

  it("does not divide by zero when a cap is zero", () => {
    const summary = buildSummary({
      network: "sepolia",
      balances: {},
      remainingDaily: { [STRK]: 0n },
      config: {
        perTxCap: { [STRK]: 0n },
        dailyCap: { [STRK]: 0n },
        approvalThreshold: { [STRK]: 0n },
        allowlist: "any",
        claimLinkDefaultExpiryBlocks: 1000,
      },
    });
    expect(Number.isFinite(summary.tokens[0]!.dailyUsedFraction)).toBe(true);
  });
});

describe("mergeActivity", () => {
  it("keeps refusals, which never reach the chain and are the point of the audit view", () => {
    const merged = mergeActivity({
      decisions: [decision({ decision: "deny", code: "per_tx_cap_exceeded" })],
      shields: [],
      network: "sepolia",
    });
    expect(merged).toHaveLength(1);
    // The verdict colours the row, the code explains it — the view needs both, so neither
    // collapses into the other.
    expect(merged[0]!.outcome).toBe("deny");
    expect(merged[0]!.reason).toBe("per_tx_cap_exceeded");
  });

  it("shows on-chain shields alongside the agent's own record", () => {
    const merged = mergeActivity({
      decisions: [decision()],
      shields: [
        { kind: "shield", depositor: "0xabc", token: STRK, amount: 5n * ONE, blockNumber: 100, transactionHash: "0xtx" },
      ],
      network: "sepolia",
    });
    expect(merged.map((e) => e.source).sort()).toEqual(["chain", "policy"]);
  });

  it("orders newest first, mixing both sources", () => {
    const merged = mergeActivity({
      decisions: [decision({ at: 1000 }), decision({ at: 3000, idempotencyKey: "k2" })],
      shields: [],
      network: "sepolia",
    });
    expect(merged[0]!.at).toBe(3000);
  });

  it("renders amounts in whole tokens, never base units", () => {
    const merged = mergeActivity({ decisions: [decision({ amount: 25n * ONE })], shields: [], network: "sepolia" });
    expect(merged[0]!.amount).toBe("25");
  });

  it("labels a shield as a public edge, because it is", () => {
    const merged = mergeActivity({
      decisions: [],
      shields: [{ kind: "shield", depositor: "0xabc", token: STRK, amount: ONE, blockNumber: 1 }],
      network: "sepolia",
    });
    expect(merged[0]!.visibility).toBe("public");
  });

  it("labels a private transfer as private", () => {
    const merged = mergeActivity({ decisions: [decision()], shields: [], network: "sepolia" });
    expect(merged[0]!.visibility).toBe("private");
  });

  it("labels a claim link as amount-public — the recipient is hidden, the sum is not", () => {
    // The escrow credits a claimer through an OPEN note, and open notes carry their value in
    // plaintext. Calling that simply "private" would be the dashboard telling the owner something
    // the protocol does not do.
    const merged = mergeActivity({
      decisions: [decision({ kind: "claim_link", recipient: undefined })],
      shields: [],
      network: "sepolia",
    });
    expect(merged[0]!.visibility).toBe("amount-public");
  });

  it("labels a withdrawal as a public edge too", () => {
    const merged = mergeActivity({
      decisions: [decision({ kind: "withdraw" })],
      shields: [],
      network: "sepolia",
    });
    expect(merged[0]!.visibility).toBe("public");
  });
});
