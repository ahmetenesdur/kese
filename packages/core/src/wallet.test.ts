/**
 * KeseWallet tests.
 *
 * These run the SDK's REAL builder, compiler, note selection and channel logic against its
 * in-memory pool (`Mocknet`) — not against a hand-written mock of the SDK. The only thing swapped
 * out is how a compiled transaction gets applied, which is exactly the seam that differs between a
 * chain and a test. A fake `PrivateTransfers` would prove nothing about our wiring; this proves
 * the wiring end to end minus the prover.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Mocknet } from "@starkware-libs/starknet-privacy-sdk/testing";
import { createKeseWallet, type KeseWallet } from "./wallet.js";

const ONE = 1000n;

let mocknet: Mocknet;
let alice: KeseWallet;
let bob: KeseWallet;
let token: string;
let aliceAddress: string;
let bobAddress: string;

/** Applies a compiled transaction to the mock pool — the test-side submitter. */
function mocknetSubmitter(net: Mocknet) {
  let block = 0;
  return {
    async submit(result: Parameters<typeof net.executeOutside>[0]) {
      net.executeOutside(result);
      block += 20; // mock chain advances past the 10-block maturity window
      return { txHash: `0xmock${block.toString(16)}`, blockNumber: block };
    },
    async head() {
      return block + 20;
    },
  };
}

beforeEach(() => {
  mocknet = new Mocknet();
  const env = mocknet.initialize();
  token = env.ace;
  aliceAddress = `0x${env.alice.address.toString(16)}`;
  bobAddress = `0x${env.bob.address.toString(16)}`;

  const submitter = mocknetSubmitter(mocknet);
  alice = createKeseWallet({
    transfers: mocknet.createPrivateTransfers(env.alice.address, env.alice.privateKey),
    address: aliceAddress,
    submitter,
    redact: (e) => String(e),
  });
  bob = createKeseWallet({
    transfers: mocknet.createPrivateTransfers(env.bob.address, env.bob.privateKey),
    address: bobAddress,
    submitter,
    redact: (e) => String(e),
  });
});

describe("register", () => {
  it("publishes a viewing key and reports a confirmed receipt", async () => {
    const receipt = await alice.register();
    expect(receipt.status).toBe("confirmed");
    expect(receipt.txHash).toBeTruthy();
  });
});

describe("shield", () => {
  it("moves public balance into a private note", async () => {
    await alice.register();
    const receipt = await alice.shield(token, 100n);
    expect(receipt.status).toBe("confirmed");

    const balances = await alice.balances([token]);
    expect(balances[token]).toBe(100n);
  });

  it("registers on the fly when the account has no viewing key yet", async () => {
    // Regression: dropping autoRegister makes a first shield fail with "Missing channel context",
    // which reads like a channel bug rather than "you are not registered". It also cannot be worked
    // around by calling register() first in simulate mode — a simulated registration is never
    // submitted, so the account stays unregistered. Registration is an idempotent prerequisite,
    // not a spend, and the SDK only acts when the on-chain key is actually absent.
    const receipt = await alice.shield(token, 100n);
    expect(receipt.status).toBe("confirmed");
    expect((await alice.balances([token]))[token]).toBe(100n);
  });

  it("reports a failed receipt instead of throwing when the amount exceeds the public balance", async () => {
    // A money primitive that throws forces every caller to remember a try/catch; a Receipt makes
    // the failure part of the return type. The MCP layer must release its reservation either way.
    await alice.register();
    const receipt = await alice.shield(token, 10n ** 9n);
    expect(receipt.status).toBe("failed");
    expect(receipt.error).toBeTruthy();
  });
});

describe("payPrivate", () => {
  it("moves value to the recipient's shielded balance", async () => {
    await alice.register();
    await bob.register();
    await alice.shield(token, 100n);

    const receipt = await alice.payPrivate(token, 40n, bobAddress);
    expect(receipt.status).toBe("confirmed");

    expect((await bob.balances([token]))[token]).toBe(40n);
    expect((await alice.balances([token]))[token]).toBe(60n);
  });

  it("fails cleanly when the shielded balance is short", async () => {
    await alice.register();
    await bob.register();
    await alice.shield(token, 10n);

    const receipt = await alice.payPrivate(token, 999n, bobAddress);
    expect(receipt.status).toBe("failed");
    expect((await bob.balances([token]))[token]).toBe(0n);
  });

  it("opens the channel to a new recipient automatically", async () => {
    // autoSetup: a note cannot exist before its token subchannel does. Phase S learned this the
    // hard way — the mock pool reports it as the misleading "Token <n> does not exist".
    await alice.register();
    await bob.register();
    await alice.shield(token, 100n);
    expect((await alice.payPrivate(token, 10n, bobAddress)).status).toBe("confirmed");
  });
});

describe("withdraw", () => {
  it("reduces the shielded balance", async () => {
    await alice.register();
    await alice.shield(token, 100n);

    const receipt = await alice.withdraw(token, 30n, aliceAddress);
    expect(receipt.status).toBe("confirmed");
    expect((await alice.balances([token]))[token]).toBe(70n);
  });
});

describe("balances", () => {
  it("returns zero for a token with no notes rather than omitting it", async () => {
    await alice.register();
    const balances = await alice.balances([token]);
    expect(balances[token]).toBe(0n);
  });
});

describe("secret handling (hard rule 1)", () => {
  it("passes failure text through the redactor before it reaches a receipt", async () => {
    // The receipt is headed for an MCP tool result, i.e. straight into an LLM's context. Anything
    // on that path goes through the redactor — this asserts the wiring exists, not that a
    // particular string was scrubbed.
    const seen: unknown[] = [];
    const wallet = createKeseWallet({
      transfers: mocknet.createPrivateTransfers(0xa11cen, 12345n),
      address: aliceAddress,
      submitter: mocknetSubmitter(mocknet),
      redact: (e) => {
        seen.push(e);
        return "[redacted]";
      },
    });

    const receipt = await wallet.shield(token, 10n ** 9n);
    expect(receipt.status).toBe("failed");
    expect(seen.length).toBeGreaterThan(0);
    expect(receipt.error).toBe("[redacted]");
  });
});
