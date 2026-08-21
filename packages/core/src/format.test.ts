/**
 * Human-facing amount formatting.
 *
 * This exists because of one screenshot. The first live approval message read:
 *
 *   private_transfer of 60000000000000000000 (token 0x04718f5a0fc34cc...c938d) to 0x0b0b
 *   Daily budget left after this: 440000000000000000000 (base units)
 *
 * The owner is deciding on a phone, in seconds, and that line asks them to count twenty digits to
 * tell 60 STRK from 600 STRK. Every other boundary in Kese already speaks whole tokens; the one
 * boundary with an actual human on the other side was the one still speaking wei.
 */

import { describe, expect, it } from "vitest";
import { describeAmount, formatTokenAmount, tokenSymbol } from "./format.js";

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const UNKNOWN = "0x0dead";
const ONE = 10n ** 18n;

describe("formatTokenAmount", () => {
  it("renders a whole amount without a decimal point", () => {
    expect(formatTokenAmount(60n * ONE)).toBe("60");
  });

  it("keeps a fractional part", () => {
    expect(formatTokenAmount(ONE + ONE / 2n)).toBe("1.5");
  });

  it("trims trailing zeros rather than printing eighteen of them", () => {
    expect(formatTokenAmount(ONE / 10n)).toBe("0.1");
  });

  it("renders zero as zero", () => {
    expect(formatTokenAmount(0n)).toBe("0");
  });

  it("does not lose precision on a value beyond Number's safe range", () => {
    // 12345678.000000000000000001 — the last digit is the whole point.
    expect(formatTokenAmount(12345678n * ONE + 1n)).toBe("12345678.000000000000000001");
  });

  it("renders a sub-unit amount without scientific notation", () => {
    expect(formatTokenAmount(1n)).toBe("0.000000000000000001");
  });
});

describe("tokenSymbol", () => {
  it("names a known token", () => {
    expect(tokenSymbol(STRK, "sepolia")).toBe("STRK");
  });

  it("matches a zero-padded address", () => {
    expect(tokenSymbol(`0x0${STRK.slice(2)}`, "sepolia")).toBe("STRK");
  });

  it("falls back to a shortened address for an unknown token", () => {
    // Better than the full 66 characters in a phone notification, and still identifiable.
    expect(tokenSymbol(UNKNOWN, "sepolia")).toMatch(/^0x0dead$/);
  });
});

describe("describeAmount", () => {
  it("reads the way a person would say it", () => {
    expect(describeAmount(60n * ONE, STRK, "sepolia")).toBe("60 STRK");
  });

  it("keeps an unknown token identifiable without dumping 66 characters", () => {
    const long = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c9999";
    const described = describeAmount(ONE, long, "sepolia");
    expect(described.startsWith("1 ")).toBe(true);
    expect(described.length).toBeLessThan(30);
  });
});
