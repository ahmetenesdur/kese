/**
 * Tool contract tests.
 *
 * These drive a real MCP client over an in-memory transport, so what is asserted is what a model
 * would actually see: the registered schemas, the annotations, and the results of real calls. The
 * money tools run the whole guarded pipeline against a real policy engine and a real wallet.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Mocknet } from "@starkware-libs/starknet-privacy-sdk/testing";
import { createKeseWallet, type KeseWallet } from "@kese/core";
import { createPolicyEngine, type PolicyConfig, type PolicyEngine } from "@kese/policy";
import { createKeseMcpServer } from "./server.js";
import { TOOLS } from "./tools.js";

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ONE = 10n ** 18n;
const BOB = "0x0b0b";

let client: Client;
let policy: PolicyEngine;
let wallet: KeseWallet;

/** A wallet stub is right here: these tests are about the TOOL contract, not the SDK wiring. */
function stubWallet(overrides: Partial<KeseWallet> = {}): KeseWallet {
  return {
    register: async () => ({ status: "confirmed" as const }),
    shield: async () => ({ status: "confirmed" as const }),
    payPrivate: async () => ({ status: "confirmed" as const, txHash: "0xpaid", blockNumber: 7 }),
    withdraw: async () => ({ status: "confirmed" as const, txHash: "0xout", blockNumber: 8 }),
    balances: async () => ({ [STRK]: 42n * ONE }),
    ...overrides,
  } as KeseWallet;
}

const config: PolicyConfig = {
  perTxCap: { [STRK]: 100n * ONE },
  dailyCap: { [STRK]: 250n * ONE },
  allowlist: [BOB],
  approvalThreshold: { [STRK]: 50n * ONE },
  claimLinkDefaultExpiryBlocks: 1000,
};

async function connect(wallet_: KeseWallet = stubWallet()) {
  wallet = wallet_;
  policy = createPolicyEngine({ dbPath: ":memory:" });
  const server = createKeseMcpServer({
    policy,
    wallet,
    config,
    network: "sepolia",
    redact: (e) => String(e),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
}

function parse(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text: string }[] }).content;
  const text = content[0]!.text;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Surface the tool's own error text — a JSON parse failure here otherwise hides the real cause.
    throw new Error(`tool returned non-JSON: ${text}`);
  }
}

beforeEach(async () => {
  await connect();
});

describe("tool inventory", () => {
  it("exposes exactly the documented tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it("prefixes every tool name, so it cannot collide with another wallet MCP server", async () => {
    // A bare `withdraw` alongside a second wallet server is an ambiguity the model resolves by
    // guessing. For a money tool that is a safety problem, not an ergonomic one.
    const { tools } = await client.listTools();
    expect(tools.every((t) => t.name.startsWith("kese_"))).toBe(true);
  });

  it("marks the read-only tools read-only and the money tools destructive", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const spec = TOOLS.find((t) => t.name === tool.name)!;
      expect(tool.annotations?.readOnlyHint).toBe(!spec.money);
      expect(tool.annotations?.destructiveHint).toBe(spec.money);
    }
  });
});

