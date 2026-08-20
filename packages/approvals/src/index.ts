/**
 * Telegram approval channel. Ticket -> message with context (agent, amount, token, recipient,
 * balance impact, which rule fired) -> inline Approve/Deny -> resolve promise. Timeout => deny (fail closed).
 * TODO(claude-code): grammy or node-telegram-bot-api; persist tickets in SQLite; web fallback page optional.
 */
export interface ApprovalChannel {
  request(ticket: { id: string; summary: string; expiresAt: number }): Promise<"approved" | "denied" | "timeout">;
}
