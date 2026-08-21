/**
 * Block-depth sequencing.
 *
 * The 10-block rule is broader than "notes mature": ANY on-chain state a proof reads must be at
 * least 10 blocks old. That includes transparent transactions — you cannot register within ~10
 * blocks of the account's deploy, nor deposit within ~10 blocks of the ERC-20 transfer that funded
 * it, nor prove a new private transaction until the previous one's block is that deep.
 *
 * This is precisely the hazard for a burst-paying agent, so the arithmetic gets pinned down here
 * rather than living inline in a submit loop.
 */

import { describe, expect, it } from "vitest";
import { blocksUntilProvable } from "./chain.js";

describe("blocksUntilProvable", () => {
  it("is zero when nothing has been submitted yet", () => {
    expect(blocksUntilProvable(null, 500)).toBe(0);
  });

  it("is zero once the last transaction is exactly at the required depth", () => {
    // head 510, last tx at 500 => depth 10 => provable.
    expect(blocksUntilProvable(500, 510)).toBe(0);
  });

  it("counts the blocks still needed when the last transaction is too recent", () => {
    // head 503, last tx at 500 => depth 3 => 7 more blocks.
    expect(blocksUntilProvable(500, 503)).toBe(7);
  });

  it("counts a full window when the last transaction is in the head block", () => {
    expect(blocksUntilProvable(500, 500)).toBe(10);
  });

  it("is zero when the last transaction is far behind", () => {
    expect(blocksUntilProvable(100, 900)).toBe(0);
  });

  it("never returns a negative wait", () => {
    expect(blocksUntilProvable(500, 600)).toBe(0);
  });

  it("honours a custom depth", () => {
    expect(blocksUntilProvable(500, 505, 20)).toBe(15);
  });

  it("treats a head behind the last transaction as a full wait rather than negative time", () => {
    // Can happen across a reorg or an RPC serving a stale head. Waiting is the safe reading.
    expect(blocksUntilProvable(500, 495)).toBe(15);
  });
});