describe("idempotency_key is required (hard rule 3)", () => {
  it("declares idempotency_key as required on every money tool", async () => {
    const { tools } = await client.listTools();
    for (const spec of TOOLS.filter((t) => t.money)) {
      const tool = tools.find((t) => t.name === spec.name)!;
      const schema = tool.inputSchema as { required?: string[] };
      expect(schema.required, `${spec.name} must require idempotency_key`).toContain(
        "idempotency_key"
      );
    }
  });

  it("rejects a payment with no idempotency_key", async () => {
    // The SDK reports a schema violation as an error RESULT, not a rejection, so assert on that
    // rather than on a throw — and make sure the message names the missing field.
    const result = await client.callTool({
      name: "kese_pay_private",
      arguments: { token: "STRK", amount: "1", recipient: BOB },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/idempotency_key/);
  });

  it("rejects an amount written in base units instead of whole tokens", async () => {
    // Guard-rail on the most dangerous input mistake available to a model.
    const result = await client.callTool({
      name: "kese_pay_private",
      arguments: { token: "STRK", amount: "1e18", recipient: BOB, idempotency_key: "idem-sci-001" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

describe("kese_pay_private", () => {
  it("pays when the policy allows", async () => {
    const result = await client.callTool({
      name: "kese_pay_private",
      arguments: { token: "STRK", amount: "1", recipient: BOB, idempotency_key: "idem-pay-001" },
    });
    expect(parse(result)).toMatchObject({ status: "paid", txHash: "0xpaid" });
  });

  it("reads amounts as whole tokens, not base units", async () => {
    // "1.5" must mean 1.5 STRK. Reading it as wei would silently pay ~nothing; the reverse would
    // overpay by 10^18, and only the caps would stand in the way.
    let seen = 0n;
    await connect(stubWallet({
      payPrivate: async (_t, amount) => {
        seen = amount;
        return { status: "confirmed", txHash: "0x1" };
      },
    }));
    await client.callTool({
      name: "kese_pay_private",
      arguments: { token: "STRK", amount: "1.5", recipient: BOB, idempotency_key: "idem-pay-002" },
    });
    expect(seen).toBe(ONE + ONE / 2n);
  });

  it("refuses a recipient that is not on the allowlist, without touching the wallet", async () => {
    let called = false;
    await connect(stubWallet({
      payPrivate: async () => {
        called = true;
        return { status: "confirmed" };
      },
    }));
    const result = await client.callTool({
      name: "kese_pay_private",
      arguments: { token: "STRK", amount: "1", recipient: "0xdecafbad", idempotency_key: "idem-pay-003" },
    });
    expect(parse(result)).toMatchObject({ status: "denied", code: "recipient_not_allowlisted" });
    expect(called).toBe(false);
  });

  it("refuses above the cap without asking a human", async () => {
    const result = await client.callTool({
      name: "kese_pay_private",
      arguments: { token: "STRK", amount: "150", recipient: BOB, idempotency_key: "idem-pay-004" },
    });
    expect(parse(result)).toMatchObject({ status: "denied", code: "per_tx_cap_exceeded" });
  });

  it("fails closed above the approval threshold when no channel is configured", async () => {
    const result = await client.callTool({
      name: "kese_pay_private",
      arguments: { token: "STRK", amount: "60", recipient: BOB, idempotency_key: "idem-pay-005" },
    });
    expect(parse(result)).toMatchObject({ status: "denied" });
  });

  it("returns the original result when a key is replayed, without paying twice", async () => {
    let calls = 0;
    await connect(stubWallet({
      payPrivate: async () => {
        calls++;
        return { status: "confirmed", txHash: "0xonce" };
      },
    }));
    const args = { token: "STRK", amount: "1", recipient: BOB, idempotency_key: "idem-pay-retry" };
    await client.callTool({ name: "kese_pay_private", arguments: args });
    const replay = await client.callTool({ name: "kese_pay_private", arguments: args });
    expect(calls).toBe(1);
    expect(parse(replay)).toMatchObject({ status: "paid", txHash: "0xonce", replayed: true });
  });

  it("names a token it does not recognise instead of failing obscurely", async () => {
    const result = await client.callTool({
      name: "kese_pay_private",
      arguments: { token: "DOGE", amount: "1", recipient: BOB, idempotency_key: "idem-pay-006" },
    });
    expect(JSON.stringify(parse(result))).toMatch(/DOGE/);
  });
});

describe("read-only tools", () => {
  it("reports balances in whole tokens", async () => {
    const result = await client.callTool({ name: "kese_get_balance", arguments: {} });
    expect(parse(result)).toMatchObject({ balances: [{ symbol: "STRK", amount: "42" }] });
  });

  it("reports the policy the agent is operating under", async () => {
    const result = await client.callTool({ name: "kese_get_policy", arguments: {} });
    expect(parse(result)).toMatchObject({
      tokens: [{ symbol: "STRK", perTxCap: "100", dailyCap: "250", approvalThreshold: "50" }],
      allowlist: [BOB],
    });
  });

  it("logs denials in the activity feed, not just successful payments", async () => {
    await client.callTool({
      name: "kese_pay_private",
      arguments: { token: "STRK", amount: "150", recipient: BOB, idempotency_key: "idem-log-001" },
    });
    const result = await client.callTool({ name: "kese_list_activity", arguments: { limit: 10 } });
    const entries = parse(result).entries as { decision: string; code?: string }[];
    expect(entries[0]).toMatchObject({ decision: "deny", code: "per_tx_cap_exceeded" });
  });
});

describe("claim links", () => {
  it("refuses rather than locking funds behind a secret it cannot keep", async () => {
    // No claim store and no claim page configured. Creating the escrow anyway would put money
    // on-chain against a refund secret with nowhere to live — unclaimable and unrefundable.
    const result = await client.callTool({
      name: "kese_create_claim_link",
      arguments: { token: "STRK", amount: "1", idempotency_key: "idem-claim-001" },
    });
    const payload = parse(result);
    expect(payload.status).toBe("failed");
    expect(String(payload.reason)).toMatch(/claim store|CLAIM_BASE_URL/i);
  });

  it("warns the model that the URL is returned once and cannot be retrieved", async () => {
    // The model decides what to do with the link. If it assumes a retry can fetch it again, it
    // will hand the recipient nothing and the funds sit until expiry.
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "kese_create_claim_link")!;
    expect(tool.description).toMatch(/ONCE/);
    expect(tool.description).toMatch(/will NOT return it again/i);
  });
});
