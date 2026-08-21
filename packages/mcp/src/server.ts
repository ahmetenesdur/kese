/**
 * The Kese MCP server.
 *
 * Design rules specific to putting a wallet behind an LLM:
 *
 * - **Tool names are prefixed `kese_`.** An agent typically has several MCP servers connected, and
 *   a bare `withdraw` or `get_balance` is ambiguous across them. For a money tool that ambiguity is
 *   a safety problem, not an ergonomic one — the model could pick the wrong wallet.
 * - **Amounts are whole-token decimal strings, never wei.** Asking a model to write
 *   `100000000000000000000` invites an off-by-10^18, and the direction that survives the caps is
 *   the one that overpays. "1.5" is unambiguous and gets scaled here, once.
 * - **`idempotency_key` is required on every money tool.** Models retry tool calls; the schema
 *   makes it impossible to omit, and the policy engine makes a replay safe.
 * - **Nothing returns key material.** Every error goes through the redactor before it becomes a
 *   tool result, because a tool result IS the model's context.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TOKENS, type KeseWallet, type Network } from "@kese/core";
import type { PolicyConfig, PolicyEngine } from "@kese/policy";
import { spend, type ApprovalChannel } from "./spend.js";

export interface ServerDeps {
  policy: PolicyEngine;
  wallet: KeseWallet;
  config: PolicyConfig;
  network: Network;
  approvals?: ApprovalChannel;
  redact: (input: unknown) => string;
  agentId?: string;
}

const DECIMALS = 18;

/** Shared parameter shapes, so descriptions stay identical across tools. */
const tokenParam = z
  .string()
  .describe('Token symbol ("STRK", "ETH") or a 0x address. Must be configured in the policy.');

const amountParam = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "amount must be a positive decimal number, e.g. \"1.5\"")
  .describe(
    'Amount in WHOLE TOKENS as a decimal string — "1.5" means 1.5 STRK, NOT 1.5 wei. Never pass base units.'
  );

const idempotencyParam = z
  .string()
  .min(8)
  .describe(
    "A unique key for THIS payment. Reuse the same key when retrying the same payment — it will " +
      "return the original result instead of paying twice. Use a fresh key for a genuinely new payment."
  );

