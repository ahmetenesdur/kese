/**
 * Claim-link records.
 *
 * Two secrets exist per link and they have opposite handling rules. The CLAIM secret is a bearer
 * token for one payment — the agent's whole job is to hand it to the recipient, so it reaches the
 * LLM once and is never stored. The REFUND secret is the payer's, it is the only way to get the
 * money back after expiry, and it must never leave the server.
 *
 * So this store keeps exactly the half that must persist, and refuses to serve the half that must
 * not.
 */

import { describe, expect, it } from "vitest";
import { createClaimStore } from "./claims.js";

const record = {
  idempotencyKey: "idem-claim-001",
  commitmentHash: "0xc0",
  refundSecret: "0xr0",
  token: "0xstrk",
  amount: 5n * 10n ** 18n,
  expiryBlock: 900_000,
};

describe("createClaimStore", () => {
  it("keeps the refund secret so the payer can reclaim after expiry", async () => {
    const store = createClaimStore(":memory:");
    await store.put(record);
    const found = await store.byCommitment("0xc0");
    expect(found?.refundSecret).toBe("0xr0");
  });

  it("stores the amount without losing precision at 10^18", async () => {
    const store = createClaimStore(":memory:");
    await store.put(record);
    expect((await store.byCommitment("0xc0"))?.amount).toBe(5n * 10n ** 18n);
  });

  it("returns null for a commitment it has never seen", async () => {
    const store = createClaimStore(":memory:");
    expect(await store.byCommitment("0xnope")).toBeNull();
  });

  it("finds a link by the idempotency key that created it", async () => {
    // A retry has to learn that this key already made a link, so it does not lock a second lot of
    // funds behind a second secret.
    const store = createClaimStore(":memory:");
    await store.put(record);
    expect((await store.byIdempotencyKey("idem-claim-001"))?.commitmentHash).toBe("0xc0");
  });

  it("drops the claim secret even when a caller passes one", async () => {
    // Nothing to leak later. The claim secret is shown once and exists nowhere afterwards, so a
    // stolen copy of this database yields the refund path and never the claim path. Asserted by
    // handing it one anyway — a store that quietly persisted an extra field would be worse than
    // one that rejected it.
    const store = createClaimStore(":memory:");
    const leaked = "0xDEADBEEFCLAIMSECRET";
    await store.put({ ...record, claimSecret: leaked } as never);
    const found = await store.byCommitment("0xc0");
    expect(Object.keys(found ?? {})).not.toContain("claimSecret");
    expect(JSON.stringify(found, (_k, v) => (typeof v === "bigint" ? `${v}` : v))).not.toContain(
      leaked
    );
  });

  it("marks a link settled once it is claimed or refunded", async () => {
    const store = createClaimStore(":memory:");
    await store.put(record);
    await store.markSettled("0xc0", "claimed");
    expect((await store.byCommitment("0xc0"))?.state).toBe("claimed");
  });

  it("lists links that are refundable at a given block", async () => {
    // What the payer needs to know: which of my links expired without being claimed?
    const store = createClaimStore(":memory:");
    await store.put(record);
    await store.put({ ...record, idempotencyKey: "idem-2", commitmentHash: "0xc1", expiryBlock: 10 });
    const refundable = await store.refundableAt(100);
    expect(refundable.map((r) => r.commitmentHash)).toEqual(["0xc1"]);
  });

  it("does not list a settled link as refundable", async () => {
    const store = createClaimStore(":memory:");
    await store.put({ ...record, expiryBlock: 10 });
    await store.markSettled(record.commitmentHash, "claimed");
    expect(await store.refundableAt(100)).toEqual([]);
  });
});
