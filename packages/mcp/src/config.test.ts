/**
 * Policy config loading.
 *
 * The caps an agent runs under are edited by a human in a .env file, at speed, possibly at 2am
 * before a demo. Every parse failure here has to fail closed and say exactly which entry is wrong —
 * a config that silently drops a cap is a config with no cap.
 */

import { describe, expect, it } from "vitest";
import { loadPolicyConfig } from "./config.js";

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ONE = 10n ** 18n;

const baseEnv = {
  KESE_NETWORK: "sepolia",
  POLICY_PER_TX_CAP: "STRK:100",
  POLICY_DAILY_CAP: "STRK:250",
  POLICY_APPROVAL_THRESHOLD: "STRK:50",
  POLICY_ALLOWLIST: "0x0a11ce,0x0b0b",
};

describe("loadPolicyConfig", () => {
  it("scales whole-token amounts by the token's decimals", () => {
    // A human writes "100" meaning 100 STRK, not 100 wei. Getting this wrong by 10^18 is the kind
    // of mistake that either blocks every payment or authorises everything.
    const result = loadPolicyConfig(baseEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.perTxCap[STRK]).toBe(100n * ONE);
    expect(result.config.dailyCap[STRK]).toBe(250n * ONE);
    expect(result.config.approvalThreshold[STRK]).toBe(50n * ONE);
  });

  it("resolves a token symbol to its address", () => {
    const result = loadPolicyConfig(baseEnv);
    expect(result.ok && Object.keys(result.config.perTxCap)).toEqual([STRK]);
  });

  it("accepts a raw address in place of a symbol", () => {
    const result = loadPolicyConfig({ ...baseEnv, POLICY_PER_TX_CAP: `${STRK}:100` });
    expect(result.ok && result.config.perTxCap[STRK]).toBe(100n * ONE);
  });

  it("parses a comma-separated allowlist", () => {
    const result = loadPolicyConfig(baseEnv);
    expect(result.ok && result.config.allowlist).toEqual(["0x0a11ce", "0x0b0b"]);
  });

  it('accepts "any" as an allowlist', () => {
    const result = loadPolicyConfig({ ...baseEnv, POLICY_ALLOWLIST: "any" });
    expect(result.ok && result.config.allowlist).toBe("any");
  });

  it("supports several tokens in one entry", () => {
    const result = loadPolicyConfig({
      ...baseEnv,
      POLICY_PER_TX_CAP: "STRK:100,ETH:1",
      POLICY_DAILY_CAP: "STRK:250,ETH:2",
      POLICY_APPROVAL_THRESHOLD: "STRK:50,ETH:1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.config.perTxCap)).toHaveLength(2);
  });

  it("accepts a fractional amount without losing precision", () => {
    // Parsed as text, not through Number: `Number("0.1") * 1e18` is not 10^17, and a float
    // rounding error inside a spending limit is not something you want to debug later.
    const result = loadPolicyConfig({
      ...baseEnv,
      POLICY_PER_TX_CAP: "STRK:0.5",
      POLICY_APPROVAL_THRESHOLD: "STRK:0.1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.perTxCap[STRK]).toBe(ONE / 2n);
    expect(result.config.approvalThreshold[STRK]).toBe(ONE / 10n);
  });

  it("rejects an unknown token symbol rather than skipping it", () => {
    // Skipping would leave the token uncapped in this map — and the policy engine would then
    // report token_not_configured, which looks like a different problem entirely.
    const result = loadPolicyConfig({ ...baseEnv, POLICY_PER_TX_CAP: "DOGE:100" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(" ")).toMatch(/DOGE/);
  });

  it("rejects a malformed entry", () => {
    const result = loadPolicyConfig({ ...baseEnv, POLICY_DAILY_CAP: "STRK" });
    expect(result.ok).toBe(false);
  });

  it("rejects a negative amount", () => {
    const result = loadPolicyConfig({ ...baseEnv, POLICY_PER_TX_CAP: "STRK:-5" });
    expect(result.ok).toBe(false);
  });

  it("requires every cap to be present — a missing cap is not an unlimited one", () => {
    const { POLICY_DAILY_CAP: _omitted, ...withoutDaily } = baseEnv;
    const result = loadPolicyConfig(withoutDaily);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(" ")).toMatch(/POLICY_DAILY_CAP/);
  });

  it("rejects a token capped per-tx but with no daily cap", () => {
    // The engine denies a token missing any of the three, so catching it here turns a runtime
    // denial into a startup error the operator can actually act on.
    const result = loadPolicyConfig({
      ...baseEnv,
      POLICY_PER_TX_CAP: "STRK:100,ETH:1",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(" ")).toMatch(/ETH/);
  });

  it("rejects a per-tx cap below the approval threshold", () => {
    // Caps are absolute (D-011), so a threshold above the cap would create a band that can never
    // be approved — every payment in it is denied outright. That is a config mistake, not a policy.
    const result = loadPolicyConfig({
      ...baseEnv,
      POLICY_PER_TX_CAP: "STRK:10",
      POLICY_APPROVAL_THRESHOLD: "STRK:50",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(" ")).toMatch(/threshold/i);
  });

  it("reports every problem at once, not just the first", () => {
    const result = loadPolicyConfig({ ...baseEnv, POLICY_PER_TX_CAP: "DOGE:1", POLICY_ALLOWLIST: "" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.length).toBeGreaterThan(1);
  });
});
