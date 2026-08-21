/**
 * Telegram approval dry run.
 *
 * Sends ONE real approval request to the owner's Telegram and waits for the button press. This is
 * the whole human-in-the-loop path end to end: policy decides a human is needed → a ticket goes out
 * → Approve/Deny comes back → the payment resumes or is refused.
 *
 * SAFE BY CONSTRUCTION — nothing can move funds, whatever you press:
 *   · the wallet here is a stub that always reports `simulated`, so no transaction is ever built;
 *   · it runs against a throwaway in-memory policy database, not your real one;
 *   · it never touches the chain, and needs no proving service.
 *
 * The only real thing is the Telegram message.
 *
 * Usage:  pnpm telegram:dry-run            # asks for 60 STRK, threshold is 50
 *         pnpm telegram:dry-run -- --amount=5     # under the threshold: should NOT ask at all
 */

import { createApprovalsFromEnv } from "../packages/approvals/src/index.js";
import { createRedactor, type KeseWallet } from "../packages/core/src/index.js";
import { createPolicyEngine, type PolicyConfig } from "../packages/policy/src/index.js";
import { spend } from "../packages/mcp/src/spend.js";
import { envSearchPath, loadDotEnv } from "../packages/core/src/env.js";

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ONE = 10n ** 18n;

/** Always "simulated": the dry run must not be able to move money even if you approve. */
const stubWallet = {
  register: async () => ({ status: "simulated" as const }),
  shield: async () => ({ status: "simulated" as const }),
  payPrivate: async () => ({ status: "simulated" as const }),
  withdraw: async () => ({ status: "simulated" as const }),
  balances: async () => ({ [STRK]: 1000n * ONE }),
} as unknown as KeseWallet;

function arg(name: string, fallback: string): string {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

async function main(): Promise<void> {
  // Climb to the .env instead of assuming the cwd holds it. These are run from the repo root
  // today, so this changes nothing now — it stops the same trap that cost an hour in the MCP
  // server and the dashboard from being re-set here later (D-041).
  loadDotEnv({ from: envSearchPath(import.meta.url) });

  const approvals = createApprovalsFromEnv({ ...process.env, POLICY_DB_PATH: ":memory:" });
  if (!approvals) {
    console.error(
      "✗ Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID in .env.\n" +
        "  (Half-configured counts as unconfigured — there is no safe chat to fall back to.)"
    );
    process.exitCode = 1;
    return;
  }

  const amount = arg("amount", "60");
  const recipient = arg("recipient", "0x0b0b");

  // Threshold 50, cap 100: 60 needs a human, 5 does not, 150 is refused outright.
  const config: PolicyConfig = {
    perTxCap: { [STRK]: 100n * ONE },
    dailyCap: { [STRK]: 500n * ONE },
    allowlist: "any",
    approvalThreshold: { [STRK]: 50n * ONE },
    claimLinkDefaultExpiryBlocks: 1000,
  };

  console.log(`\nDry run: paying ${amount} STRK to ${recipient}`);
  console.log(`Policy:  approval needed above 50 STRK · absolute cap 100 STRK`);
  console.log(
    Number(amount) > 100
      ? "\n→ Above the cap. Expect an outright refusal, and NO Telegram message —\n" +
          "  caps cannot be approved past, so the owner is never asked.\n"
      : Number(amount) > 50
        ? "\n→ Above the threshold. Check your phone: a message with Approve / Deny is on its way.\n" +
            "  No response within the timeout counts as a denial.\n"
        : "\n→ Below the threshold. Expect it to pass with NO Telegram message.\n"
  );

  const started = Date.now();
  const outcome = await spend(
    {
      idempotencyKey: `dry-run-${started}`,
      agentId: "telegram-dry-run",
      kind: "private_transfer",
      token: STRK,
      amount: BigInt(Math.round(Number(amount) * 1e6)) * 10n ** 12n,
      recipient,
    },
    {
      policy: createPolicyEngine({ dbPath: ":memory:" }),
      wallet: stubWallet,
      config,
      approvals,
      redact: createRedactor(),
    }
  );

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nOutcome after ${seconds}s:\n`);
  console.log(`  status: ${outcome.status}`);
  if ("code" in outcome) console.log(`  code:   ${outcome.code}`);
  if ("reason" in outcome) console.log(`  reason: ${outcome.reason}`);

  console.log(
    outcome.status === "simulated"
      ? "\n✅ The approval path works. Nothing moved — the wallet in this script is a stub.\n"
      : outcome.status === "denied"
        ? "\n✅ Refused, as intended. Nothing moved.\n"
        : `\n⚠️  Unexpected status "${outcome.status}" — worth a look.\n`
  );

  approvals.stop();
}

main().catch((error) => {
  console.error(`FATAL: ${createRedactor()(error)}`);
  process.exitCode = 1;
});
