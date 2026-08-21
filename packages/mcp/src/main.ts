#!/usr/bin/env node
/**
 * The Kese MCP server, as a process.
 *
 * server.ts builds the tool surface from injected dependencies; this file is where those
 * dependencies come from, and it is the only place that talks to the outside world. Four things
 * are load-bearing here and are easy to get wrong:
 *
 * **stdout belongs to the protocol.** A stdio MCP server speaks JSON-RPC over stdout. A single
 * stray `console.log` — a startup banner, a debug line — is framed as a protocol message and the
 * client's parser breaks on it. Every diagnostic in this file goes to stderr, which MCP clients
 * capture as the server's log. `say()` exists so that rule has one place to live.
 *
 * **Configuration is not optional.** A wallet server that came up with no spending limits would be
 * worse than one that failed to start, because the agent would find it working (CLAUDE.md hard
 * rule 4). Missing configuration is reported as a list and the process exits.
 *
 * **cwd is not ours to choose.** An MCP client spawns this process from wherever it likes. So the
 * `.env` is found by climbing from the module's own location as well as the cwd, and — more
 * importantly — a relative `POLICY_DB_PATH` is resolved against the project, not the cwd. That
 * database holds the idempotency records: two launches with different working directories would
 * otherwise open two different databases, and a retried payment whose key lives in the other one
 * gets executed a second time. Idempotency is only as durable as the file it is stored in.
 *
 * **Approvals outlive the process that requested them.** A reservation is taken before a human is
 * asked. If the process dies while someone is deciding, the promise is lost but the reservation is
 * not, and it goes on holding budget until the rolling window slides past it. Boot is the only
 * moment at which that can be cleaned up, so it is done here.
 */

import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  buildWallet,
  createModelRedactor,
  createRedactor,
  envSearchPath,
  loadDotEnv,
  resolveNetwork,
  resolveNetworkConfig,
  resolveSigner,
  resolveStatePath,
} from "@kese/core";
import { createPolicyEngine } from "@kese/policy";
import { createApprovalsFromEnv } from "@kese/approvals";
import { createKeseMcpServer } from "./server.js";
import { createClaimStore } from "./claims.js";
import { loadPolicyConfig } from "./config.js";

/** stderr, always — see the note about stdout above. */
function say(line = ""): void {
  process.stderr.write(`${line}\n`);
}

export async function main(): Promise<void> {
  const env = loadDotEnv({ from: envSearchPath(import.meta.url) });

  // Model-facing, deliberately. Both consumers of this one — the MCP server's tool results and the
  // wallet's failure receipts, which become tool results — are read by an LLM. The operator-facing
  // paths below call `createRedactor()` directly and keep the full stack.
  const redact = createModelRedactor();
  const net = resolveNetworkConfig();
  const signer = resolveSigner();
  const policyConfig = loadPolicyConfig();

  if (!net.value || !signer.value || !policyConfig.ok) {
    const problems = [
      ...net.missing,
      ...signer.missing,
      ...(policyConfig.ok ? [] : policyConfig.errors),
    ];

    say("kese-mcp will not start. Money tools stay unavailable until this is complete:");
    for (const problem of problems) say(`  · ${problem}`);
    say();
    say(
      env.path
        ? `Read ${env.path} — so these are missing from it, not merely unfound.`
        : `No .env was found. Looked upward from:\n${env.searched.map((d) => `  ${d}`).join("\n")}`
    );
    process.exitCode = 1;
    return;
  }

  // Relative to the project, not the caller — see the cwd note above. The rule itself lives in
  // @kese/core because the dashboard needs exactly the same one, and a safety rule with two
  // implementations has two chances to drift.
  const dbPath = resolveStatePath({
    configured: process.env.POLICY_DB_PATH,
    envPath: env.path,
  });

  const network = resolveNetwork();
  const policy = createPolicyEngine({
    dbPath,
    // A storage failure denies every payment. Without this line the only evidence is the denial
    // itself, which says nothing on purpose — so the operator sees the cause here, on stderr.
    onStorageError: (error) => say(`POLICY STORAGE: ${createRedactor()(error).split("\n")[0]}`),
  });
  const claims = createClaimStore(dbPath);
  const approvals = createApprovalsFromEnv();

  // Without a proving service the wallet compiles and checks payments against live pool state but
  // cannot submit them. That is reported per-payment as its own `simulated` outcome rather than
  // dressed up as success, but the operator should know before the first tool call, not after.
  const proving = net.value.provingServiceUrl ? "service" : "simulate";
  const { wallet } = buildWallet({ net: net.value, signer: signer.value, mode: proving, redact });

  if (approvals) {
    const stale = await approvals.pendingReservations();
    for (const reservationId of stale) await policy.releaseReservation(reservationId);
    if (stale.length > 0) {
      say(`Released ${stale.length} reservation(s) left holding budget by an interrupted approval.`);
    }
  }

  const server = createKeseMcpServer({
    policy,
    wallet,
    config: policyConfig.config,
    network,
    approvals: approvals ?? undefined,
    claims,
    claimBaseUrl: process.env.CLAIM_BASE_URL,
    redact,
    agentId: process.env.KESE_AGENT_ID,
  });

  // Announce the parts an operator needs to judge what this server can actually do. The account
  // address is public information; nothing else about the signer is printed, and the redactor
  // guards the paths where a key could otherwise reach a log.
  say(`kese-mcp ready · ${network} · account ${signer.value.address}`);
  say(`  policy      ${dbPath}`);
  say(`  approvals   ${approvals ? "telegram" : "not configured — every approval will be denied"}`);
  say(
    proving === "service"
      ? "  proving     service configured"
      : "  proving     NONE — payments compile and check, but cannot settle"
  );

  const shutdown = () => {
    approvals?.stop();
    void server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
}

// Only when run as a program. Importing this module from a test must not start a server on the
// test runner's stdio.
// pathToFileURL rather than string concatenation, so a path containing a space still matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Redacted and first-line-only: a stack trace from the SDK can carry constructor arguments.
    say(`FATAL: ${createRedactor()(error).split("\n")[0]}`);
    process.exit(1);
  });
}
