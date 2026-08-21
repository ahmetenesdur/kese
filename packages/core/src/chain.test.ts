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
import { mainnetArmingError, blocksUntilProvable } from "./chain.js";

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

describe("mainnetArmingError", () => {
  const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

  it("lets sepolia through with nothing set", () => {
    expect(mainnetArmingError("sepolia", {}, day("2026-08-21"))).toBeNull();
  });

  it("refuses sepolia when mainnet arming is set — the combination is a typo, not a config", () => {
    // What actually happened: a transfer typed with the arming date but without KESE_NETWORK ran
    // on Sepolia while the output was read as mainnet. Nothing was lost because the tokens were
    // test tokens; the lesson is that the numbers on screen belonged to the wrong chain.
    const error = mainnetArmingError("sepolia", { KESE_MAINNET_ARMED: "2026-08-21" }, day("2026-08-21"));
    expect(error).toContain("KESE_NETWORK");
    expect(error).toContain("sepolia");
  });

  it("blocks mainnet when nothing is set, and says what to set", () => {
    const error = mainnetArmingError("mainnet", {}, day("2026-08-21"));
    expect(error).toContain("KESE_MAINNET_ARMED is not set");
    expect(error).toContain("2026-08-21");
  });

  it("allows mainnet when armed for today", () => {
    expect(
      mainnetArmingError("mainnet", { KESE_MAINNET_ARMED: "2026-08-21" }, day("2026-08-21"))
    ).toBeNull();
  });

  it("blocks yesterday's arming — the whole point of a date", () => {
    const error = mainnetArmingError(
      "mainnet",
      { KESE_MAINNET_ARMED: "2026-08-20" },
      day("2026-08-21")
    );
    expect(error).toContain("2026-08-20");
    expect(error).toContain("today is 2026-08-21");
  });

  it("rejects a truthy value that is not a date, rather than treating it as consent", () => {
    // `yes` is what someone reaches for by reflex. It must not work, or the expiry is decorative.
    expect(
      mainnetArmingError("mainnet", { KESE_MAINNET_ARMED: "yes" }, day("2026-08-21"))
    ).toContain("re-set it deliberately");
  });

  it("ignores surrounding whitespace, which .env files collect", () => {
    expect(
      mainnetArmingError("mainnet", { KESE_MAINNET_ARMED: "  2026-08-21 " }, day("2026-08-21"))
    ).toBeNull();
  });

  it("uses UTC, not local time — a date is only unambiguous if the zone is fixed", () => {
    // 23:30 UTC on the 21st is already the 22nd in Istanbul; arming must follow UTC.
    expect(
      mainnetArmingError(
        "mainnet",
        { KESE_MAINNET_ARMED: "2026-08-21" },
        new Date("2026-08-21T23:30:00Z")
      )
    ).toBeNull();
  });
});
