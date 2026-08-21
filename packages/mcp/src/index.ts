/**
 * Kese MCP server — stdio entry point.
 *
 * stdio because this runs locally beside the agent and holds the signing key: the wallet should not
 * be reachable over a network at all. IMPORTANT: stdout is the MCP transport, so nothing here may
 * print to it. Diagnostics go to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildWallet, createRedactor, resolveNetwork, resolveNetworkConfig, resolveSigner } from "@kese/core";
import { createPolicyEngine } from "@kese/policy";
import { createApprovalsFromEnv } from "@kese/approvals";
import { createKeseMcpServer } from "./server.js";
import { loadPolicyConfig } from "./config.js";
import { createClaimStore } from "./claims.js";

async function main(): Promise<void> {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* env may come from the process itself */
  }

  const redact = createRedactor();
  const errors: string[] = [];

  const net = resolveNetworkConfig();
  if (!net.value) errors.push(`network config incomplete: ${net.missing.join(", ")}`);

  const signer = resolveSigner();
  if (!signer.value) errors.push(`signer not configured: ${signer.missing.join(", ")}`);

  const policyConfig = loadPolicyConfig();
  if (!policyConfig.ok) errors.push(...policyConfig.errors);

  // Fail closed and loudly. A wallet server that starts without limits is worse than one that
  // does not start: the agent would find it working and spend against no policy at all.
  if (errors.length > 0 || !net.value || !signer.value || !policyConfig.ok) {
    console.error("Kese MCP server refusing to start:\n" + errors.map((e) => `  · ${e}`).join("\n"));
    process.exitCode = 1;
    return;
  }

  const { wallet } = buildWallet({
    net: net.value,
    signer: signer.value,
    mode: net.value.provingServiceUrl ? "service" : "simulate",
    redact,
  });

  if (!net.value.escrowAddress) {
    console.error(
      "WARNING: ESCROW_CONTRACT_ADDRESS is not set — kese_create_claim_link will refuse rather " +
        "than lock funds behind an escrow that does not exist."
    );
  }
  if (!process.env.CLAIM_BASE_URL?.trim()) {
    console.error(
      "WARNING: CLAIM_BASE_URL is not set — claim links have nowhere to point, so " +
        "kese_create_claim_link will refuse."
    );
  }

  if (!net.value.provingServiceUrl) {
    console.error(
      "WARNING: no proving service configured — running in SIMULATE mode. Payments are compiled " +
        "and checked but NOT submitted. See strk20-hackathon#147."
    );
  }

  const policy = createPolicyEngine({
    dbPath: process.env.POLICY_DB_PATH ?? "./kese-policy.sqlite",
  });

  const approvals = createApprovalsFromEnv();
  if (!approvals) {
    console.error(
      "WARNING: no Telegram approval channel configured (TELEGRAM_BOT_TOKEN / " +
        "TELEGRAM_OWNER_CHAT_ID). Payments above the approval threshold will be DENIED, not " +
        "auto-approved."
    );
  } else {
    // Recovery. A restart mid-approval loses the promise spend() was awaiting but NOT the
    // reservation it was holding, so that budget would stay held until the rolling window slid
    // past it — invisibly, because nothing failed. Release them before serving any tool.
    const stranded = await approvals.pendingReservations().catch(() => []);
    for (const reservationId of stranded) {
      await policy.releaseReservation(reservationId).catch(() => {
        /* already resolved by a previous run; nothing to do */
      });
    }
    if (stranded.length > 0) {
      console.error(`Released ${stranded.length} reservation(s) stranded by a previous shutdown.`);
    }
  }

  const server = createKeseMcpServer({
    policy,
    wallet,
    config: policyConfig.config,
    network: resolveNetwork(),
    approvals: approvals ?? undefined,
    claims: createClaimStore(process.env.POLICY_DB_PATH ?? "./kese-policy.sqlite"),
    claimBaseUrl: process.env.CLAIM_BASE_URL?.trim(),
    redact,
  });

  await server.connect(new StdioServerTransport());
  console.error(`kese-mcp-server ready on ${resolveNetwork()}`);
}

main().catch((error) => {
  console.error(`FATAL: ${createRedactor()(error)}`);
  process.exitCode = 1;
});
