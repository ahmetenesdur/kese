/**
 * Telegram Bot API over plain fetch.
 *
 * No client library: the surface Kese needs is four calls, Node 24 ships `fetch`, and this project
 * is already carrying one dependency workaround (the vendored SDK). Fewer moving parts in the path
 * that authorises payments is worth more than the convenience.
 *
 * The bot token appears only in the request URL. It must never reach a log — `createRedactor` in
 * @kese/core covers it, and nothing here prints.
 */

import type { TelegramTransport, TelegramUpdate } from "./channel.js";

/** Long-poll window. Telegram holds the connection open, so this is not a busy loop. */
const LONG_POLL_SECONDS = 25;

export function createTelegramTransport(botToken: string): TelegramTransport {
  const base = `https://api.telegram.org/bot${botToken}`;
  // Telegram's cursor: acknowledging update N by asking for N+1 is what stops it replaying.
  // Tracked here rather than by the caller, because it is a protocol detail, not approval logic.
  let offset: number | undefined;

  async function call<T>(method: string, body: unknown): Promise<T> {
    const response = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!payload.ok) {
      // Deliberately does not echo the request body — it carries the chat id and the payment text.
      throw new Error(`telegram ${method} failed: ${payload.description ?? response.status}`);
    }
    return payload.result as T;
  }

  return {
    async sendMessage(chatId, text, buttons) {
      const result = await call<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        // NO parse_mode, deliberately. Telegram's legacy Markdown reads `_` as italic, and an
        // approval message carries data we do not control — `private_transfer`, addresses, amounts.
        // The first live dry run died on exactly that: "can't parse entities" at the underscore in
        // `private_transfer`, so the owner saw nothing and the payment was refused for a reason
        // that had nothing to do with them. Bold text is not worth a broken approval.
        text,
        reply_markup: buttons
          ? { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] }
          : undefined,
      });
      return { messageId: result.message_id };
    },

    async getUpdates(): Promise<TelegramUpdate[]> {
      const updates = await call<
        {
          update_id: number;
          callback_query?: {
            id: string;
            from: { id: number };
            data?: string;
            message?: { message_id: number };
          };
        }[]
      >("getUpdates", {
        offset,
        timeout: LONG_POLL_SECONDS,
        // Only callback queries matter. Asking for everything would pull in message text the
        // server has no reason to see.
        allowed_updates: ["callback_query"],
      });

      if (updates.length > 0) {
        offset = Math.max(...updates.map((u) => u.update_id)) + 1;
      }

      return updates
        .filter((u) => u.callback_query?.data)
        .map((u) => ({
          callbackQuery: {
            id: u.callback_query!.id,
            fromId: u.callback_query!.from.id,
            data: u.callback_query!.data!,
            messageId: u.callback_query!.message?.message_id,
          },
        }));
    },

    async answerCallback(callbackQueryId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
    },

    async editMessage(chatId, messageId, text) {
      await call("editMessageText", { chat_id: chatId, message_id: messageId, text });
    },
  };
}
