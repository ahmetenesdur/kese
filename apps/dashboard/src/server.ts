/**
 * Owner dashboard — a small local server.
 *
 * Not a static page, and that is the whole architecture: reading shielded balances needs the
 * viewing key, and the viewing key never leaves the server (CLAUDE.md hard rule 1). The browser
 * gets numbers, never keys.
 *
 * It binds to LOOPBACK only. This page shows an owner their private balances and full payment
 * history; there is no authentication because there is no network path to it. If it is ever
 * exposed beyond localhost, that has to change first — hence the explicit host rather than a
 * default that quietly listens everywhere.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RpcProvider } from "starknet";
import {
  buildWallet,
  createRedactor,
  envSearchPath,
  loadDotEnv,
  readShields,
  resolveStatePath,
  resolveNetwork,
  resolveNetworkConfig,
  resolveSigner,
} from "@kese/core";
import { createPolicyEngine } from "@kese/policy";
import { loadPolicyConfig } from "@kese/mcp";
import { buildSummary, mergeActivity } from "./summary.js";
import { toCsv } from "./report.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.DASHBOARD_PORT ?? 5184);
/** How far back to scan for our own shields. ~2 days of Sepolia blocks. */
const LOOKBACK_BLOCKS = Number(process.env.DASHBOARD_LOOKBACK_BLOCKS ?? 200_000);

const page = readFileSync(
  fileURLToPath(new URL("../public/index.html", import.meta.url)),
  "utf8"
);

function json(body: unknown, status = 200) {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  };
}

async function main(): Promise<void> {
  // Climb to the .env rather than assuming the cwd holds it: `pnpm --filter @kese/dashboard dev`
  // runs from apps/dashboard/, where there is none, and the resulting "missing configuration"
  // error blames the operator for a lookup failure.
  const env = loadDotEnv({ from: envSearchPath(import.meta.url) });

  const redact = createRedactor();
  const net = resolveNetworkConfig();
  const signer = resolveSigner();
  const policyConfig = loadPolicyConfig();

  const problems = [
    ...net.missing,
    ...signer.missing,
    ...(policyConfig.ok ? [] : policyConfig.errors),
  ];
  if (!net.value || !signer.value || !policyConfig.ok) {
    console.error("Dashboard cannot start:\n" + problems.map((p) => `  · ${p}`).join("\n"));
    process.exitCode = 1;
    return;
  }

  const network = resolveNetwork();
  // Same rule as the MCP server, from the same place: a relative path opened from a different
  // directory is not an error, it is an empty database — which renders as an agent that has never
  // spent anything.
  const policy = createPolicyEngine({
    dbPath: resolveStatePath({ configured: process.env.POLICY_DB_PATH, envPath: env.path }),
  });
  const { wallet } = buildWallet({
    net: net.value,
    signer: signer.value,
    mode: net.value.provingServiceUrl ? "service" : "simulate",
    redact,
  });
  const provider = new RpcProvider({ nodeUrl: net.value.rpcUrl });

  const tokens = Object.keys(policyConfig.config.perTxCap);

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${HOST}`);

        if (url.pathname === "/api/summary") {
          const [balances, ...remaining] = await Promise.all([
            wallet.balances(tokens),
            ...tokens.map((t) => policy.remainingDaily(t, policyConfig.config)),
          ]);
          const remainingDaily = Object.fromEntries(
            tokens.map((t, i) => [t, remaining[i] ?? 0n])
          );
          const out = json({
            ...buildSummary({ network, balances, remainingDaily, config: policyConfig.config }),
            // Surfaced so the page can say plainly that nothing is settling yet, rather than
            // showing an empty history that looks like an idle agent.
            proving: net.value!.provingServiceUrl ? "live" : "simulate",
            account: signer.value!.address,
          });
          res.writeHead(out.status, out.headers).end(out.body);
          return;
        }

        if (url.pathname === "/report.csv") {
          const decisions = await policy.recentDecisions(1000);
          const csv = toCsv(
            mergeActivity({ decisions, shields: [], network }).map((e) => ({
              at: new Date(e.at).toISOString(),
              source: e.source,
              kind: e.kind,
              amount: e.amount,
              symbol: e.symbol,
              counterparty: e.counterparty,
              outcome: e.outcome,
              reason: e.reason,
              visibility: e.visibility,
              memo: e.memo,
              reference: e.reference,
            }))
          );
          res
            .writeHead(200, {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": `attachment; filename="kese-spend-${network}.csv"`,
            })
            .end(csv);
          return;
        }

        if (url.pathname === "/api/activity") {
          const head = await provider.getBlockNumber();
          const [decisions, shields] = await Promise.all([
            policy.recentDecisions(50),
            readShields(
              provider as never,
              {
                poolAddress: net.value!.poolAddress,
                userAddress: signer.value!.address,
                fromBlock: Math.max(0, head - LOOKBACK_BLOCKS),
              },
              { chunkSize: 100, maxPages: 5 }
            ).catch(() => []),
          ]);
          const out = json({ entries: mergeActivity({ decisions, shields, network }) });
          res.writeHead(out.status, out.headers).end(out.body);
          return;
        }

        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
      } catch (error) {
        // Redacted: this response is rendered in a browser and may be screenshotted for a demo.
        const out = json({ error: redact(error).split("\n")[0] }, 500);
        res.writeHead(out.status, out.headers).end(out.body);
      }
    })();
  });

  server.listen(PORT, HOST, () => {
    console.log(`Kese dashboard → http://${HOST}:${PORT}  (${network})`);
    if (!net.value!.provingServiceUrl) {
      console.log("  simulate mode: balances are real, but no payment can settle yet (#147)");
    }
  });
}

main().catch((error) => {
  console.error(`FATAL: ${createRedactor()(error)}`.split("\n")[0]);
  process.exitCode = 1;
});
