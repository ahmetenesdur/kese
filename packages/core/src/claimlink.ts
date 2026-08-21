/**
 * Claim-link secrets.
 *
 * A claim link pays someone who is not registered with STRK20: the payer locks funds in the escrow
 * against a commitment, and whoever holds the preimage can claim them. CLAUDE.md hard rule 7 —
 * generated server-side with a CSPRNG, only the commitment is stored, and the secret is shown once.
 *
 * **Two secrets, and they must be independent.** One travels in the link; one the payer keeps, to
 * refund after expiry. The contract structurally cannot check independence — it only ever sees
 * hashes, and a single reused secret hashes to two different values under the two domain tags, so
 * it looks perfectly correct on-chain. A recipient who learned the claim secret could then also
 * refund with it once the window opened. Independence holds here or nowhere.
 */

import { randomBytes } from "node:crypto";
import { hash, shortString } from "starknet";

/** Domain tags, matching the constants in contracts/escrow-claim/src/escrow.cairo. */
const CLAIM_TAG = shortString.encodeShortString("KESE_ESCROW_CLAIM_V1");
const REFUND_TAG = shortString.encodeShortString("KESE_ESCROW_REFUND_V1");

export interface ClaimLink {
  /**
   * SHOWN ONCE. Goes to the recipient and is never persisted, logged, or returned a second time —
   * anyone holding it can claim the funds.
   */
  claimSecret: string;
  /**
   * Server-side only. Needed to refund after expiry, and must NEVER reach the recipient or the
   * LLM: with it, the payment can be taken back.
   */
  refundSecret: string;
  /** `poseidon(CLAIM_TAG, claimSecret)` — the escrow's storage key. Safe to publish. */
  commitmentHash: string;
  /** `poseidon(REFUND_TAG, refundSecret)` — stored on-chain. Safe to publish. */
  refundHash: string;
  claimUrl: string;
}

/**
 * A random felt252.
 *
 * 31 bytes, not 32: that caps the value at 2^248, comfortably below the STARK field prime, so every
 * draw is a valid felt without rejection sampling or a modulus that would skew the distribution.
 * The zero check is theatre at these odds, but it costs nothing and the alternative is a
 * commitment anyone could guess.
 */
function randomFelt(): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const value = BigInt(`0x${randomBytes(31).toString("hex")}`);
    if (value > 0n) return `0x${value.toString(16)}`;
  }
  throw new Error("could not draw a non-zero felt; the RNG is not behaving");
}

export function claimCommitment(secret: string): string {
  return hash.computePoseidonHashOnElements([CLAIM_TAG, secret]);
}

export function refundCommitment(secret: string): string {
  return hash.computePoseidonHashOnElements([REFUND_TAG, secret]);
}

export function createClaimLink(baseUrl: string): ClaimLink {
  const claimSecret = randomFelt();
  const refundSecret = randomFelt();

  return {
    claimSecret,
    refundSecret,
    commitmentHash: claimCommitment(claimSecret),
    refundHash: refundCommitment(refundSecret),
    // The secret rides in the fragment, after `#`: fragments are not sent to the server in an HTTP
    // request, so the claim page can read it in the browser without it landing in access logs,
    // proxy logs, or a Referer header on the way.
    claimUrl: `${baseUrl.replace(/\/+$/, "")}/#${claimSecret}`,
  };
}
