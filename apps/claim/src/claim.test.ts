/**
 * Claim page logic.
 *
 * Everything the page decides before a wallet is involved: read the secret, derive the commitment,
 * look the escrow up on-chain, and work out which of a handful of states the visitor is in. Kept
 * out of the DOM so it can be tested, because the failure modes here are the ones that lose money —
 * telling someone a link is claimable when it expired, or claimable when it was already taken.
 */

import { describe, expect, it } from "vitest";
import { claimStateFrom, secretFromUrl, type EscrowEntry } from "./claim.js";

const SECRET = "0x1234abcd";

const entry = (over: Partial<EscrowEntry> = {}): EscrowEntry => ({
  token: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  amount: 5n * 10n ** 18n,
  settled: false,
  expiryBlock: 1000,
  ...over,
});

describe("secretFromUrl", () => {
  it("reads the secret from the fragment", () => {
    // The fragment is never sent to a server — not in the request line, not in a Referer header —
    // so the secret stays out of access logs, proxies and analytics. That is the whole reason it
    // lives after the '#' rather than in a query string.
    expect(secretFromUrl("https://kese.example/claim/#0xabc")).toBe("0xabc");
  });

  it("returns null when there is no fragment", () => {
    expect(secretFromUrl("https://kese.example/claim/")).toBeNull();
  });

  it("returns null for an empty fragment", () => {
    expect(secretFromUrl("https://kese.example/claim/#")).toBeNull();
  });

  it("refuses a secret that is not a felt, rather than hashing nonsense", () => {
    // A truncated paste or a mangled link should say "this link is malformed", not go and look up
    // the commitment of some other value.
    expect(secretFromUrl("https://kese.example/claim/#not-a-felt")).toBeNull();
  });

  it("ignores a query string that tries to supply the secret", () => {
    // If someone builds a link with ?secret=... it would land in server logs. Not supported.
    expect(secretFromUrl("https://kese.example/claim/?secret=0xabc")).toBeNull();
  });
});

describe("claimStateFrom", () => {
  it("is claimable before expiry", () => {
    expect(claimStateFrom(entry(), 900).kind).toBe("claimable");
  });

  it("reports the amount and token so the visitor knows what they are accepting", () => {
    const state = claimStateFrom(entry(), 900);
    expect(state.kind === "claimable" && state.amount).toBe(5n * 10n ** 18n);
  });

  it("is expired at the expiry block, not one after", () => {
    // The contract uses `block < expiry` for claims, so the page must draw the line in the same
    // place — a page that says claimable at the expiry block sends the visitor into a revert.
    expect(claimStateFrom(entry(), 1000).kind).toBe("expired");
    expect(claimStateFrom(entry(), 999).kind).toBe("claimable");
  });

  it("is settled once claimed, even before expiry", () => {
    expect(claimStateFrom(entry({ settled: true }), 500).kind).toBe("settled");
  });

  it("reports settled ahead of expired, because it is the more specific truth", () => {
    expect(claimStateFrom(entry({ settled: true }), 5000).kind).toBe("settled");
  });

  it("treats a zero-amount entry as an unknown link", () => {
    // The escrow returns a zeroed struct for a commitment it has never seen. That is the shape of
    // a wrong or already-cleaned-up secret, not of a claim worth zero.
    expect(claimStateFrom(entry({ amount: 0n }), 500).kind).toBe("unknown");
  });

  it("says how long is left, so the visitor knows whether to hurry", () => {
    const state = claimStateFrom(entry({ expiryBlock: 1000 }), 900);
    expect(state.kind === "claimable" && state.blocksRemaining).toBe(100);
  });
});
