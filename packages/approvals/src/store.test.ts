/**
 * Ticket persistence.
 *
 * What this protects is recovery, not history: a restart mid-approval loses the promise spend() was
 * awaiting but not the reservation it holds, and only this record links the two back together.
 */

import { describe, expect, it } from "vitest";
import { createApprovalStore } from "./store.js";

const ticket = {
  id: "t-1",
  reservationId: "res-1",
  summary: "private_transfer of 60 STRK",
  reason: "over the approval threshold",
};

describe("createApprovalStore", () => {
  it("returns a pending ticket with its reservation id", async () => {
    const store = createApprovalStore(":memory:");
    await store.put(ticket);
    expect(await store.pending()).toEqual([{ id: "t-1", reservationId: "res-1" }]);
  });

  it("drops a ticket from pending once resolved", async () => {
    const store = createApprovalStore(":memory:");
    await store.put(ticket);
    await store.resolve("t-1", "approved");
    expect(await store.pending()).toEqual([]);
  });

  it("does not resurrect a resolved ticket if a stale verdict arrives", async () => {
    const store = createApprovalStore(":memory:");
    await store.put(ticket);
    await store.resolve("t-1", "denied");
    await store.resolve("t-1", "approved"); // late callback
    expect(await store.pending()).toEqual([]);
  });

  it("keeps several pending tickets apart", async () => {
    const store = createApprovalStore(":memory:");
    await store.put(ticket);
    await store.put({ ...ticket, id: "t-2", reservationId: "res-2" });
    await store.resolve("t-1", "approved");
    expect(await store.pending()).toEqual([{ id: "t-2", reservationId: "res-2" }]);
  });
});
