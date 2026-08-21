/**
 * @kese/approvals — human-in-the-loop approvals.
 *
 * `needs_approval` from the policy engine lands here: a message to the owner stating what is being
 * paid, which rule required a human, and what it does to the daily budget; then Approve/Deny; then
 * the payment resumes or is refused.
 *
 * Because caps are absolute (docs/decisions.md D-011), no approval request ever asks the owner to
 * exceed a cap — the only approvals that reach a human are ones policy already considers legitimate.
 */

export * from "./types.js";
export {
  createTelegramApprovals,
  type ApprovalPersistence,
  type TelegramApprovalOptions,
  type TelegramApprovals,
  type TelegramTransport,
  type TelegramUpdate,
} from "./channel.js";
export { createTelegramTransport } from "./telegram.js";
export { createApprovalStore } from "./store.js";

import { createTelegramApprovals, type TelegramApprovals } from "./channel.js";
import { createTelegramTransport } from "./telegram.js";
import { createApprovalStore } from "./store.js";

/**
 * Build the channel from the environment, or return null when it is not configured.
 *
 * Null is a legitimate state, not an error — but it is one the spend pipeline treats as "deny every
 * approval", never as "approve automatically". A half-configured channel (token without chat id)
 * returns null for the same reason: sending payment requests to an unknown chat would be worse
 * than not sending them.
 */
export function createApprovalsFromEnv(
  env: Record<string, string | undefined> = process.env
): TelegramApprovals | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = Number(env.TELEGRAM_OWNER_CHAT_ID?.trim());
  if (!token || !Number.isFinite(chatId) || chatId === 0) return null;

  return createTelegramApprovals({
    transport: createTelegramTransport(token),
    ownerChatId: chatId,
    timeoutMs: Number(env.APPROVAL_TIMEOUT_SECONDS ?? 900) * 1000,
    persist: createApprovalStore(env.POLICY_DB_PATH ?? "./kese-policy.sqlite"),
  });
}
