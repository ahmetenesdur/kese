/**
 * Telegram approval channel.
 *
 * This is the human-in-the-loop gate: the only thing that can authorise a payment the policy
 * engine would not allow on its own. So the tests here weigh two properties above all others:
 *
 *  1. **Only the owner can approve.** The bot token identifies the bot, not the person. Anyone who
 *     learns the bot's handle can message it, and a callback carries whatever chat it came from.
 *     Approving on the strength of "a callback arrived" would hand payment authority to a stranger.
 *  2. **Anything that is not an explicit approval is a denial.** Timeout, an unknown ticket, a
 *     duplicate callback, a transport error — all deny. Silence must never read as consent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderMessage, createTelegramApprovals, type TelegramTransport, type TelegramUpdate } from "./channel.js";
import type { ApprovalTicket } from "./types.js";

const OWNER = 1676714557;
const STRANGER = 999999;

let sent: { chatId: number; text: string }[];
let queued: TelegramUpdate[];
let answered: string[];

/** A fake Telegram. Network I/O is a genuine seam; the approval logic around it is not. */
function transport(): TelegramTransport {
  return {
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      return { messageId: sent.length };
    },
    async getUpdates() {
      const batch = queued;
      queued = [];
      return batch;
    },
    async answerCallback(id) {
      answered.push(id);
    },
    async editMessage() {},
  };
}

function ticket(overrides: Partial<ApprovalTicket> = {}): ApprovalTicket {
  return {
    id: "ticket-1",
    reservationId: "res-1",
    summary: "private_transfer of 60 STRK to 0x0b0b",
    reason: "amount exceeds the approval threshold (50)",
    remainingDailyBudget: "190 STRK",
    ...overrides,
  };
}

/** Deliver a button press from `fromId` for `ticketId`. */
function press(ticketId: string, action: "approve" | "deny", fromId = OWNER): void {
  queued.push({
    callbackQuery: { id: `cb-${ticketId}`, fromId, data: `${action}:${ticketId}` },
  });
}

beforeEach(() => {
  sent = [];
  queued = [];
  answered = [];
});

describe("only the owner can approve", () => {
  it("ignores an approval from a chat that is not the owner's", async () => {
    // The dangerous case: a stranger finds the bot and taps Approve. The bot token proves the bot,
    // not the person — the sender has to be checked explicitly.
    const approvals = createTelegramApprovals({
      transport: transport(),
      ownerChatId: OWNER,
      timeoutMs: 200,
      pollMs: 10,
    });
    const verdict = approvals.request(ticket());
    press("ticket-1", "approve", STRANGER);
    expect(await verdict).toBe("timeout"); // never approved; falls through to the timeout
    approvals.stop();
  });

  it("accepts an approval from the owner", async () => {
    const approvals = createTelegramApprovals({
      transport: transport(),
      ownerChatId: OWNER,
      timeoutMs: 1000,
      pollMs: 10,
    });
    const verdict = approvals.request(ticket());
    press("ticket-1", "approve");
    expect(await verdict).toBe("approved");
    approvals.stop();
  });
});

describe("verdicts", () => {
  it("returns denied when the owner denies", async () => {
    const approvals = createTelegramApprovals({
      transport: transport(),
      ownerChatId: OWNER,
      timeoutMs: 1000,
      pollMs: 10,
    });
    const verdict = approvals.request(ticket());
    press("ticket-1", "deny");
    expect(await verdict).toBe("denied");
    approvals.stop();
  });

  it("times out rather than waiting forever", async () => {
    const approvals = createTelegramApprovals({
      transport: transport(),
      ownerChatId: OWNER,
      timeoutMs: 50,
      pollMs: 10,
    });
    expect(await approvals.request(ticket())).toBe("timeout");
    approvals.stop();
  });

  it('reports "unreachable" — NOT "denied" — when the message never got sent', async () => {
    // The first live dry run failed exactly here and reported "the owner denied this payment".
    // The owner had seen nothing. Conflating "could not ask" with "was refused" sends the operator
    // hunting for a person who never received anything, and hides a broken integration behind a
    // plausible-looking policy outcome. Both refuse the payment; only one is true.
    const broken: TelegramTransport = {
      ...transport(),
      sendMessage: async () => {
        throw new Error("telegram unreachable");
      },
    };
    const approvals = createTelegramApprovals({
      transport: broken,
      ownerChatId: OWNER,
      timeoutMs: 5000,
      pollMs: 10,
    });
    expect(await approvals.request(ticket())).toBe("unreachable");
    approvals.stop();
  });

  it("keeps polling when a single getUpdates call fails", async () => {
    let calls = 0;
    const flaky: TelegramTransport = {
      ...transport(),
      async getUpdates() {
        if (++calls === 1) throw new Error("network blip");
        const batch = queued;
        queued = [];
        return batch;
      },
    };
    const approvals = createTelegramApprovals({
      transport: flaky,
      ownerChatId: OWNER,
      timeoutMs: 1000,
      pollMs: 10,
    });
    const verdict = approvals.request(ticket());
    setTimeout(() => press("ticket-1", "approve"), 30);
    expect(await verdict).toBe("approved");
    approvals.stop();
  });
});

