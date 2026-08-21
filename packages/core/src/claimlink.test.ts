/**
 * Claim-link secrets.
 *
 * CLAUDE.md hard rule 7: generated server-side with a CSPRNG, only the commitment is stored, and
 * the secret is shown once. Two independent secrets are needed — one that travels in the link, one
 * the payer keeps to refund after expiry — and the *independence* is enforced here, because the
 * contract structurally cannot check it: it only ever sees hashes.
 */

import { describe, expect, it } from "vitest";
import { claimCommitment, createClaimLink, refundCommitment } from "./claimlink.js";

/** Field prime for felt252. Every secret has to land below it or the contract cannot hold it. */
const STARK_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;

describe("createClaimLink", () => {
  it("produces two DIFFERENT secrets", () => {
    // The contract cannot enforce this — it sees only hashes, and one reused secret hashes to two
    // different values under the two tags. So a recipient who learned the claim secret could also
    // refund with it. Independence has to hold here or nowhere.
    const link = createClaimLink("https://kese.example/claim");
    expect(link.claimSecret).not.toBe(link.refundSecret);
  });

  it("produces fresh secrets on every call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(createClaimLink("https://x").claimSecret);
    expect(seen.size).toBe(50);
  });

  it("produces secrets inside the felt252 field", () => {
    for (let i = 0; i < 20; i++) {
      const link = createClaimLink("https://x");
      for (const secret of [link.claimSecret, link.refundSecret]) {
        const value = BigInt(secret);
        expect(value).toBeGreaterThan(0n);
        expect(value).toBeLessThan(STARK_PRIME);
      }
    }
  });

  it("puts the claim secret in the URL and the refund secret nowhere near it", () => {
    // The link is handed to a stranger. A refund secret in it would let the recipient take the
    // money back from the payer after expiry as well.
    const link = createClaimLink("https://kese.example/claim");
    expect(link.claimUrl).toContain(link.claimSecret);
    expect(link.claimUrl).not.toContain(link.refundSecret);
  });

  it("derives commitments that differ from each other", () => {
    const link = createClaimLink("https://x");
    expect(link.commitmentHash).not.toBe(link.refundHash);
  });

  it("never puts a commitment hash where the secret belongs, or vice versa", () => {
    const link = createClaimLink("https://x");
    expect(link.commitmentHash).toBe(claimCommitment(link.claimSecret));
    expect(link.refundHash).toBe(refundCommitment(link.refundSecret));
  });

  it("handles a base URL that already has a trailing slash", () => {
    const link = createClaimLink("https://kese.example/claim/");
    expect(link.claimUrl).not.toContain("//claim//");
  });
});

describe("commitments", () => {
  it("is deterministic for a given secret", () => {
    const secret = "0x1234";
    expect(claimCommitment(secret)).toBe(claimCommitment(secret));
  });

  it("matches the value Cairo computes for the same input", () => {
    // The contract verifies what this produces. If the two ever disagree, every link becomes
    // unclaimable — and it would present as "wrong secret", not "wrong hash function". The same
    // constant is asserted from the Cairo side in contracts/escrow-claim/src/tests.cairo.
    const secret = "0x636c61696d2d7365637265742d616263"; // 'claim-secret-abc' as a short string
    expect(claimCommitment(secret)).toBe(
      "0x333440d178fae15c855d393fa65d309453dabcb249ead3f1bd14aa343edc53c"
    );
  });

  it("separates the claim and refund domains for the same secret", () => {
    const secret = "0x1234";
    expect(claimCommitment(secret)).not.toBe(refundCommitment(secret));
  });
});
