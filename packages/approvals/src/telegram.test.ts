/**
 * Telegram transport.
 *
 * One lesson drives these tests. The first live dry run failed with
 * `can't parse entities: Can't find end of the entity starting at byte offset 40` — byte 40 was the
 * underscore in `private_transfer`. Telegram's legacy Markdown reads `_` as italic, finds no closing
 * one, and rejects the WHOLE message. The owner saw nothing, and the payment was refused for a
 * reason that had nothing to do with them.
 *
 * The content of an approval message is data we do not control: addresses, amounts, action names.
 * Formatting that can break on that data is not worth the bold text.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createTelegramTransport } from "./telegram.js";

const TOKEN = "123:fake";
let bodies: Record<string, unknown>[];

beforeEach(() => {
  bodies = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("sendMessage", () => {
  it("sends plain text — no parse mode that could reject the message", async () => {
    await createTelegramTransport(TOKEN).sendMessage(1, "private_transfer of 5 to 0x0b0b");
    expect(bodies[0]!.parse_mode).toBeUndefined();
  });

  it("delivers text containing underscores and asterisks untouched", async () => {
    // The exact shape that broke the first live run.
    const text = "private_transfer of 60 STRK *now* to 0x0b0b_test";
    await createTelegramTransport(TOKEN).sendMessage(1, text);
    expect(bodies[0]!.text).toBe(text);
  });

  it("attaches the approve/deny buttons as an inline keyboard", async () => {
    await createTelegramTransport(TOKEN).sendMessage(1, "hi", [
      { text: "OK", data: "approve:t1" },
    ]);
    expect(bodies[0]!.reply_markup).toEqual({
      inline_keyboard: [[{ text: "OK", callback_data: "approve:t1" }]],
    });
  });

  it("raises the API's own description when Telegram rejects the call", async () => {
    vi.stubGlobal("fetch", async () => ({
      json: async () => ({ ok: false, description: "Bad Request: chat not found" }),
    }));
    await expect(createTelegramTransport(TOKEN).sendMessage(1, "hi")).rejects.toThrow(
      /chat not found/
    );
  });

  it("does not echo the request body in the error — it carries the chat id and payment text", async () => {
    vi.stubGlobal("fetch", async () => ({
      json: async () => ({ ok: false, description: "Forbidden" }),
    }));
    await expect(
      createTelegramTransport(TOKEN).sendMessage(1, "pay 60 STRK to 0xsecret-counterparty")
    ).rejects.toThrow(/^(?!.*0xsecret-counterparty).*$/s);
  });
});
