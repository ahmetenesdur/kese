/**
 * Gas headroom checks.
 *
 * Background: upstream issue #121 reports that proving transactions need a STRK reserve well
 * beyond what `estimateInvokeFee` returns (~24 STRK). We cannot verify that number without a
 * proving service, so it is treated as a configurable, clearly-labelled default rather than a
 * constant we vouch for. What we CAN do is make the failure legible: an agent that runs out of gas
 * mid-burst should be told it is short on gas, not handed a raw RPC revert.
 */

import { describe, expect, it } from "vitest";
import { assessGasHeadroom } from "./fees.js";

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const USDC = "0x0053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a";
const ONE = 10n ** 18n;

describe("assessGasHeadroom", () => {
  it("is satisfied when the STRK balance covers the reserve", () => {
    const result = assessGasHeadroom({
      strkBalance: 30n * ONE,
      reserve: 24n * ONE,
      spendToken: USDC,
      spendAmount: 5n * ONE,
      strkAddress: STRK,
    });
    expect(result.ok).toBe(true);
    expect(result.shortfall).toBe(0n);
  });

  it("reports the exact shortfall when the balance is under the reserve", () => {
    const result = assessGasHeadroom({
      strkBalance: 10n * ONE,
      reserve: 24n * ONE,
      spendToken: USDC,
      spendAmount: 5n * ONE,
      strkAddress: STRK,
    });
    expect(result.ok).toBe(false);
    expect(result.shortfall).toBe(14n * ONE);
  });

  it("requires reserve PLUS the payment when spending STRK itself", () => {
    // The gas token and the payment token are the same here, so the reserve cannot be double-counted
    // against the amount being shielded — this is the case that silently under-funds a burst.
    const result = assessGasHeadroom({
      strkBalance: 25n * ONE,
      reserve: 24n * ONE,
      spendToken: STRK,
      spendAmount: 5n * ONE,
      strkAddress: STRK,
    });
    expect(result.ok).toBe(false);
    expect(result.required).toBe(29n * ONE);
    expect(result.shortfall).toBe(4n * ONE);
  });

  it("treats a zero-padded STRK address as STRK", () => {
    const padded = `0x0${STRK.slice(2)}`;
    const result = assessGasHeadroom({
      strkBalance: 25n * ONE,
      reserve: 24n * ONE,
      spendToken: padded,
      spendAmount: 5n * ONE,
      strkAddress: STRK,
    });
    expect(result.required).toBe(29n * ONE);
  });

  it("is satisfied exactly at the boundary", () => {
    const result = assessGasHeadroom({
      strkBalance: 24n * ONE,
      reserve: 24n * ONE,
      spendToken: USDC,
      spendAmount: 1n * ONE,
      strkAddress: STRK,
    });
    expect(result.ok).toBe(true);
  });

  it("treats a zero reserve as no constraint, so the check can be switched off", () => {
    const result = assessGasHeadroom({
      strkBalance: 0n,
      reserve: 0n,
      spendToken: USDC,
      spendAmount: 1n * ONE,
      strkAddress: STRK,
    });
    expect(result.ok).toBe(true);
  });
});
