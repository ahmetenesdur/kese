/**
 * Human-in-the-loop approvals over Telegram.
 *
 * This is the only thing that can authorise a payment the policy engine would not allow on its own,
 * which makes two properties matter more than everything else here:
 *
 * 1. **Only the owner can approve.** A bot token identifies the *bot*, not a person. Anyone who
 *    learns the bot's handle can message it, and a callback carries whatever chat it came from.
 *    Approving because "a callback arrived" hands payment authority to a stranger, so the sender is
 *    checked against the configured owner on every single update.
 * 2. **Anything that is not an explicit approval is a denial.** Timeout, unknown ticket, duplicate
 *    press, transport error — all deny (CLAUDE.md hard rule 4). Silence must never read as consent.
 *
 * One background poll loop serves every in-flight request, so concurrent approvals do not each open
 * their own long-poll against Telegram.
 */

import type { ApprovalChannel, ApprovalTicket, ApprovalVerdict } from "./types.js";

/** A Telegram callback_query, reduced to the fields that matter. */
export interface TelegramUpdate {
  callbackQuery?: {
    id: string;
    /** Who pressed the button. Compared against the owner — this is the security check. */
    fromId: number;
    /** `"approve:<ticketId>"` or `"deny:<ticketId>"`. */
    data: string;
    messageId?: number;
  };
}

/** The network seam. Everything above it is logic that deserves tests without a network. */
export interface TelegramTransport {
  sendMessage(
    chatId: number,
    text: string,
    buttons?: { text: string; data: string }[]
  ): Promise<{ messageId: number }>;
  getUpdates(offset?: number): Promise<TelegramUpdate[]>;
  answerCallback(callbackQueryId: string, text?: string): Promise<void>;
  editMessage(chatId: number, messageId: number, text: string): Promise<void>;
}

/** Ticket persistence, so a restart mid-approval does not strand a held reservation. */
export interface ApprovalPersistence {
  put(ticket: ApprovalTicket): Promise<void>;
  resolve(ticketId: string, state: ApprovalVerdict): Promise<void>;
  pending(): Promise<{ id: string; reservationId: string }[]>;
}

export interface TelegramApprovalOptions {
  transport: TelegramTransport;
  ownerChatId: number;
  /** How long the owner has before the request is treated as a denial. */
  timeoutMs: number;
  pollMs?: number;
  persist?: ApprovalPersistence;
}

export interface TelegramApprovals extends ApprovalChannel {
  /**
   * Reservations belonging to approvals that never resolved.
   *
   * A restart loses the promise `spend()` was awaiting but not the reservation it holds, so
   * something has to release them or the budget stays held until the rolling window moves.
   */
  pendingReservations(): Promise<string[]>;
  stop(): void;
}

interface Waiter {
  resolve(verdict: ApprovalVerdict): void;
  messageId?: number;
}