describe("stale and duplicate callbacks", () => {
  it("ignores a second press on an already-resolved ticket", async () => {
    const approvals = createTelegramApprovals({
      transport: transport(),
      ownerChatId: OWNER,
      timeoutMs: 1000,
      pollMs: 10,
    });
    const verdict = approvals.request(ticket());
    press("ticket-1", "deny");
    expect(await verdict).toBe("denied");

    // A late "approve" must not resurrect a payment the owner already refused. The verdict is
    // already settled, so what is observable is that nothing further happens: no new message, and
    // the stray callback is acknowledged as closed rather than acted on.
    const messagesBefore = sent.length;
    press("ticket-1", "approve");
    await new Promise((r) => setTimeout(r, 40));
    expect(sent).toHaveLength(messagesBefore);
    expect(answered.filter((id) => id === "cb-ticket-1").length).toBeGreaterThanOrEqual(2);
    approvals.stop();
  });

  it("ignores a callback for a ticket it never issued", async () => {
    const approvals = createTelegramApprovals({
      transport: transport(),
      ownerChatId: OWNER,
      timeoutMs: 60,
      pollMs: 10,
    });
    const verdict = approvals.request(ticket());
    press("some-other-ticket", "approve");
    expect(await verdict).toBe("timeout");
    approvals.stop();
  });

  it("routes concurrent approvals to the right tickets", async () => {
    const approvals = createTelegramApprovals({
      transport: transport(),
      ownerChatId: OWNER,
      timeoutMs: 1000,
      pollMs: 10,
    });
    const first = approvals.request(ticket({ id: "t-a", reservationId: "r-a" }));
    const second = approvals.request(ticket({ id: "t-b", reservationId: "r-b" }));
    press("t-b", "approve");
    press("t-a", "deny");
    expect(await Promise.all([first, second])).toEqual(["denied", "approved"]);
    approvals.stop();
  });
});

describe("the message the owner actually sees", () => {
  it("states amount, recipient, which rule fired, and the budget impact", async () => {
    // The owner is deciding on a phone, quickly. Everything needed has to be in the message —
    // "approve?" with no context trains them to tap yes.
    const approvals = createTelegramApprovals({
      transport: transport(),
      ownerChatId: OWNER,
      timeoutMs: 30,
      pollMs: 10,
    });
    await approvals.request(ticket());
    const text = sent[0]!.text;
    expect(text).toContain("60 STRK");
    expect(text).toContain("0x0b0b");
    expect(text).toContain("approval threshold");
    expect(text).toContain("190 STRK");
    approvals.stop();
  });

  it("sends to the owner's chat and nowhere else", async () => {
    const approvals = createTelegramApprovals({
      transport: transport(),
      ownerChatId: OWNER,
      timeoutMs: 30,
      pollMs: 10,
    });
    await approvals.request(ticket());
    expect(sent.every((m) => m.chatId === OWNER)).toBe(true);
    approvals.stop();
  });
});

describe("recovery after a restart", () => {
  it("reports tickets still pending, so their reservations can be released", async () => {
    // A restart mid-approval loses the promise spend() was awaiting, but NOT the reservation it
    // holds. Without this the budget stays held until the rolling window slides past it.
    const store = new Map<string, { reservationId: string; state: string }>();
    const approvals = createTelegramApprovals({
      transport: transport(),
      ownerChatId: OWNER,
      timeoutMs: 30,
      pollMs: 10,
      persist: {
        put: async (t) => void store.set(t.id, { reservationId: t.reservationId, state: "pending" }),
        resolve: async (id, state) => {
          const row = store.get(id);
          if (row) row.state = state;
        },
        pending: async () =>
          [...store.entries()]
            .filter(([, r]) => r.state === "pending")
            .map(([id, r]) => ({ id, reservationId: r.reservationId })),
      },
    });

    const verdict = approvals.request(ticket({ id: "t-x", reservationId: "res-x" }));
    expect(await approvals.pendingReservations()).toEqual(["res-x"]);
    await verdict; // times out
    expect(await approvals.pendingReservations()).toEqual([]);
    approvals.stop();
  });
});

describe("the budget bar", () => {
  const E = 10n ** 18n;
  const ticket = (remainingAfter: bigint, cap: bigint) => ({
    id: "t-1",
    reservationId: "r-1",
    summary: "Pay 5 STRK to 0xb0b",
    reason: "over the approval threshold",
    remainingDailyBudget: "33 STRK",
    dailyBudget: { remainingAfter, cap },
  });

  it("fills in proportion to what the day has already used", () => {
    // 12 of 50 spent leaves 38; two of ten blocks.
    expect(renderMessage(ticket(38n * E, 50n * E))).toContain("▓▓░░░░░░░░");
  });

  it("shows an empty bar when nothing has been spent", () => {
    expect(renderMessage(ticket(50n * E, 50n * E))).toContain("░░░░░░░░░░");
  });

  it("shows a full bar when the budget is gone", () => {
    expect(renderMessage(ticket(0n, 50n * E))).toContain("▓▓▓▓▓▓▓▓▓▓");
  });

  it("never overflows the bar, whatever the figures say", () => {
    // Defensive: a bar longer than its own width would wrap on a phone and read as a bug.
    for (const remaining of [-5n * E, 0n, 25n * E, 60n * E]) {
      const bar = renderMessage(ticket(remaining, 50n * E)).match(/[▓░]+/)?.[0] ?? "";
      expect(bar).toHaveLength(10);
    }
  });

  it("falls back to the plain figure when there is no cap to measure against", () => {
    const message = renderMessage(ticket(1n * E, 0n));
    expect(message).toContain("33 STRK");
    expect(message).not.toMatch(/[▓░]/);
  });

  it("stays plain text — no Markdown to break on an underscore", () => {
    const message = renderMessage(ticket(38n * E, 50n * E));
    expect(message).not.toMatch(/[*_`\[]/);
  });
});