export function createKeseMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "kese-mcp-server", version: "0.1.0" });
  const agentId = deps.agentId ?? "mcp-agent";

  const resolveToken = (input: string): string | null => {
    if (input.startsWith("0x")) return input;
    return TOKENS[deps.network][input.toUpperCase()] ?? null;
  };

  /** "1.5" -> 1500000000000000000n. Text-based, so no float rounding reaches a spending limit. */
  const toBaseUnits = (amount: string): bigint => {
    const [whole, fraction = ""] = amount.split(".");
    return (
      BigInt(whole!) * 10n ** BigInt(DECIMALS) + BigInt(fraction.padEnd(DECIMALS, "0") || "0")
    );
  };

  const reply = (payload: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload, bigintSafe, 2) }],
    structuredContent: JSON.parse(JSON.stringify(payload, bigintSafe)) as Record<string, unknown>,
  });

  /** Shared body for the money tools — resolve inputs, then hand to the one guarded pipeline. */
  const money = async (
    kind: "private_transfer" | "withdraw" | "claim_link",
    args: { token: string; amount: string; idempotency_key: string; recipient?: string; memo?: string }
  ) => {
    const token = resolveToken(args.token);
    if (!token) {
      return reply({
        status: "denied",
        reason: `Unknown token "${args.token}". Configured tokens: ${Object.keys(deps.config.perTxCap).join(", ")}`,
      });
    }

    const outcome = await spend(
      {
        idempotencyKey: args.idempotency_key,
        agentId,
        kind,
        token,
        amount: toBaseUnits(args.amount),
        recipient: args.recipient,
        memo: args.memo,
      },
      { policy: deps.policy, wallet: deps.wallet, config: deps.config, approvals: deps.approvals, redact: deps.redact }
    );
    return reply(outcome);
  };

  // --- reads -------------------------------------------------------------------------------

  server.registerTool(
    "kese_get_balance",
    {
      title: "Get shielded balances",
      description:
        "Return the agent's PRIVATE (shielded) balance per token, in whole tokens. This is the " +
        "balance available to spend through Kese. It does not include public wallet balances.",
      inputSchema: {
        tokens: z
          .array(tokenParam)
          .optional()
          .describe("Tokens to report. Defaults to every token the policy configures."),
      },
      outputSchema: {
        balances: z.array(z.object({ token: z.string(), symbol: z.string(), amount: z.string() })),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ tokens }) => {
      const requested = tokens?.map(resolveToken).filter((t): t is string => t !== null) ??
        Object.keys(deps.config.perTxCap);
      try {
        const raw = await deps.wallet.balances(requested);
        return reply({
          balances: requested.map((token) => ({
            token,
            symbol: symbolFor(token, deps.network),
            amount: fromBaseUnits(raw[token] ?? 0n),
          })),
        });
      } catch (error) {
        return reply({ error: deps.redact(error) });
      }
    }
  );

  server.registerTool(
    "kese_get_policy",
    {
      title: "Get spending policy",
      description:
        "Return the spending rules this agent operates under: per-transaction caps, rolling 24h " +
        "caps, the recipient allowlist, and the amount above which a human must approve. " +
        "Caps are ABSOLUTE — a payment above a cap is refused outright and cannot be approved.",
      inputSchema: {},
      outputSchema: {
        tokens: z.array(
          z.object({
            token: z.string(),
            symbol: z.string(),
            perTxCap: z.string(),
            dailyCap: z.string(),
            approvalThreshold: z.string(),
          })
        ),
        allowlist: z.union([z.literal("any"), z.array(z.string())]),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      reply({
        tokens: Object.keys(deps.config.perTxCap).map((token) => ({
          token,
          symbol: symbolFor(token, deps.network),
          perTxCap: fromBaseUnits(deps.config.perTxCap[token]!),
          dailyCap: fromBaseUnits(deps.config.dailyCap[token]!),
          approvalThreshold: fromBaseUnits(deps.config.approvalThreshold[token]!),
        })),
        allowlist: deps.config.allowlist,
      })
  );

  server.registerTool(
    "kese_list_activity",
    {
      title: "List recent payment decisions",
      description:
        "Return Kese's own decision log: what was requested, what policy decided, and why. This is " +
        "the audit trail, not the on-chain view — it includes payments that were denied and never " +
        "reached the chain.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe("Maximum entries to return."),
      },
      outputSchema: {
        count: z.number(),
        entries: z.array(
          z.object({
            at: z.string(),
            kind: z.string(),
            token: z.string(),
            amount: z.string(),
            recipient: z.string().optional(),
            decision: z.string(),
            code: z.string().optional(),
          })
        ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      const entries = await deps.policy.recentDecisions(limit);
      return reply({
        count: entries.length,
        entries: entries.map((entry) => ({
          at: new Date(entry.at).toISOString(),
          kind: entry.kind,
          token: symbolFor(entry.token, deps.network),
          amount: fromBaseUnits(entry.amount),
          recipient: entry.recipient,
          decision: entry.decision,
          code: entry.code,
        })),
      });
    }
  );

  // --- money -------------------------------------------------------------------------------

  server.registerTool(
    "kese_pay_private",
    {
      title: "Pay privately",
      description:
        "Send a PRIVATE payment from the agent's shielded balance. Sender, recipient and amount " +
        "are hidden inside the pool. The recipient must already be registered with STRK20; use " +
        "kese_create_claim_link for anyone who is not.\n\n" +
        "May return status 'denied' (policy refused — the reason says which rule) or 'failed'. " +
        "A 'denied' result is final: do not retry it with a new key, and do not try to work around it.",
      inputSchema: {
        token: tokenParam,
        amount: amountParam,
        recipient: z.string().describe("Recipient's Starknet address (0x...). Must be on the allowlist."),
        memo: z.string().max(200).optional().describe("Note for the audit log. Never sent on-chain."),
        idempotency_key: idempotencyParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        // True because of idempotency_key: replaying the same key returns the original result.
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => money("private_transfer", args)
  );

  server.registerTool(
    "kese_withdraw",
    {
      title: "Withdraw to a public address",
      description:
        "Move funds OUT of the privacy pool to a public Starknet address. This is a PUBLIC " +
        "transaction: the recipient address and the amount are visible on-chain to anyone. " +
        "Prefer kese_pay_private when the recipient supports it.",
      inputSchema: {
        token: tokenParam,
        amount: amountParam,
        to: z.string().describe("Public Starknet address to receive the funds (0x...)."),
        idempotency_key: idempotencyParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ token, amount, to, idempotency_key }) =>
      money("withdraw", { token, amount, recipient: to, idempotency_key })
  );

  server.registerTool(
    "kese_create_claim_link",
    {
      title: "Create a claim link",
      description:
        "Pay someone who is NOT registered with STRK20, by locking funds in an escrow they can " +
        "claim with a secret link. The claimed AMOUNT is public (escrow credits an open note); the " +
        "claimer's identity is not. Requires the escrow contract to be deployed.",
      inputSchema: {
        token: tokenParam,
        amount: amountParam,
        expiry_blocks: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Blocks until the link expires and the funds can be refunded to you."),
        memo: z.string().max(200).optional().describe("Note for the audit log."),
        idempotency_key: idempotencyParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => money("claim_link", args)
  );

  return server;
}

/** JSON.stringify replacer — bigints are common here and would otherwise throw. */
function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function fromBaseUnits(value: bigint): string {
  const base = 10n ** BigInt(DECIMALS);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return fraction === "" ? `${whole}` : `${whole}.${fraction}`;
}

function symbolFor(address: string, network: Network): string {
  for (const [symbol, addr] of Object.entries(TOKENS[network])) {
    if (addr.toLowerCase() === address.toLowerCase()) return symbol;
  }
  return address;
}