export function createTelegramApprovals(options: TelegramApprovalOptions): TelegramApprovals {
  const { transport, ownerChatId, timeoutMs, pollMs = 1000, persist } = options;

  const waiting = new Map<string, Waiter>();
  let offset: number | undefined;
  let stopped = false;
  let looping = false;

  async function poll(): Promise<void> {
    if (looping) return;
    looping = true;
    while (!stopped) {
      try {
        const updates = await transport.getUpdates(offset);
        for (const update of updates) await handle(update);
      } catch {
        // A failed poll is a network blip, not a verdict. Keep looping — the timeout is what
        // bounds the wait, and giving up here would silently strand every pending request.
      }
      await sleep(pollMs);
    }
    looping = false;
  }

  async function handle(update: TelegramUpdate): Promise<void> {
    const callback = update.callbackQuery;
    if (!callback) return;

    // THE security check. Everything else here is bookkeeping; this is the part that decides
    // whether a stranger can spend the owner's money.
    if (callback.fromId !== ownerChatId) {
      await transport
        .answerCallback(callback.id, "Not authorised.")
        .catch(() => {});
      return;
    }

    const [action, ticketId] = callback.data.split(":");
    if (!ticketId || (action !== "approve" && action !== "deny")) return;

    const waiter = waiting.get(ticketId);
    if (!waiter) {
      // Unknown or already-resolved ticket. A late "approve" must never resurrect a payment the
      // owner already refused, or one that timed out and released its reservation.
      await transport
        .answerCallback(callback.id, "That request is no longer open.")
        .catch(() => {});
      return;
    }

    const verdict: ApprovalVerdict = action === "approve" ? "approved" : "denied";
    waiting.delete(ticketId);
    await persist?.resolve(ticketId, verdict).catch(() => {});
    await transport.answerCallback(callback.id, verdict === "approved" ? "Approved" : "Denied").catch(() => {});
    if (waiter.messageId !== undefined) {
      await transport
        .editMessage(ownerChatId, waiter.messageId, `${verdict === "approved" ? "✅ Approved" : "🚫 Denied"} — ${ticketId}`)
        .catch(() => {});
    }
    waiter.resolve(verdict);
  }

  return {
    async request(ticket: ApprovalTicket): Promise<ApprovalVerdict> {
      await persist?.put(ticket).catch(() => {});

      let messageId: number | undefined;
      try {
        const sent = await transport.sendMessage(ownerChatId, renderMessage(ticket), [
          { text: "✅ Approve", data: `approve:${ticket.id}` },
          { text: "🚫 Deny", data: `deny:${ticket.id}` },
        ]);
        messageId = sent.messageId;
      } catch {
        // The owner never saw the request. Waiting out the timeout would be correct and useless —
        // but this is NOT a denial, and saying so would be a lie about who refused.
        await persist?.resolve(ticket.id, "unreachable").catch(() => {});
        return "unreachable";
      }

      void poll();

      return new Promise<ApprovalVerdict>((resolve) => {
        const timer = setTimeout(() => {
          if (!waiting.has(ticket.id)) return;
          waiting.delete(ticket.id);
          void persist?.resolve(ticket.id, "timeout").catch(() => {});
          resolve("timeout");
        }, timeoutMs);

        waiting.set(ticket.id, {
          messageId,
          resolve: (verdict) => {
            clearTimeout(timer);
            resolve(verdict);
          },
        });
      });
    },

    async pendingReservations(): Promise<string[]> {
      if (persist) return (await persist.pending()).map((t) => t.reservationId);
      return [...waiting.keys()].map((id) => id);
    },

    stop(): void {
      stopped = true;
    },
  };
}

/**
 * The message the owner actually reads, on a phone, quickly.
 *
 * Everything needed to decide has to be here: an "Approve this payment?" with no context trains the
 * owner to tap yes, which defeats the entire mechanism.
 */
/**
 * How much of today is gone, as ten blocks.
 *
 * The remaining figure already appears as a number; this is the same fact in the form the website
 * uses, because "how close am I to the limit" is what someone approving on a phone is weighing and
 * a bar answers it without arithmetic. Block characters only — the message is sent as plain text,
 * deliberately (Markdown broke on the underscore in `private_transfer`), so there is no formatting
 * to lean on.
 */
function budgetBar(spent: bigint, cap: bigint, width = 10): string {
  if (cap <= 0n) return "";
  const clamped = spent < 0n ? 0n : spent > cap ? cap : spent;
  // Integer arithmetic throughout: these are wei-scale bigints, and going through Number to draw
  // ten characters would be a rounding error in the one place that must not drift.
  const filled = Number((clamped * BigInt(width)) / cap);
  return "\u2593".repeat(filled) + "\u2591".repeat(width - filled);
}

export function renderMessage(ticket: ApprovalTicket): string {
  const lines = [
    // A purse, which is what "kese" means — the same thing the mark draws.
    "\uD83D\uDC5B Kese — approval needed",
    "",
    ticket.summary,
    "",
    `Why: ${ticket.reason}`,
  ];

  if (ticket.dailyBudget && ticket.remainingDailyBudget) {
    const { remainingAfter, cap } = ticket.dailyBudget;
    const bar = budgetBar(cap - remainingAfter, cap);
    lines.push(bar ? `Today: ${bar} ${ticket.remainingDailyBudget} left` : `Today: ${ticket.remainingDailyBudget} left`);
  } else if (ticket.remainingDailyBudget) {
    lines.push(`Daily budget left after this: ${ticket.remainingDailyBudget}`);
  }

  lines.push("", `Request: ${ticket.id}`, "No response is treated as a denial.");
  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
