/**
 * Reading the owner's on-chain activity.
 *
 * There is one trap here and it is silent. A private transaction reaches the chain through a
 * RELAYER, so `transaction.sender` is the same address for everybody and never the user. Code that
 * asks "what did this address do" by filtering on sender gets an empty list, or — worse, when
 * grouping — attributes every shield in the pool to one account. Neither throws. The pool's
 * `Deposit` event carries the real depositor as its FIRST indexed key, and that is the only correct
 * way to ask.
 *
 * The second thing to keep straight is that deposits and withdrawals are not symmetric:
 * `Deposit` indexes `user_addr`, while `Withdrawal` encrypts the initiator and indexes only the
 * recipient. So a shield is attributable to us and an unshield generally is not.
 */

import { describe, expect, it } from "vitest";
import { DEPOSIT_EVENT_KEY, depositFilter, parseDeposit } from "./activity.js";
import { sameAddress } from "./address.js";

const POOL = "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91";
const USER = "0x76bdc7a5e844c382e7ecb8bda23b15842fa29d0cd958f2c2a6fa4531d914062";
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

/** An RPC event as starknet_getEvents returns it: keys[0] is the selector, then the #[key] fields. */
const rawEvent = {
  from_address: POOL,
  keys: [DEPOSIT_EVENT_KEY, USER, STRK],
  data: ["0x16345785d8a0000"], // 0.1 * 10^18
  block_number: 13801442,
  transaction_hash: "0xabc",
};

describe("depositFilter", () => {
  it("filters on the Deposit selector AND the depositor key", () => {
    const filter = depositFilter({ poolAddress: POOL, userAddress: USER, fromBlock: 100 });
    expect(filter.address).toBe(POOL);
    expect(filter.keys[0]).toEqual([DEPOSIT_EVENT_KEY]);
    expect(filter.keys[1]).toEqual([USER]);
  });

  it("normalizes the depositor address before filtering", () => {
    // Felts have many spellings. An RPC returns 0x76bdc7… where config may hold 0x076bdc7…, and a
    // key filter that does not match exactly returns nothing at all — an empty history that looks
    // like "you have never deposited".
    const padded = `0x0${USER.slice(2)}`;
    const filter = depositFilter({ poolAddress: POOL, userAddress: padded, fromBlock: 0 });
    expect(filter.keys[1]).toEqual([USER]);
  });

  it("can ask for every depositor when no user is given", () => {
    // Useful for checking the query itself works against a live pool.
    const filter = depositFilter({ poolAddress: POOL, fromBlock: 0 });
    expect(filter.keys).toHaveLength(1);
  });

  it("passes the block range through", () => {
    const filter = depositFilter({ poolAddress: POOL, fromBlock: 500, toBlock: 900 });
    expect(filter.from_block).toEqual({ block_number: 500 });
    expect(filter.to_block).toEqual({ block_number: 900 });
  });

  it("defaults the upper bound to latest", () => {
    expect(depositFilter({ poolAddress: POOL, fromBlock: 0 }).to_block).toBe("latest");
  });
});

describe("parseDeposit", () => {
  it("reads the depositor from the first indexed key, not from any sender", () => {
    expect(sameAddress(parseDeposit(rawEvent)!.depositor, USER)).toBe(true);
  });

  it("reads the token from the second indexed key", () => {
    // Compared by VALUE, not spelling: parsing normalizes, so `0x04718f…` comes back as
    // `0x4718f…`. That is the point of normalizing — one canonical form — and every consumer
    // compares the same way.
    expect(sameAddress(parseDeposit(rawEvent)!.token, STRK)).toBe(true);
  });

  it("reads the amount from the data", () => {
    expect(parseDeposit(rawEvent)!.amount).toBe(10n ** 17n);
  });

  it("carries the block and transaction so the entry can be linked to an explorer", () => {
    const parsed = parseDeposit(rawEvent)!;
    expect(parsed.blockNumber).toBe(13801442);
    expect(parsed.transactionHash).toBe("0xabc");
  });

  it("returns null for an event that is not a Deposit", () => {
    // getEvents can return other events when the caller filters loosely; a wrong-shape parse would
    // silently produce a deposit that never happened.
    expect(parseDeposit({ ...rawEvent, keys: ["0xdeadbeef", USER, STRK] })).toBeNull();
  });

  it("returns null for a malformed event rather than inventing a zero deposit", () => {
    expect(parseDeposit({ ...rawEvent, keys: [DEPOSIT_EVENT_KEY], data: [] })).toBeNull();
  });
});
