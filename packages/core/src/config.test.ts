/**
 * Tests for env/network resolution — with the weight on `createRedactor`.
 *
 * Redaction is hard-rule-1 machinery (CLAUDE.md): it is the last thing standing between a
 * signer key and a log line, an error message, or an MCP tool result an LLM can read. It is
 * also the kind of code that is never exercised in normal runs, so it gets tested directly.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_VIEWING_KEY,
  TOKENS,
  createRedactor,
  resolveNetwork,
  resolveNetworkConfig,
  resolveSigner,
} from "./config.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const VIEWING_KEY = "1234567890123456789012345678901234567890";

const fullEnv = {
  KESE_NETWORK: "sepolia",
  RPC_URL_SEPOLIA: "https://sepolia.example/rpc/secret-path",
  POOL_ADDRESS_SEPOLIA: "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91",
  ACCOUNT_ADDRESS: "0x04a1ce",
  ACCOUNT_PRIVATE_KEY: PRIVATE_KEY,
  VIEWING_KEY,
};

describe("resolveNetwork", () => {
  it("defaults to sepolia — testnet-first is the PLAN.md rule, so it must be the fallback", () => {
    expect(resolveNetwork({})).toBe("sepolia");
  });

  it("rejects an unknown network rather than silently picking one", () => {
    expect(() => resolveNetwork({ KESE_NETWORK: "goerli" })).toThrow(/must be/);
  });

  it("is case-insensitive", () => {
    expect(resolveNetwork({ KESE_NETWORK: "MAINNET" })).toBe("mainnet");
  });
});

describe("resolveNetworkConfig", () => {
  it("selects per-network vars from KESE_NETWORK", () => {
    const { value } = resolveNetworkConfig({
      ...fullEnv,
      KESE_NETWORK: "mainnet",
      RPC_URL_MAINNET: "https://mainnet.example",
      POOL_ADDRESS_MAINNET: "0xdead",
    });
    expect(value?.network).toBe("mainnet");
    expect(value?.rpcUrl).toBe("https://mainnet.example");
    expect(value?.poolAddress).toBe("0xdead");
  });

  it("reports every missing var at once instead of failing on the first", () => {
    const { value, missing } = resolveNetworkConfig({ KESE_NETWORK: "sepolia" });
    expect(value).toBeNull();
    expect(missing).toEqual(["RPC_URL_SEPOLIA", "POOL_ADDRESS_SEPOLIA"]);
  });

  it("treats an empty or whitespace value as absent — .env files are full of blank keys", () => {
    const { missing } = resolveNetworkConfig({
      KESE_NETWORK: "sepolia",
      RPC_URL_SEPOLIA: "   ",
      POOL_ADDRESS_SEPOLIA: "",
    });
    expect(missing).toContain("RPC_URL_SEPOLIA");
    expect(missing).toContain("POOL_ADDRESS_SEPOLIA");
  });

  it("leaves the proving URL null rather than inventing one (fail closed)", () => {
    const { value } = resolveNetworkConfig(fullEnv);
    expect(value?.provingServiceUrl).toBeNull();
    expect(value?.indexerUrl).toBeNull();
  });
});

describe("resolveSigner", () => {
  it("parses the viewing key to a bigint — a string here silently misbehaves (notes §2)", () => {
    const { value } = resolveSigner(fullEnv);
    expect(typeof value?.viewingKey).toBe("bigint");
    expect(value?.viewingKey).toBe(BigInt(VIEWING_KEY));
  });

  it("accepts a 0x-hex viewing key as the same bigint", () => {
    const { value } = resolveSigner({ ...fullEnv, VIEWING_KEY: "0xff" });
    expect(value?.viewingKey).toBe(255n);
  });

  it("rejects an unparseable viewing key without echoing it", () => {
    const { value, missing } = resolveSigner({ ...fullEnv, VIEWING_KEY: "not-a-number" });
    expect(value).toBeNull();
    expect(missing.join(" ")).not.toContain("not-a-number");
  });

  it("rejects a zero viewing key", () => {
    const { value } = resolveSigner({ ...fullEnv, VIEWING_KEY: "0" });
    expect(value).toBeNull();
  });

  it("rejects a viewing key above MAX_VIEWING_KEY — the range is [1, n/2], not [1, n)", () => {
    const { value, missing } = resolveSigner({
      ...fullEnv,
      VIEWING_KEY: (MAX_VIEWING_KEY + 1n).toString(),
    });
    expect(value).toBeNull();
    expect(missing.join(" ")).toMatch(/out of range/);
  });

  it("accepts exactly MAX_VIEWING_KEY (inclusive bound)", () => {
    const { value } = resolveSigner({ ...fullEnv, VIEWING_KEY: MAX_VIEWING_KEY.toString() });
    expect(value?.viewingKey).toBe(MAX_VIEWING_KEY);
  });
});

describe("createRedactor (hard rule 1)", () => {
  it("scrubs the private key from an error message", () => {
    const redact = createRedactor(fullEnv);
    const output = redact(new Error(`rpc failed with signer ${PRIVATE_KEY}`));
    expect(output).not.toContain(PRIVATE_KEY);
    expect(output).toContain("[REDACTED]");
  });

  it("scrubs the viewing key in the other notation — the SDK converts hex⇄decimal internally", () => {
    const redact = createRedactor({ ...fullEnv, VIEWING_KEY: "0xdeadbeefdeadbeef" });
    const asDecimal = BigInt("0xdeadbeefdeadbeef").toString(10);
    expect(redact(`calldata: [${asDecimal}]`)).not.toContain(asDecimal);
  });

  it("scrubs secrets nested inside an object, including bigint fields", () => {
    const redact = createRedactor(fullEnv);
    const output = redact({ calldata: [PRIVATE_KEY], viewingKey: BigInt(VIEWING_KEY) });
    expect(output).not.toContain(PRIVATE_KEY);
    expect(output).not.toContain(VIEWING_KEY);
  });

  it("scrubs the Telegram bot token", () => {
    const token = "8123456789:AAH-verysecrettokenvalue";
    const redact = createRedactor({ ...fullEnv, TELEGRAM_BOT_TOKEN: token });
    expect(redact(`401 from bot ${token}`)).not.toContain(token);
  });

  it("leaves public data legible — over-redaction would blind the operator", () => {
    const redact = createRedactor(fullEnv);
    const output = redact(new Error("pool 0x0254a6b2 reverted: INSUFFICIENT_BALANCE"));
    expect(output).toContain("INSUFFICIENT_BALANCE");
    expect(output).toContain("0x0254a6b2");
  });

  it("does not blank the output when no secrets are configured", () => {
    const redact = createRedactor({});
    expect(redact("plain message")).toBe("plain message");
  });

  it("survives a circular object rather than throwing inside an error path", () => {
    const circular: Record<string, unknown> = { name: "ctx" };
    circular.self = circular;
    expect(() => createRedactor(fullEnv)(circular)).not.toThrow();
  });
});

describe("TOKENS", () => {
  it("knows STRK on both networks", () => {
    expect(TOKENS.sepolia.STRK).toMatch(/^0x/);
    expect(TOKENS.mainnet.STRK).toBe(TOKENS.sepolia.STRK);
  });
});
