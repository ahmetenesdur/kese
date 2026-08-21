/**
 * Escrow calldata.
 *
 * The pool forwards this array to the escrow's `privacy_invoke` verbatim. Cairo deserialises
 * positionally, so a field out of order does not fail loudly — it deserialises into the WRONG
 * parameter. Swap `amount` and `expiry_block` and you get a deposit of one wei expiring in the year
 * 3000, which the contract will happily accept.
 *
 * The parameter order mirrors contracts/escrow-claim/src/escrow.cairo:
 *   operation, commitment_hash, refund_hash, token, amount, secret, note_id, expiry_block
 */

import { describe, expect, it } from "vitest";
import { ESCROW_OPERATION, escrowClaimCalldata, escrowDepositCalldata, escrowRefundCalldata } from "./escrow.js";

const COMMITMENT = "0x111";
const REFUND_HASH = "0x222";
const TOKEN = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const AMOUNT = 5n * 10n ** 18n;
const EXPIRY = 900_000;
const NOTE = "0x777";
const SECRET = "0x333";

describe("escrowDepositCalldata", () => {
  it("lays the fields out in the contract's parameter order", () => {
    expect(
      escrowDepositCalldata({
        commitmentHash: COMMITMENT,
        refundHash: REFUND_HASH,
        token: TOKEN,
        amount: AMOUNT,
        expiryBlock: EXPIRY,
      })
    ).toEqual([
      ESCROW_OPERATION.Deposit,
      COMMITMENT,
      REFUND_HASH,
      TOKEN,
      AMOUNT.toString(),
      "0x0", // secret — unused on deposit
      "0x0", // note_id — unused on deposit
      EXPIRY.toString(),
    ]);
  });

  it("numbers the operations the way the Cairo enum does", () => {
    // Serde encodes an enum variant as its index. Deposit=0, Claim=1, Refund=2 — getting this
    // wrong runs a different operation entirely.
    expect(ESCROW_OPERATION).toEqual({ Deposit: "0x0", Claim: "0x1", Refund: "0x2" });
  });
});

describe("escrowClaimCalldata", () => {
  it("carries the secret and the note, and leaves the commitment blank", () => {
    // The contract recomputes the key from the preimage and ignores whatever hash was passed, so
    // sending one would only invite the illusion that it matters.
    const calldata = escrowClaimCalldata({ secret: SECRET, noteId: NOTE, token: TOKEN });
    expect(calldata[0]).toBe(ESCROW_OPERATION.Claim);
    expect(calldata[5]).toBe(SECRET);
    expect(calldata[6]).toBe(NOTE);
    expect(calldata).toHaveLength(8);
  });
});

describe("escrowRefundCalldata", () => {
  it("carries the commitment as a lookup key AND the refund secret as authorisation", () => {
    // Refund needs both: the hash names the entry, the secret proves the right to it. The hash
    // alone is public, so naming an entry you cannot open gets you nothing.
    const calldata = escrowRefundCalldata({
      commitmentHash: COMMITMENT,
      secret: SECRET,
      noteId: NOTE,
      token: TOKEN,
    });
    expect(calldata[0]).toBe(ESCROW_OPERATION.Refund);
    expect(calldata[1]).toBe(COMMITMENT);
    expect(calldata[5]).toBe(SECRET);
    expect(calldata[6]).toBe(NOTE);
  });
});

describe("shape", () => {
  it("emits exactly eight felts for every operation", () => {
    // One per parameter. A short array shifts everything after the gap.
    const deposit = escrowDepositCalldata({
      commitmentHash: COMMITMENT,
      refundHash: REFUND_HASH,
      token: TOKEN,
      amount: AMOUNT,
      expiryBlock: EXPIRY,
    });
    const claim = escrowClaimCalldata({ secret: SECRET, noteId: NOTE, token: TOKEN });
    const refund = escrowRefundCalldata({
      commitmentHash: COMMITMENT,
      secret: SECRET,
      noteId: NOTE,
      token: TOKEN,
    });
    for (const calldata of [deposit, claim, refund]) expect(calldata).toHaveLength(8);
  });

  it("emits u128 amounts as decimal, not hex", () => {
    // starknet.js accepts both, but a mixed convention is how a review misses a wrong value.
    const calldata = escrowDepositCalldata({
      commitmentHash: COMMITMENT,
      refundHash: REFUND_HASH,
      token: TOKEN,
      amount: 42n,
      expiryBlock: 7,
    });
    expect(calldata[4]).toBe("42");
    expect(calldata[7]).toBe("7");
  });
});
