/**
 * Building the channel from the environment.
 *
 * Null here means "no channel", which the spend pipeline treats as DENY every approval — never as
 * approve. So the cases that matter are the half-configured ones: a token with no chat id would
 * otherwise send payment requests into the void, or worse, to whatever chat answered first.
 */

import { describe, expect, it } from "vitest";
import { createApprovalsFromEnv } from "./index.js";

const TOKEN = "8123456789:AAH-not-a-real-token-value";
/** Never the default path: a unit test must not write to the operator's real policy database. */
const IN_MEMORY = { POLICY_DB_PATH: ":memory:" };

describe("createApprovalsFromEnv", () => {
  it("builds a channel when both the token and the owner chat id are present", () => {
    const channel = createApprovalsFromEnv({
      ...IN_MEMORY,
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_OWNER_CHAT_ID: "1676714557",
    });
    expect(channel).not.toBeNull();
    channel?.stop();
  });

  it("returns null when nothing is configured", () => {
    expect(createApprovalsFromEnv({})).toBeNull();
  });

  it("returns null for a token with no owner chat id", () => {
    // Half-configured is more dangerous than unconfigured: there is no safe chat to fall back to.
    expect(createApprovalsFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN })).toBeNull();
  });

  it("returns null for an owner chat id with no token", () => {
    expect(createApprovalsFromEnv({ TELEGRAM_OWNER_CHAT_ID: "1676714557" })).toBeNull();
  });

  it("returns null for a non-numeric owner chat id", () => {
    expect(
      createApprovalsFromEnv({ ...IN_MEMORY, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_OWNER_CHAT_ID: "@me" })
    ).toBeNull();
  });

  it("returns null for a zero owner chat id", () => {
    expect(
      createApprovalsFromEnv({ ...IN_MEMORY, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_OWNER_CHAT_ID: "0" })
    ).toBeNull();
  });

  it("treats whitespace as absent", () => {
    expect(
      createApprovalsFromEnv({ ...IN_MEMORY, TELEGRAM_BOT_TOKEN: "   ", TELEGRAM_OWNER_CHAT_ID: "1676714557" })
    ).toBeNull();
  });
});
